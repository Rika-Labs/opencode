export * as ActorProcess from "./actor-process.ts"

import { AppProcess, waitForAbort } from "@opencode-ai/core/process"
import { Duration, Effect, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

interface Actor {
  readonly CommandEpoch: () => Effect.Effect<string, unknown>
  readonly StartCommand: (payload: { readonly id: string; readonly epoch: string; readonly command: Command }) => Effect.Effect<{ readonly id: string }, unknown>
  readonly CommandStatus: (payload: { readonly id: string; readonly epoch: string }) => Effect.Effect<
    | { readonly status: "running" }
    | { readonly status: "completed"; readonly result: Result }
    | { readonly status: "failed"; readonly message: string }
    | { readonly status: "cancelled" },
    unknown
  >
  readonly CancelCommand: (payload: { readonly id: string; readonly epoch: string }) => Effect.Effect<{ readonly status: "cancelled" }, unknown>
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

const unsupported = (method: string, command: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: command,
    cause: new Error(`Remote actor ${method} is unsupported`),
  })

export function make(actor: Actor): AppProcess.Interface {
  const spawn = (command: ChildProcess.Command) => Effect.fail(unsupported("spawn", describe(command)))
  const spawner = ChildProcessSpawner.make(spawn)
  const run = Effect.fn("Rivet.ActorProcess.run")(function* (
    command: ChildProcess.Command,
    options?: AppProcess.RunOptions,
  ) {
    const label = describe(command)
    if (command._tag !== "StandardCommand") {
      return yield* new AppProcess.AppProcessError({ command: label, cause: new Error("Remote piped commands are unsupported") })
    }
    if (options?.stdin !== undefined) {
      return yield* new AppProcess.AppProcessError({ command: label, cause: new Error("Remote command stdin is unsupported") })
    }
    if (command.options.env || command.options.extendEnv || command.options.additionalFds) {
      return yield* new AppProcess.AppProcessError({ command: label, cause: new Error("Remote command environment and file descriptors are unsupported") })
    }
    if (command.options.detached || command.options.forceKillAfter !== undefined || command.options.killSignal !== undefined) {
      return yield* new AppProcess.AppProcessError({ command: label, cause: new Error("Remote command host lifecycle options are unsupported") })
    }
    const timeoutMs = options?.timeout === undefined ? defaultTimeoutMs : Duration.toMillis(options.timeout)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimeoutMs) {
      return yield* new AppProcess.AppProcessError({ command: label, cause: new Error(`Remote command timeout must be between 1 and ${maximumTimeoutMs} milliseconds`) })
    }
    const executable = command.options.shell === undefined || command.options.shell === false
      ? command.command
      : typeof command.options.shell === "string" ? command.options.shell : "/bin/sh"
    const args = command.options.shell === undefined || command.options.shell === false
      ? [...command.args]
      : ["-c", [command.command, ...command.args.map(shellQuote)].join(" ")]
    const payload = {
      command: executable,
      args,
      cwd: command.options.cwd,
      timeoutMs,
      maxOutputBytes: options?.maxOutputBytes ?? options?.maxErrorBytes ?? 1024 * 1024,
    }
    const epoch = yield* actor.CommandEpoch().pipe(
      Effect.mapError((cause) => new AppProcess.AppProcessError({ command: label, cause })),
    )
    const id = crypto.randomUUID()
    if (options?.signal?.aborted) {
      return yield* waitForAbort(options.signal).pipe(
        Effect.mapError((cause) => new AppProcess.AppProcessError({ command: label, cause })),
      )
    }
    const cancel = actor.CancelCommand({ id, epoch }).pipe(Effect.asVoid)
    const cancelThenFail = (cause: unknown) => cancel.pipe(Effect.andThen(Effect.fail(cause)))
    const execute = actor.StartCommand({ id, epoch, command: payload }).pipe(
      Effect.catchIf(() => true, cancelThenFail),
      Effect.andThen(
        Effect.gen(function* () {
          while (true) {
            const status = yield* actor.CommandStatus({ id, epoch }).pipe(Effect.catchIf(() => true, cancelThenFail))
            if (status.status === "completed") return status.result
            if (status.status === "failed") return yield* Effect.fail(new Error(status.message))
            if (status.status === "cancelled") return yield* Effect.fail(new Error("Remote command was cancelled"))
            yield* Effect.sleep("100 millis")
          }
        }),
      ),
    )
    const observed = options?.signal
      ? execute.pipe(Effect.raceFirst(waitForAbort(options.signal).pipe(Effect.catchIf(() => true, cancelThenFail))))
      : execute
    const result = yield* observed.pipe(
      Effect.onInterrupt(() => cancel),
      Effect.mapError((cause) => new AppProcess.AppProcessError({ command: label, cause })),
    )
    const stdout = Buffer.from(result.stdout)
    const stderr = Buffer.from(result.stderr)
    return {
      command: label,
      exitCode: result.exitCode ?? 1,
      output: options?.combineOutput ? Buffer.from(result.output) : undefined,
      stdout: options?.combineOutput ? Buffer.alloc(0) : stdout,
      stderr: options?.combineOutput ? Buffer.alloc(0) : stderr,
      outputTruncated: options?.combineOutput ? result.truncated : undefined,
      stdoutTruncated: options?.combineOutput ? false : result.truncated,
      stderrTruncated: options?.combineOutput ? false : result.truncated,
    }
  })
  const runStream = (command: ChildProcess.Command, options?: AppProcess.RunStreamOptions): Stream.Stream<string, AppProcess.AppProcessError> =>
    Stream.fail(new AppProcess.AppProcessError({
      command: describe(command),
      cause: new Error(options === undefined
        ? "Remote actor streaming is unsupported"
        : "Remote actor streaming and its signal, stderr, exit-code, and error-output options are unsupported"),
    }))
  return AppProcess.Service.of({ ...spawner, run, runStream })
}
