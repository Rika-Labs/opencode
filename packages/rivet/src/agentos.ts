export * as AgentOS from "./agentos.ts"

import { Cause, Effect, Exit, Schema, Scope, Semaphore } from "effect"

export class Error extends Schema.TaggedErrorClass<Error>()("Rivet.AgentOSError", {
  operation: Schema.String,
  cause: Schema.Defect(),
  filesystemCode: Schema.optional(Schema.String),
}) {}

export interface Options {
  readonly directory: string
  readonly database: string
}

export interface Command {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export type FilesystemOperation =
  | { readonly type: "read"; readonly path: string }
  | {
      readonly type: "write"
      readonly path: string
      readonly data: Uint8Array
      readonly flag?: "w" | "wx"
      readonly mode?: number
    }
  | { readonly type: "stat"; readonly path: string }
  | { readonly type: "mkdir"; readonly path: string; readonly recursive?: boolean }
  | { readonly type: "readdir"; readonly path: string; readonly recursive: boolean; readonly entries: boolean }
  | { readonly type: "exists"; readonly path: string }
  | { readonly type: "remove"; readonly path: string; readonly recursive?: boolean }
  | { readonly type: "move"; readonly from: string; readonly to: string }
  | { readonly type: "realpath"; readonly path: string }

export const open = Effect.fn("Rivet.AgentOS.open")(function* (options: Options) {
  return yield* Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      const { AgentOs } = yield* Effect.tryPromise({
        try: () => import("@rikalabs/agentos-core"),
        catch: (cause) => new Error({ operation: "load", cause }),
      })
      const sidecar = yield* Effect.tryPromise({
        try: () => AgentOs.createSidecar(),
        catch: (cause) => new Error({ operation: "sidecar", cause }),
      })
      const lock = yield* Semaphore.make(1)
      const lifecycle = { closed: false, disposed: false }
      const vm = yield* Effect.tryPromise({
        try: () =>
          AgentOs.create({
            sidecar: { kind: "explicit", handle: sidecar },
            database: { type: "sqlite_file", path: options.database },
            user: { uid: 0, gid: 0, username: "root" },
            mounts: [
              {
                path: "/workspace",
                plugin: { id: "host_dir", config: { hostPath: options.directory, readOnly: false } },
                readOnly: false,
              },
            ],
          }),
        catch: (cause) => new Error({ operation: "open", cause }),
      }).pipe(
        Effect.catch((created) =>
          Effect.exit(
            Effect.tryPromise({
              try: () => sidecar.terminate(),
              catch: (cause) => new Error({ operation: "open_cleanup", cause }),
            }),
          ).pipe(
            Effect.flatMap((terminated) => {
              if (Exit.isSuccess(terminated)) return Effect.fail(created)
              return Effect.fail(
                new Error({
                  operation: "open_cleanup",
                  cause: new AggregateError(
                    [created, Cause.squash(terminated.cause)],
                    "AgentOS creation and cleanup failed",
                  ),
                }),
              )
            }),
          ),
        ),
      )
      const stop = Effect.suspend(() => {
        return Effect.gen(function* () {
          lifecycle.closed = true
          if (lifecycle.disposed) return
          const disposed = yield* Effect.exit(
            Effect.tryPromise({
              try: () => vm.dispose(),
              catch: (cause) => new Error({ operation: "stop", cause }),
            }),
          )
          const terminated = yield* Effect.exit(
            Effect.tryPromise({
              try: () => sidecar.terminate(),
              catch: (cause) => new Error({ operation: "stop", cause }),
            }),
          )
          if (Exit.isFailure(disposed) && Exit.isFailure(terminated)) {
            return yield* new Error({
              operation: "stop",
              cause: new AggregateError(
                [Cause.squash(disposed.cause), Cause.squash(terminated.cause)],
                "AgentOS disposal and sidecar termination failed",
              ),
            })
          }
          if (Exit.isFailure(disposed)) return yield* Effect.failCause(disposed.cause)
          if (Exit.isFailure(terminated)) return yield* Effect.failCause(terminated.cause)
          lifecycle.disposed = true
        }).pipe(lock.withPermits(1))
      }).pipe(Effect.uninterruptible)
      yield* Scope.addFinalizer(yield* Scope.Scope, stop.pipe(Effect.orDie))

      const run = Effect.fn("Rivet.AgentOS.run")(function* (input: Command) {
        if (lifecycle.closed) return yield* new Error({ operation: "run", cause: "Environment is stopped" })
        if (
          !Number.isSafeInteger(input.maxOutputBytes) ||
          input.maxOutputBytes < 0 ||
          input.maxOutputBytes > 1_048_576
        ) {
          return yield* new Error({ operation: "validate", cause: "maxOutputBytes must be between 0 and 1048576" })
        }
        if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) {
          return yield* new Error({ operation: "validate", cause: "timeoutMs must be between 1 and 2147483647" })
        }
        const stdout: Uint8Array[] = []
        const stderr: Uint8Array[] = []
        const output: Uint8Array[] = []
        const capture = { bytes: 0, truncated: false }
        const append = (target: Uint8Array[], chunk: Uint8Array) => {
          const remaining = Math.max(0, input.maxOutputBytes - capture.bytes)
          const kept = chunk.subarray(0, remaining)
          if (kept.length > 0) {
            const copy = kept.slice()
            target.push(copy)
            output.push(copy)
          }
          capture.bytes += kept.length
          capture.truncated ||= kept.length < chunk.length
        }

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const process = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () =>
                  vm.process.spawn(input.command, [...(input.args ?? [])], {
                    cwd: input.cwd ?? "/workspace",
                    output: { retainEvents: false },
                    onStdout: (chunk) => append(stdout, chunk),
                    onStderr: (chunk) => append(stderr, chunk),
                  }),
                catch: (cause) => new Error({ operation: "spawn", cause }),
              }),
              (process) =>
                Effect.promise(async () => {
                  const current = await vm.process.get(process.pid)
                  if (current.state !== "running") return
                  await vm.process.kill(process.pid)
                  await vm.process.wait(process.pid)
                }),
            )
            yield* Effect.tryPromise({
              try: () => vm.process.closeStdin(process.pid),
              catch: (cause) => new Error({ operation: "closeStdin", cause }),
            })
            const exit = yield* Effect.tryPromise({
              try: () => vm.process.wait(process.pid),
              catch: (cause) => new Error({ operation: "wait", cause }),
            })
            return {
              exitCode: exit.exitCode,
              outcome: exit.outcome,
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              output: Buffer.concat(output),
              truncated: capture.truncated,
            }
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: input.timeoutMs,
            orElse: () => Effect.fail(new Error({ operation: "timeout", cause: "Command deadline exceeded" })),
          }),
        )
      }, lock.withPermits(1))

      const filesystemCode = (cause: unknown) => {
        if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string")
          return cause.code
        const message = cause instanceof globalThis.Error ? cause.message : String(cause)
        if (/\bEEXIST\b|file exists/i.test(message)) return "EEXIST"
        if (/\bENOENT\b|no such file or directory/i.test(message)) return "ENOENT"
        if (/\bEACCES\b|permission denied/i.test(message)) return "EACCES"
        if (/\bEPERM\b|operation not permitted/i.test(message)) return "EPERM"
        return undefined
      }

      const filesystem = Effect.fn("Rivet.AgentOS.filesystem")(function* (input: FilesystemOperation) {
        if (lifecycle.closed) return yield* new Error({ operation: "filesystem", cause: "Environment is stopped" })
        const execute = async () => {
          if (input.type === "read") return { type: "read" as const, data: await vm.filesystem.readFile(input.path) }
          if (input.type === "write") {
            await vm.filesystem.writeFile(input.path, input.data, { flag: input.flag, mode: input.mode })
            return { type: "void" as const }
          }
          if (input.type === "stat") return { type: "stat" as const, stat: await vm.filesystem.stat(input.path) }
          if (input.type === "mkdir") {
            await vm.filesystem.mkdir(input.path, { recursive: input.recursive })
            return { type: "void" as const }
          }
          if (input.type === "readdir") {
            if (input.recursive)
              return { type: "recursiveEntries" as const, entries: await vm.filesystem.readdirRecursive(input.path) }
            if (input.entries)
              return { type: "directoryEntries" as const, entries: await vm.filesystem.readdirEntries(input.path) }
            return { type: "names" as const, names: await vm.filesystem.readdir(input.path) }
          }
          if (input.type === "exists") return { type: "exists" as const, value: await vm.filesystem.exists(input.path) }
          if (input.type === "remove") {
            await vm.filesystem.remove(input.path, { recursive: input.recursive })
            return { type: "void" as const }
          }
          if (input.type === "move") {
            await vm.filesystem.move(input.from, input.to)
            return { type: "void" as const }
          }
          return { type: "path" as const, path: await vm.filesystem.realpath(input.path) }
        }
        return yield* Effect.tryPromise({
          try: execute,
          catch: (cause) =>
            new Error({
              operation: input.type,
              cause,
              filesystemCode: filesystemCode(cause),
            }),
        })
      }, lock.withPermits(1))

      return { filesystem, run, stop }
    }),
  )
})
