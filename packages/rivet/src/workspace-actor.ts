import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { Action, Actor, State } from "@rivetkit/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, Semaphore } from "effect"
import { Backends } from "./backends.ts"
import { open } from "./sandbox-environment.ts"
import { Workload } from "./workload.ts"
import { Backend, Environment, StateSchema } from "./workspace-schema.ts"

const maximumCommandTimeoutMs = 600_000
const maximumDirectRunTimeoutMs = 50_000
const maximumFilesystemPayloadBytes = 1_048_576

export class Error extends Schema.TaggedErrorClass<Error>()("Rivet.WorkspaceActorError", {
  operation: Schema.String,
  reason: Schema.Literals(["not_initialized", "stopped", "stale_generation", "storage_missing", "environment_failed", "unknown_command", "command_conflict", "unsupported", "capacity"]),
  message: Schema.String,
  filesystemCode: Schema.optional(Schema.String),
}) {}

export const Initialize = Action.make("Initialize", {
  payload: { provider: Backend, root: Schema.optional(Schema.String) },
  success: Environment,
  error: Error,
})

const CommandPayload = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  timeoutMs: Schema.Number,
  maxOutputBytes: Schema.Number,
})

const CommandResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  outcome: Schema.Literal("exited"),
  stdout: Schema.String,
  stderr: Schema.String,
  output: Schema.String,
  truncated: Schema.Boolean,
})

export const Run = Action.make("Run", {
  payload: Schema.Struct({ ...CommandPayload.fields, generation: Schema.Number }),
  success: CommandResult,
  error: Error,
})

export const StartCommand = Action.make("StartCommand", {
  payload: { id: Schema.String, epoch: Schema.String, command: CommandPayload },
  success: Schema.Struct({ id: Schema.String }),
  error: Error,
})

export const CommandStatus = Action.make("CommandStatus", {
  payload: { id: Schema.String, epoch: Schema.String },
  success: Schema.Union([
    Schema.Struct({ status: Schema.Literal("running") }),
    Schema.Struct({ status: Schema.Literal("completed"), result: CommandResult }),
    Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
    Schema.Struct({ status: Schema.Literal("cancelled") }),
  ]),
  error: Error,
})

export const CancelCommand = Action.make("CancelCommand", {
  payload: { id: Schema.String, epoch: Schema.String },
  success: Schema.Union([
    Schema.Struct({ status: Schema.Literal("cancelled") }),
    Schema.Struct({ status: Schema.Literal("completed"), result: CommandResult }),
    Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
  ]),
  error: Error,
})

export const CommandEpoch = Action.make("CommandEpoch", {
  payload: { generation: Schema.optional(Schema.Number) },
  success: Schema.String,
  error: Error,
})

const FilesystemRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("read"), path: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("write"),
    path: Schema.String,
    data: Schema.String,
    flag: Schema.optional(Schema.Literals(["w", "wx"])),
    mode: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("stat"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("mkdir"), path: Schema.String, recursive: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("readdir"), path: Schema.String, recursive: Schema.Boolean, entries: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("exists"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("remove"), path: Schema.String, recursive: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("move"), from: Schema.String, to: Schema.String }),
  Schema.Struct({ type: Schema.Literal("realpath"), path: Schema.String }),
])

const FilesystemRecursiveEntry = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
  size: Schema.Number,
})

const FilesystemDirectoryEntry = Schema.Struct({
  name: Schema.String,
  isDirectory: Schema.Boolean,
  isSymbolicLink: Schema.Boolean,
})

const FilesystemResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("read"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("void") }),
  Schema.Struct({ type: Schema.Literal("exists"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("path"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("names"), names: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("directoryEntries"), entries: Schema.Array(FilesystemDirectoryEntry) }),
  Schema.Struct({ type: Schema.Literal("recursiveEntries"), entries: Schema.Array(FilesystemRecursiveEntry) }),
  Schema.Struct({
    type: Schema.Literal("stat"),
    stat: Schema.Struct({
      isDirectory: Schema.Boolean,
      isSymbolicLink: Schema.Boolean,
      mtimeMs: Schema.Number,
      atimeMs: Schema.Number,
      ctimeMs: Schema.Number,
      birthtimeMs: Schema.Number,
      dev: Schema.Number,
      ino: Schema.Number,
      mode: Schema.Number,
      nlink: Schema.Number,
      uid: Schema.Number,
      gid: Schema.Number,
      rdev: Schema.Number,
      size: Schema.Number,
      blocks: Schema.Number,
    }),
  }),
])

type FilesystemResponse = typeof FilesystemResponse.Type

export const Filesystem = Action.make("Filesystem", {
  payload: Schema.Struct({ generation: Schema.Number, request: FilesystemRequest }),
  success: FilesystemResponse,
  error: Error,
})

export const Stop = Action.make("Stop", {
  success: Environment,
  error: Error,
})

export const GetEnvironment = Action.make("GetEnvironment", {
  success: Environment,
  error: Error,
})

export const WorkspaceActor = Actor.make("OpenCodeWorkspace", {
  actions: [Initialize, Run, CommandEpoch, StartCommand, CommandStatus, CancelCommand, Filesystem, Stop, GetEnvironment],
})

export interface Options {
  readonly storageDirectory: string
}

export function layer(options: Options) {
  const storageDirectory = resolve(options.storageDirectory)
  return WorkspaceActor.toLayer(
    ({ rawRivetkitContext, state }) =>
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1)
        const vmLock = yield* Semaphore.make(1)
        const ioLock = yield* Semaphore.make(1)
        const storageIdentity = createHash("sha256").update(JSON.stringify(rawRivetkitContext.key)).digest("hex")
        const wakeScope = yield* Scope.Scope
        type BackendHandle = { workload: Workload.Interface; value: ReturnType<typeof open> }
        const environment = { handle: undefined as BackendHandle | undefined }
        const durable = { current: true }
        type Result = typeof CommandResult.Type
        type Entry =
          | { readonly identity: string; status: "running"; fiber: Fiber.Fiber<void, never> }
          | { readonly identity: string; status: "completed"; result: Result }
          | { readonly identity: string; status: "failed"; message: string }
          | { readonly identity: string; status: "cancelled" }
        const commands = new Map<string, Entry>()
        const epoch = randomUUID()
        const maximumCommandRecords = 1024
        const admission = { open: true }

        const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const gate = Promise.withResolvers<void>()
              return { gate, awake: rawRivetkitContext.keepAwake(gate.promise) }
            }),
            () => effect,
            ({ gate, awake }) =>
              Effect.sync(() => gate.resolve()).pipe(Effect.andThen(Effect.promise(() => awake))),
          )

        const fail = (operation: string, reason: Error["reason"], message: string) =>
          Effect.fail(new Error({ operation, reason, message }))

        const save = (operation: string) =>
          Effect.tryPromise(() => rawRivetkitContext.saveState({ immediate: true })).pipe(
            Effect.mapError(
              (cause) =>
                new Error({
                  operation,
                  reason: "environment_failed",
                  message: String(cause),
                }),
            ),
          )

        const getState = (operation: string) =>
          State.get(state).pipe(
            Effect.orDie,
            Effect.flatMap((value) => {
              if (!value.initialized) return fail(operation, "not_initialized", "Workspace is not initialized")
              if (!durable.current) return fail(operation, "environment_failed", "Workspace state is not durably committed")
              if (value.storageIdentity !== storageIdentity) {
                return fail(operation, "storage_missing", "Initialized workspace storage is missing")
              }
              const missing = Backends.validate(value.backend, {
                sandboxId: value.sandboxID,
                boundaryToken: value.boundaryToken,
                root: value.root,
              })
              if (missing) return fail(operation, "storage_missing", `Initialized workspace identity is missing: ${missing}`)
              return Effect.succeed(value)
            }),
          )

        const openSandbox = (workload: Workload.Interface): BackendHandle => ({ workload, value: open(workload) })

        const installHandle = (workload: Workload.Interface) =>
          Effect.gen(function* () {
            const opened = openSandbox(workload)
            environment.handle = opened
            yield* Scope.addFinalizer(wakeScope, Effect.suspend(() =>
              environment.handle === opened
                ? Effect.tryPromise(() => opened.workload.pause()).pipe(Effect.orDie)
                : Effect.void,
            ))
            return opened
          })

        const acquireWorkload = (operation: string, provider: typeof Backend.Type, current: typeof StateSchema.Type): Effect.Effect<Workload.Interface, Error> =>
          Effect.gen(function* () {
            if (current.initialized) {
              if (current.backend !== provider)
                return yield* fail(operation, "environment_failed", `Workspace uses the ${current.backend} backend`)
              if (!current.sandboxID) return yield* fail(operation, "storage_missing", `Initialized ${provider} workspace identity is missing`)
              const sandboxId = current.sandboxID
              return yield* Effect.tryPromise({
                try: () => Backends.reconnect(provider, { sandboxId, boundaryToken: current.boundaryToken, root: current.root }),
                catch: (cause) => new Error({ operation: "workload_reconnect", reason: "environment_failed", message: String(cause) }),
              })
            }
            return yield* Effect.tryPromise({
              try: () => Backends.create(provider, { root: current.root }),
              catch: (cause) => new Error({ operation: "workload_create", reason: "environment_failed", message: String(cause) }),
            })
          })

        const connectSandbox = () =>
          Effect.gen(function* () {
            if (!admission.open) return yield* fail("environment", "stopped", "Workspace is stopped")
            if (environment.handle) return environment.handle
            const current = yield* State.get(state).pipe(Effect.orDie)
            if (!current.initialized) return yield* fail("environment", "not_initialized", "Workspace is not initialized")
            const workload = yield* acquireWorkload("environment", current.backend, current)
            return yield* installHandle(workload)
          }).pipe(vmLock.withPermits(1))
        const getVM = connectSandbox()

        const validateCommand = (operation: string, payload: typeof CommandPayload.Type, maximumTimeoutMs = maximumCommandTimeoutMs) => {
          if (!Number.isSafeInteger(payload.timeoutMs) || payload.timeoutMs <= 0 || payload.timeoutMs > maximumTimeoutMs) {
            return fail(operation, "environment_failed", `timeoutMs must be between 1 and ${maximumTimeoutMs}`)
          }
          if (!Number.isSafeInteger(payload.maxOutputBytes) || payload.maxOutputBytes < 0 || payload.maxOutputBytes > 1_048_576) {
            return fail(operation, "environment_failed", "maxOutputBytes must be between 0 and 1048576")
          }
          return Effect.void
        }

        const runCommand = (payload: typeof CommandPayload.Type, generation: number) =>
          Effect.gen(function* () {
            const current = yield* getState("run")
            if (!admission.open || current.lifecycle !== "running") return yield* fail("run", "stopped", "Workspace is not accepting work")
            if (current.generation !== generation) return yield* fail("run", "stale_generation", "Workspace generation is stale")
            const vm = yield* getVM
            const result = yield* vm.value.run(payload).pipe(
              Effect.mapError((cause) => new Error({ operation: cause.operation, reason: "environment_failed", message: String(cause.cause) })),
            )
            return {
              exitCode: result.exitCode ?? null,
              outcome: result.outcome,
              stdout: result.stdout.toString(),
              stderr: result.stderr.toString(),
              output: result.output.toString(),
              truncated: result.truncated,
            }
          }).pipe(ioLock.withPermits(1))

        const persist = (value: typeof StateSchema.Type, operation: string) =>
          Effect.sync(() => { durable.current = false }).pipe(
            Effect.andThen(State.set(state, value)),
            Effect.orDie,
            Effect.andThen(save(operation)),
            Effect.tap(() => Effect.sync(() => { durable.current = true })),
          )

        const handlers = WorkspaceActor.of({
          Initialize: ({ payload }) =>
            tracked(
              Effect.gen(function* () {
                const value = yield* Effect.gen(function* () {
                  const current = yield* State.get(state).pipe(Effect.orDie)
                  if (current.initialized) {
                    if (current.storageIdentity !== storageIdentity) {
                      return yield* fail("initialize", "storage_missing", "Initialized workspace storage is missing")
                    }
                    if (current.lifecycle === "stopped") return yield* fail("initialize", "stopped", "Workspace is stopped")
                    if (!durable.current) {
                      yield* save("initialize")
                      durable.current = true
                    }
                    return current
                  }
                  const workload = yield* acquireWorkload("initialize", payload.provider, { ...current, root: payload.root })
                  const initialized = {
                    initialized: true,
                    backend: payload.provider,
                    generation: 1,
                    lifecycle: "running" as const,
                    storageIdentity,
                    sandboxID: workload.sandboxId,
                    boundaryToken: workload.boundaryToken,
                    root: payload.root ?? workload.root,
                  }
                  yield* installHandle(workload)
                  yield* persist(initialized, "initialize")
                  return initialized
                }).pipe(lock.withPermits(1))
                yield* getVM
                return value
              }),
            ),
          Run: ({ payload }) =>
            tracked(
              Effect.gen(function* () {
                const current = yield* getState("run")
                if (current.lifecycle !== "running") return yield* fail("run", "stopped", "Workspace is not accepting work")
                if (payload.generation !== current.generation) return yield* fail("run", "stale_generation", "Workspace generation is stale")
                yield* validateCommand("run", payload, maximumDirectRunTimeoutMs)
                return yield* runCommand(payload, payload.generation)
              }),
            ),
          CommandEpoch: ({ payload }) =>
            getState("command_epoch").pipe(
              Effect.flatMap((current) =>
                payload.generation === undefined || payload.generation === current.generation
                  ? Effect.succeed(`${current.generation}:${epoch}`)
                  : fail("command_epoch", "stale_generation", "Workspace generation is stale"),
              ),
            ),
          StartCommand: ({ payload }) =>
            Effect.gen(function* () {
              const current = yield* getState("start_command")
              if (payload.epoch !== `${current.generation}:${epoch}`) return yield* fail("start_command", "unknown_command", "Command belongs to a previous actor wake or generation")
              if (current.lifecycle !== "running" || !admission.open) return yield* fail("start_command", "stopped", "Workspace is stopped")
              yield* validateCommand("start_command", payload.command)
              yield* getVM
              return yield* Effect.gen(function* () {
                if (!admission.open) return yield* fail("start_command", "stopped", "Workspace is stopped")
                const identity = createHash("sha256").update(JSON.stringify(payload.command)).digest("hex")
                const existing = commands.get(payload.id)
                if (existing) {
                  if (existing.identity === identity) return { id: payload.id }
                  return yield* fail("start_command", "command_conflict", "Command ID was already used with a different command")
                }
                if (commands.size >= maximumCommandRecords) return yield* fail("start_command", "capacity", "Command record capacity reached")
                const admitted = yield* Deferred.make<void>()
                const fiber = yield* Effect.uninterruptibleMask((restore) =>
                  restore(Deferred.await(admitted).pipe(Effect.andThen(tracked(runCommand(payload.command, current.generation))))).pipe(
                    Effect.exit,
                    Effect.flatMap((exit) =>
                      // The interrupt from CancelCommand happens outside the lock, so taking it here cannot deadlock.
                      lock.withPermits(1)(
                        Effect.sync(() => {
                          const active = commands.get(payload.id)
                          if (!active || active.status !== "running") return
                          commands.set(payload.id, Exit.isSuccess(exit)
                            ? { identity, status: "completed", result: exit.value }
                            : Cause.hasInterruptsOnly(exit.cause)
                              ? { identity, status: "cancelled" }
                              : { identity, status: "failed", message: Cause.pretty(exit.cause) })
                        }),
                      ),
                    ),
                  ),
                ).pipe(
                  Effect.forkIn(wakeScope, { startImmediately: true }),
                )
                commands.set(payload.id, { identity, status: "running", fiber })
                yield* Deferred.succeed(admitted, undefined)
                return { id: payload.id }
              }).pipe(lock.withPermits(1), Effect.uninterruptible)
            }),
          CommandStatus: ({ payload }) =>
            Effect.gen(function* () {
              const current = yield* getState("command_status")
              if (payload.epoch !== `${current.generation}:${epoch}`) return yield* fail("command_status", "unknown_command", "Command belongs to a previous actor wake or generation")
              const entry = commands.get(payload.id)
              if (!entry) return yield* fail("command_status", "unknown_command", "Command ID is unknown")
              if (entry.status === "running") return { status: "running" as const }
              if (entry.status === "completed") return { status: "completed" as const, result: entry.result }
              if (entry.status === "failed") return { status: "failed" as const, message: entry.message }
              return { status: "cancelled" as const }
            }).pipe(
              lock.withPermits(1),
            ),
          CancelCommand: ({ payload }) =>
            Effect.gen(function* () {
              const current = yield* getState("cancel_command")
              if (payload.epoch !== `${current.generation}:${epoch}`) return yield* fail("cancel_command", "unknown_command", "Command belongs to a previous actor wake or generation")
              const existing = yield* Effect.sync(() => commands.get(payload.id)).pipe(lock.withPermits(1))
              if (!existing) {
                if (commands.size >= maximumCommandRecords) return yield* fail("cancel_command", "capacity", "Command record capacity reached")
                commands.set(payload.id, { identity: "", status: "cancelled" })
                return { status: "cancelled" as const }
              }
              if (existing.status === "failed") return yield* fail("cancel_command", "environment_failed", existing.message)
              if (existing.status === "completed") return { status: "completed" as const, result: existing.result }
              if (existing.status === "cancelled") return { status: "cancelled" as const }
              yield* Fiber.interrupt(existing.fiber)
              const terminal = yield* Effect.sync(() => commands.get(payload.id)).pipe(lock.withPermits(1))
              if (terminal?.status === "cancelled") return { status: "cancelled" as const }
              if (terminal?.status === "completed") return { status: "completed" as const, result: terminal.result }
              if (terminal?.status === "failed") return { status: "failed" as const, message: terminal.message }
              return yield* fail("cancel_command", "environment_failed", "Command termination was not confirmed")
            }).pipe(Effect.uninterruptible),
          Filesystem: ({ payload }) =>
            tracked(
              Effect.gen(function* () {
                const request = payload.request
                const current = yield* getState("filesystem")
                if (current.lifecycle !== "running") return yield* fail("filesystem", "stopped", "Workspace is not accepting work")
                if (payload.generation !== current.generation)
                  return yield* fail("filesystem", "stale_generation", "Workspace generation is stale")
                if (request.type === "write") {
                  const padding = request.data.endsWith("==") ? 2 : request.data.endsWith("=") ? 1 : 0
                  if (Math.floor(request.data.length * 3 / 4) - padding > maximumFilesystemPayloadBytes) {
                    return yield* fail("filesystem", "capacity", `Filesystem write exceeds ${maximumFilesystemPayloadBytes} bytes`)
                  }
                }
                const vm = yield* getVM
                const result = yield* vm.value
                  .filesystem(
                    request.type === "write"
                      ? { ...request, data: Buffer.from(request.data, "base64") }
                      : request,
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new Error({
                          operation: cause.operation,
                          reason: "environment_failed",
                          message: String(cause.cause),
                          filesystemCode: cause.filesystemCode,
                        }),
                    ),
                  )
                if (result.type === "read") return { type: "read" as const, data: Buffer.from(result.data).toString("base64") }
                if (result.type === "stat") {
                  return { type: "stat" as const, stat: result.stat }
                }
                return result
              }).pipe(ioLock.withPermits(1)),
            ),
          Stop: () =>
            tracked(
              Effect.gen(function* () {
                const current = yield* Effect.gen(function* () {
                  const value = yield* State.get(state).pipe(Effect.orDie)
                  if (!value.initialized) return yield* fail("stop", "not_initialized", "Workspace is not initialized")
                  admission.open = false
                  return value
                }).pipe(lock.withPermits(1))
                if (current.lifecycle === "stopped") {
                  if (!durable.current) {
                    yield* save("stop")
                    durable.current = true
                  }
                  return current
                }
                yield* Effect.forEach(commands.values(), (entry) =>
                  entry.status === "running" ? Fiber.interrupt(entry.fiber) : Effect.void,
                  { concurrency: "unbounded", discard: true },
                )
                yield* Effect.gen(function* () {
                  if (environment.handle) {
                    yield* environment.handle.value.stop
                  } else {
                    const workload = yield* acquireWorkload("stop", current.backend, current)
                    yield* Effect.tryPromise({
                      try: () => workload.stop(),
                      catch: (cause) => new Error({ operation: "stop", reason: "environment_failed", message: String(cause) }),
                    })
                  }
                }).pipe(
                  vmLock.withPermits(1),
                  Effect.mapError(
                    (cause) => new Error({
                      operation: cause.operation,
                      reason: "environment_failed",
                      message: String(cause.cause),
                    }),
                  ),
                )
                const value = { ...current, lifecycle: "stopped" as const }
                yield* persist(value, "stop")
                return value
              }),
            ),
          GetEnvironment: () =>
            tracked(
              getState("environment").pipe(
                Effect.map(({ backend, generation, lifecycle, root }) => ({ backend, generation, lifecycle, root })),
                lock.withPermits(1),
              ),
            ),
        })
        return handlers
      }),
    {
      state: {
        schema: StateSchema,
        initialValue: () => ({
          initialized: false,
          backend: "local",
          generation: 0,
          lifecycle: "running",
          storageIdentity: "",
          sandboxID: undefined,
          boundaryToken: undefined,
          root: undefined,
        }),
      },
    },
  )
}
