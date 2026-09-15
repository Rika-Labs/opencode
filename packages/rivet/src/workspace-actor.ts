import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Action, Actor, State } from "@rivetkit/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, Semaphore } from "effect"
import { AgentOS } from "./agentos.ts"
import { Workload } from "./e2b.ts"
import { open } from "./e2b-workspace.ts"
import { Environment, Promotion, StateSchema } from "./workspace-schema.ts"
import { archiveWorkspace, extractWorkspace, manifestScript, validateArchive, workspaceManifest } from "./workspace-transfer.ts"

const maximumCommandTimeoutMs = 600_000
const maximumDirectRunTimeoutMs = 50_000
const maximumFilesystemPayloadBytes = 1_048_576

export class Error extends Schema.TaggedErrorClass<Error>()("Rivet.WorkspaceActorError", {
  operation: Schema.String,
  reason: Schema.Literals(["not_initialized", "stopped", "stale_generation", "storage_missing", "environment_failed", "unknown_command", "command_conflict", "promotion_conflict", "unsupported", "capacity"]),
  message: Schema.String,
  filesystemCode: Schema.optional(Schema.String),
}) {}

export const Initialize = Action.make("Initialize", {
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
    outcome: Schema.String,
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
  success: Schema.Struct({ status: Schema.Literal("cancelled") }),
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
      birthtimeMs: Schema.Number,
      dev: Schema.Number,
      ino: Schema.Number,
      mode: Schema.Number,
      nlink: Schema.Number,
      uid: Schema.Number,
      gid: Schema.Number,
      rdev: Schema.Number,
      size: Schema.Number,
      sizeExact: Schema.optional(Schema.String),
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

export const BeginPromotion = Action.make("BeginPromotion", {
  payload: { requestID: Schema.String, target: Schema.Literals(["agentos", "e2b"]) },
  success: Promotion,
  error: Error,
})

export const PromotionStatus = Action.make("PromotionStatus", {
  payload: { requestID: Schema.String },
  success: Promotion,
  error: Error,
})

export const WorkspaceActor = Actor.make("OpenCodeWorkspace", {
  actions: [Initialize, Run, CommandEpoch, StartCommand, CommandStatus, CancelCommand, Filesystem, Stop, GetEnvironment, BeginPromotion, PromotionStatus],
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
        const root = join(storageDirectory, "actors", storageIdentity)
        const initialDirectory = join(root, "workspace", "generation-1")
        const database = join(root, "agentos.sqlite")
        const ownershipFile = join(root, "agentos.owner")
        const wakeScope = yield* Scope.Scope
        type AgentEnvironment = Effect.Success<ReturnType<typeof AgentOS.open>>
        type E2BEnvironment = ReturnType<typeof open>
        type BackendHandle = { type: "agentos"; value: AgentEnvironment } | { type: "e2b"; value: E2BEnvironment }
        const environment = { handle: undefined as BackendHandle | undefined }
        const ownership = { token: undefined as string | undefined }
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
        const migration = { active: false }

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
              if (value.storageIdentity !== storageIdentity || !existsSync(root)) {
                return fail(operation, "storage_missing", "Initialized workspace storage is missing")
              }
              if (value.backend === "agentos" && (!value.directory || !existsSync(value.directory) || !existsSync(database)))
                return fail(operation, "storage_missing", "Initialized AgentOS workspace storage is missing")
              if (value.backend === "e2b" && (!value.sandboxID || !value.boundaryToken))
                return fail(operation, "storage_missing", "Initialized E2B workspace identity is missing")
              return Effect.succeed(value)
            }),
          )

        const getVMFor = (initial?: { directory: string }) => Effect.gen(function* () {
          if (!admission.open && !migration.active) return yield* fail("environment", "stopped", "Workspace is stopped")
          if (environment.handle) return environment.handle
          const current = yield* State.get(state).pipe(Effect.orDie)
          if (!current.initialized && !initial) return yield* fail("environment", "not_initialized", "Workspace is not initialized")
          if (current.backend === "e2b") {
            if (!current.sandboxID || !current.boundaryToken) return yield* fail("e2b_reconnect", "storage_missing", "E2B identity is missing")
            const sandboxID = current.sandboxID
            const boundaryToken = current.boundaryToken
            const workload = yield* Effect.tryPromise({
              try: () => Workload.reconnect({ sandboxId: sandboxID, boundaryToken }),
              catch: (cause) => new Error({ operation: "e2b_reconnect", reason: "environment_failed", message: String(cause) }),
            })
            const opened = open(workload)
            const handle = { type: "e2b" as const, value: opened }
            environment.handle = handle
            yield* Scope.addFinalizer(wakeScope, Effect.suspend(() =>
              environment.handle === handle
                ? Effect.tryPromise(() => workload.pause()).pipe(Effect.orDie)
                : Effect.void,
            ))
            return handle
          }
          const token = randomUUID()
          yield* Effect.tryPromise({
            try: () => writeFile(ownershipFile, token, { flag: "wx" }),
            catch: (cause) => new Error({
              operation: "ownership",
              reason: "environment_failed",
              message: existsSync(ownershipFile)
                ? "Workspace shutdown is unresolved"
                : String(cause),
            }),
          })
          ownership.token = token
          const directory = initial?.directory ?? current.directory
          if (!directory) return yield* fail("ownership", "storage_missing", "AgentOS directory is missing")
          const opened = yield* AgentOS.open({ directory, database }).pipe(
            Effect.provideService(Scope.Scope, wakeScope),
            Effect.tapError((cause) =>
              cause.operation === "open_cleanup"
                ? Effect.void
                : releaseOwnership(ownershipFile, token),
            ),
            Effect.mapError(
              (cause) =>
                new Error({
                  operation: cause.operation,
                  reason: "environment_failed",
                  message: String(cause.cause),
                }),
            ),
          )
          const handle = { type: "agentos" as const, value: opened }
          environment.handle = handle
          yield* Scope.addFinalizer(
            wakeScope,
            opened.stop.pipe(
              Effect.andThen(releaseOwnership(ownershipFile, token)),
              Effect.orDie,
            ),
          )
          return handle
        }).pipe(vmLock.withPermits(1))
        const getVM = getVMFor()

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

        const migrateLocked = (started: Extract<typeof Promotion.Type, { status: "running" }>) => {
          const captured = { source: undefined as typeof StateSchema.Type | undefined, committed: false }
          return (
          Effect.gen(function* () {
            const source = yield* getState("promotion")
            captured.source = source
            const sourceVM = yield* getVM
            yield* sourceVM.value.stop.pipe(
              Effect.mapError((cause) => new Error({ operation: "promotion_stop", reason: "environment_failed", message: String(cause.cause) })),
            )
            if (source.backend === "agentos" && ownership.token) yield* releaseOwnership(ownershipFile, ownership.token)
            if (source.backend === "agentos" && !source.directory) return yield* fail("promotion_export", "storage_missing", "AgentOS directory is missing")
            const sourceDirectory = source.directory
            const archive = source.backend === "agentos"
              ? yield* Effect.tryPromise({
                  try: () => sourceDirectory ? archiveWorkspace(sourceDirectory) : Promise.reject(new globalThis.Error("AgentOS directory is missing")),
                  catch: (cause) => new Error({ operation: "promotion_export", reason: "environment_failed", message: String(cause) }),
                })
              : yield* Effect.tryPromise({
                  try: () => sourceVM.type === "e2b" ? sourceVM.value.workload.exportWorkspace() : Promise.reject(new globalThis.Error("Source backend handle mismatch")),
                  catch: (cause) => new Error({ operation: "promotion_export", reason: "environment_failed", message: String(cause) }),
                })
            yield* Effect.tryPromise({
              try: () => validateArchive(archive),
              catch: (cause) => new Error({ operation: "promotion_validate", reason: "environment_failed", message: String(cause) }),
            })
            const manifestDirectory = yield* Effect.acquireRelease(
              Effect.tryPromise(() => mkdtemp(join(tmpdir(), "opencode-workspace-manifest-"))).pipe(Effect.orDie),
              (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
            )
            const sourceManifest = yield* Effect.tryPromise({
              try: async () => {
                const directory = join(manifestDirectory, "source")
                await extractWorkspace(archive, directory)
                return workspaceManifest(directory)
              },
              catch: (cause) => new Error({ operation: "promotion_validate", reason: "environment_failed", message: String(cause) }),
            })
            const generation = source.generation + 1
            const destination = started.target === "e2b"
              ? yield* Effect.tryPromise({
                  try: () => Workload.create({
                    journal: async (entry) => {
                      if (entry.state !== "created") return
                      const current = await Effect.runPromise(State.get(state).pipe(Effect.orDie))
                      const promotion = current.promotion.status === "running"
                        ? { ...current.promotion, sandboxID: entry.sandboxId, boundaryToken: entry.boundaryToken }
                        : current.promotion
                      await Effect.runPromise(persist({ ...current, promotion }, "promotion_journal"))
                    },
                  }).then(async (workload) => {
                    try {
                      await workload.importWorkspace(archive)
                      const manifest = await workload.run("/usr/bin/python3", { args: ["-I", "-S", "-c", manifestScript, "/workspace"] })
                      if (manifest.exitCode !== 0) throw new globalThis.Error(`E2B destination manifest failed: ${manifest.stderr}`)
                      assertManifest(sourceManifest, JSON.parse(manifest.stdout.toString()))
                      return { type: "e2b" as const, value: open(workload) }
                    } catch (cause) {
                      await workload.delete().catch((cleanup) => {
                        throw new AggregateError([cause, cleanup], `E2B destination ${workload.sandboxId} cleanup failed`)
                      })
                      throw cause
                    }
                  }),
                  catch: (cause) => new Error({ operation: "promotion_provision", reason: "environment_failed", message: String(cause) }),
                })
              : yield* Effect.gen(function* () {
                  if (!existsSync(database)) return yield* fail("promotion_provision", "storage_missing", "AgentOS identity database is missing")
                  const directory = join(root, "workspace", `generation-${generation}`)
                  yield* Effect.tryPromise({
                    try: () => extractWorkspace(archive, directory),
                    catch: (cause) => new Error({ operation: "promotion_import", reason: "environment_failed", message: String(cause) }),
                  })
                  yield* Effect.tryPromise({
                    try: async () => assertManifest(sourceManifest, await workspaceManifest(directory)),
                    catch: (cause) => new Error({ operation: "promotion_validate", reason: "environment_failed", message: String(cause) }),
                  })
                  const token = randomUUID()
                  yield* Effect.tryPromise({
                    try: () => writeFile(ownershipFile, token, { flag: "wx" }),
                    catch: (cause) => new Error({ operation: "ownership", reason: "environment_failed", message: String(cause) }),
                  })
                  ownership.token = token
                  const opened = yield* AgentOS.open({ directory, database }).pipe(
                    Effect.provideService(Scope.Scope, wakeScope),
                    Effect.mapError((cause) => new Error({ operation: "promotion_provision", reason: "environment_failed", message: String(cause.cause) })),
                  )
                  yield* Scope.addFinalizer(wakeScope, opened.stop.pipe(Effect.andThen(releaseOwnership(ownershipFile, token)), Effect.orDie))
                  return { type: "agentos" as const, value: opened }
                })
            const journaled = yield* State.get(state).pipe(Effect.orDie)
            const promotion = {
              ...started,
              status: "completed" as const,
              generation,
              cleanup: source.backend === "e2b" ? "pending" as const : "complete" as const,
              sandboxID: destination.type === "e2b" ? destination.value.workload.sandboxId : undefined,
              boundaryToken: destination.type === "e2b" ? destination.value.workload.boundaryToken : undefined,
              cleanupSandboxID: source.backend === "e2b" ? source.sandboxID : undefined,
              cleanupBoundaryToken: source.backend === "e2b" ? source.boundaryToken : undefined,
            }
            const completed = {
              ...journaled,
              backend: started.target,
              generation,
              lifecycle: "running" as const,
              directory: started.target === "agentos" ? join(root, "workspace", `generation-${generation}`) : undefined,
              sandboxID: destination.type === "e2b" ? destination.value.workload.sandboxId : undefined,
              boundaryToken: destination.type === "e2b" ? destination.value.workload.boundaryToken : undefined,
              promotion,
              promotionHistory: [...(journaled.promotionHistory ?? []), promotion],
            }
            yield* persist(completed, "promotion_commit")
            captured.committed = true
            environment.handle = destination
            if (destination.type === "e2b") {
              yield* Scope.addFinalizer(wakeScope, Effect.suspend(() =>
                environment.handle === destination
                  ? Effect.tryPromise(() => destination.value.workload.pause()).pipe(Effect.orDie)
                  : Effect.void,
              ))
            }
            if (source.backend === "e2b") {
              const cleanup = yield* Effect.exit(Effect.tryPromise(() => sourceVM.type === "e2b" ? sourceVM.value.workload.delete() : Promise.reject(new globalThis.Error("Source backend handle mismatch"))))
              const finalized = {
                ...promotion,
                cleanup: Exit.isFailure(cleanup) ? "failed" as const : "complete" as const,
                cleanupMessage: Exit.isFailure(cleanup) ? Cause.pretty(cleanup.cause) : undefined,
              }
              yield* persist({
                ...completed,
                promotion: finalized,
                promotionHistory: [...(journaled.promotionHistory ?? []), finalized],
              }, "promotion_cleanup")
              if (Exit.isFailure(cleanup)) return
            }
            admission.open = true
          }).pipe(
            Effect.catch((cause) =>
              State.get(state).pipe(
                Effect.orDie,
                Effect.flatMap((current) => {
                  const source = captured.committed ? current : captured.source ?? current
                  const sandboxID = current.promotion.status === "running" ? current.promotion.sandboxID : undefined
                  const boundaryToken = current.promotion.status === "running" ? current.promotion.boundaryToken : undefined
                  const failed = { ...started, status: "failed" as const, message: cause.message, sandboxID, boundaryToken }
                  return persist({ ...source, lifecycle: "blocked", promotion: failed, promotionHistory: [...(source.promotionHistory ?? []), failed] }, "promotion_failed")
                }),
                Effect.orDie,
              ),
            ),
            Effect.ensuring(Effect.sync(() => { migration.active = false })),
            Effect.scoped,
          )
          )
        }

        const migrate = (started: Extract<typeof Promotion.Type, { status: "running" }>) =>
          Effect.forEach(commands.values(), (entry) =>
            entry.status === "running" ? Fiber.await(entry.fiber) : Effect.void,
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.andThen(migrateLocked(started).pipe(ioLock.withPermits(1))))

        const handlers = WorkspaceActor.of({
          Initialize: () =>
            tracked(
              Effect.gen(function* () {
                const value = yield* Effect.gen(function* () {
                  const current = yield* State.get(state).pipe(Effect.orDie)
                  if (current.initialized) {
                    if (current.storageIdentity !== storageIdentity || !existsSync(root) || (current.backend === "agentos" && (!current.directory || !existsSync(current.directory) || !existsSync(database)))) {
                      return yield* fail("initialize", "storage_missing", "Initialized workspace storage is missing")
                    }
                    if (current.lifecycle === "stopped") return yield* fail("initialize", "stopped", "Workspace is stopped")
                    if (!durable.current) {
                      yield* save("initialize")
                      durable.current = true
                    }
                    return current
                  }
                  yield* Effect.tryPromise(() => mkdir(initialDirectory, { recursive: true })).pipe(
                    Effect.mapError((cause) => new Error({ operation: "initialize", reason: "environment_failed", message: String(cause) })),
                  )
                  const initialized = {
                    initialized: true,
                    backend: "agentos" as const,
                    generation: 1,
                    lifecycle: "running" as const,
                    storageIdentity,
                    directory: initialDirectory,
                    promotion: { status: "idle" as const },
                    promotionHistory: [],
                  }
                  yield* getVMFor({ directory: initialDirectory })
                  if (!existsSync(database)) return yield* fail("initialize", "environment_failed", "Workspace database was not provisioned")
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
              const fiber = yield* Effect.gen(function* () {
                const existing = commands.get(payload.id)
                if (!existing) {
                  if (commands.size >= maximumCommandRecords) return yield* fail("cancel_command", "capacity", "Command record capacity reached")
                  commands.set(payload.id, { identity: "", status: "cancelled" })
                  return undefined
                }
                if (existing.status === "failed") return yield* fail("cancel_command", "environment_failed", existing.message)
                if (existing.status === "completed") {
                  commands.set(payload.id, { identity: existing.identity, status: "cancelled" })
                  return undefined
                }
                return existing.status === "running" ? existing.fiber : undefined
              }).pipe(lock.withPermits(1))
              if (fiber) yield* Fiber.interrupt(fiber)
              const terminal = yield* Effect.sync(() => commands.get(payload.id)).pipe(lock.withPermits(1))
              if (terminal?.status === "cancelled") return { status: "cancelled" as const }
              return yield* fail("cancel_command", "environment_failed", terminal?.status === "failed" ? terminal.message : "Command termination was not confirmed")
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
                  return {
                    type: "stat" as const,
                    stat: {
                      ...result.stat,
                      sizeExact: result.stat.sizeExact === undefined ? undefined : String(result.stat.sizeExact),
                    },
                  }
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
                  if (migration.active || value.lifecycle === "promoting") return yield* fail("stop", "promotion_conflict", "Workspace promotion is active")
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
                  entry.status === "running" ? Fiber.await(entry.fiber) : Effect.void,
                  { concurrency: "unbounded", discard: true },
                )
                yield* Effect.gen(function* () {
                  if (environment.handle?.type === "agentos") {
                    yield* environment.handle.value.stop
                    if (ownership.token) yield* releaseOwnership(ownershipFile, ownership.token)
                  } else if (environment.handle?.type === "e2b") {
                    yield* environment.handle.value.stop
                  } else if (existsSync(ownershipFile)) {
                    return yield* fail("stop", "environment_failed", "Workspace shutdown is unresolved")
                  } else if (current.backend === "e2b") {
                    if (!current.sandboxID || !current.boundaryToken) return yield* fail("stop", "storage_missing", "E2B identity is missing")
                    const sandboxID = current.sandboxID
                    const boundaryToken = current.boundaryToken
                    const workload = yield* Effect.tryPromise({
                      try: () => Workload.reconnect({ sandboxId: sandboxID, boundaryToken }),
                      catch: (cause) => new Error({ operation: "stop", reason: "environment_failed", message: String(cause) }),
                    })
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
                durable.current = false
                yield* State.set(state, value).pipe(Effect.orDie)
                yield* save("stop")
                durable.current = true
                return value
              }),
            ),
          GetEnvironment: () =>
            tracked(
              getState("environment").pipe(
                Effect.map(({ backend, generation, lifecycle }) => ({ backend, generation, lifecycle })),
                lock.withPermits(1),
              ),
            ),
          BeginPromotion: ({ payload }) =>
            Effect.gen(function* () {
              const started = yield* Effect.gen(function* () {
                const current = yield* getState("begin_promotion")
                const historical = current.promotionHistory?.find((item) => item.requestID === payload.requestID)
                if (historical) {
                  if (historical.target === payload.target) return historical
                  return yield* fail("begin_promotion", "promotion_conflict", "Promotion request ID was already used with a different target")
                }
                if (current.promotion.status === "running") {
                  if (current.promotion.requestID === payload.requestID && current.promotion.target === payload.target) return current.promotion
                  return yield* fail("begin_promotion", "promotion_conflict", "A different promotion request already owns this workspace")
                }
                if (current.promotion.status === "completed" && current.promotion.cleanup !== "complete") return yield* fail("begin_promotion", "promotion_conflict", "Previous promotion cleanup is incomplete")
                if (current.lifecycle !== "running") return yield* fail("begin_promotion", "stopped", "Workspace is not running")
                if (current.backend === payload.target) return yield* fail("begin_promotion", "promotion_conflict", "Workspace already uses the requested backend")
                if ((current.promotionHistory?.length ?? 0) >= 32) return yield* fail("begin_promotion", "capacity", "Promotion history capacity reached")
                const promotion = {
                  status: "running" as const,
                  requestID: payload.requestID,
                  target: payload.target,
                  source: current.backend,
                  sourceGeneration: current.generation,
                }
                admission.open = false
                migration.active = true
                yield* persist({ ...current, lifecycle: "promoting", promotion }, "begin_promotion")
                yield* tracked(migrate(promotion)).pipe(Effect.forkIn(wakeScope, { startImmediately: true }))
                return promotion
              }).pipe(lock.withPermits(1), Effect.uninterruptible)
              return started
            }),
          PromotionStatus: ({ payload }) =>
            State.get(state).pipe(
              Effect.orDie,
              Effect.flatMap((current) => {
                if (!current.initialized) return fail("promotion_status", "not_initialized", "Workspace is not initialized")
                if (!durable.current) return fail("promotion_status", "environment_failed", "Workspace state is not durably committed")
                const historical = current.promotionHistory?.find((item) => item.requestID === payload.requestID)
                if (historical) return Effect.succeed(historical)
                if (current.promotion.status === "running" && current.promotion.requestID === payload.requestID && !migration.active) {
                  return persist({
                    ...current,
                    lifecycle: "blocked",
                    promotion: { ...current.promotion, status: "failed", message: "Promotion was interrupted; destination identity requires operator reconciliation" },
                  }, "promotion_interrupted").pipe(Effect.as({ ...current.promotion, status: "failed" as const, message: "Promotion was interrupted; destination identity requires operator reconciliation" }))
                }
                if (current.promotion.status !== "idle" && current.promotion.requestID === payload.requestID) return Effect.succeed(current.promotion)
                return fail("promotion_status", "promotion_conflict", "Promotion request ID is unknown")
              }),
            ),
        })
        return handlers
      }),
    {
      state: {
        schema: StateSchema,
        initialValue: () => ({
          initialized: false,
          backend: "agentos",
          generation: 0,
          lifecycle: "running",
          storageIdentity: "",
          directory: undefined,
          sandboxID: undefined,
          boundaryToken: undefined,
          promotion: { status: "idle" },
          promotionHistory: [],
        }),
      },
    },
  )
}

const releaseOwnership = (path: string, token: string) =>
  Effect.tryPromise(async () => {
    if (await readFile(path, "utf8").catch(() => undefined) !== token) return
    await unlink(path).catch((cause) => {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return
      throw cause
    })
  }).pipe(Effect.orDie)

function assertManifest(source: unknown, destination: unknown) {
  if (JSON.stringify(source) === JSON.stringify(destination)) return
  const entries = (value: unknown) => new Map((Array.isArray(value) ? value : []).map((item) => [(item as { path?: string }).path, item]))
  const wanted = entries(source)
  const found = entries(destination)
  for (const [path, item] of wanted) {
    if (!found.has(path)) throw new globalThis.Error(`Workspace destination manifest is missing ${path}`)
    const keys = new Set([...Object.keys(item as object), ...Object.keys(found.get(path) as object)])
    for (const key of keys) {
      const left = JSON.stringify((item as Record<string, unknown>)[key])
      const right = JSON.stringify((found.get(path) as Record<string, unknown>)[key])
      if (left !== right) throw new globalThis.Error(`Workspace destination manifest differs for ${path}: ${key} is ${right}, expected ${left}`)
    }
  }
  for (const path of found.keys()) {
    if (!wanted.has(path)) throw new globalThis.Error(`Workspace destination manifest has unexpected entry ${path}`)
  }
}
