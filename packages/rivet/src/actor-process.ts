export * as ActorProcess from "./actor-process.ts"

import { Duration, Effect, PlatformError, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"

interface Actor {
  readonly CommandEpoch: () => Effect.Effect<string, unknown>
  readonly StartCommand: (payload: {
    readonly id: string
    readonly epoch: string
    readonly command: Command
  }) => Effect.Effect<{ readonly id: string }, unknown>
  readonly CommandStatus: (payload: { readonly id: string; readonly epoch: string }) => Effect.Effect<
    | { readonly status: "running" }
    | { readonly status: "completed"; readonly result: Result }
    | { readonly status: "failed"; readonly message: string }
    | { readonly status: "cancelled" },
    unknown
  >
  readonly CancelCommand: (payload: { readonly id: string; readonly epoch: string }) => Effect.Effect<
    | { readonly status: "cancelled" }
    | { readonly status: "completed"; readonly result: Result }
    | { readonly status: "failed"; readonly message: string },
    unknown
  >
}

interface Command {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

interface Result {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly output: string
  readonly truncated: boolean
}

const maximumTimeoutMs = 600_000
const defaultTimeoutMs = 120_000

const describe = (command: ChildProcess.Command): string =>
  command._tag === "StandardCommand"
    ? [command.command, ...command.args].join(" ")
    : `${describe(command.left)} | ${describe(command.right)}`

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const fail = (method: string, command: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: command,
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  })

export function makeSpawner(actor: Actor): ChildProcessSpawner["Service"] {
  return make((command) =>
    Effect.gen(function* () {
      const label = describe(command)
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(fail("spawn", label, new Error("Remote piped commands are unsupported")))
      }
      if (command.options.env || command.options.extendEnv || command.options.additionalFds) {
        return yield* Effect.fail(fail("spawn", label, new Error("Remote command environment and file descriptors are unsupported")))
      }
      const timeout = command.options.forceKillAfter
      const timeoutMs = timeout === undefined ? defaultTimeoutMs : Duration.toMillis(timeout)
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimeoutMs) {
        return yield* Effect.fail(fail("spawn", label, new Error(`Remote command timeout must be between 1 and ${maximumTimeoutMs} milliseconds`)))
      }
      const executable =
        command.options.shell === undefined || command.options.shell === false
          ? command.command
          : typeof command.options.shell === "string"
            ? command.options.shell
            : "/bin/sh"
      const args =
        command.options.shell === undefined || command.options.shell === false
          ? [...command.args]
          : ["-c", [command.command, ...command.args.map(shellQuote)].join(" ")]
      const payload = {
        command: executable,
        args,
        cwd: command.options.cwd,
        timeoutMs,
        maxOutputBytes: 1024 * 1024,
      }
      const epoch = yield* actor.CommandEpoch().pipe(Effect.mapError((cause) => fail("spawn", label, cause)))
      const id = crypto.randomUUID()
      const cancel = actor.CancelCommand({ id, epoch }).pipe(Effect.asVoid)
      const result = yield* actor.StartCommand({ id, epoch, command: payload }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            while (true) {
              const status = yield* actor.CommandStatus({ id, epoch })
              if (status.status === "completed") return status.result
              if (status.status === "failed") return yield* Effect.fail(new Error(status.message))
              if (status.status === "cancelled") return yield* Effect.fail(new Error("Remote command was cancelled"))
              yield* Effect.sleep("100 millis")
            }
          }),
        ),
        Effect.onInterrupt(() => cancel),
        Effect.mapError((cause) => fail("spawn", label, cause)),
      )
      const stdout = Stream.succeed(Buffer.from(result.stdout))
      const stderr = Stream.succeed(Buffer.from(result.stderr))
      const output = Stream.succeed(Buffer.from(result.output))
      return makeHandle({
        pid: ProcessId(0),
        exitCode: Effect.succeed(ExitCode(result.exitCode ?? 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )
}
