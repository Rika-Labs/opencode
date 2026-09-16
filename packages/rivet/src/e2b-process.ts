export * as E2BProcess from "./e2b-process"

import { Effect, Fiber, PlatformError, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Sandbox, SandboxCommand } from "effect-sandbox"
import type { ProcessSignals } from "effect-sandbox/capabilities/ProcessSignals"
import type { WorkspaceDriver } from "@opencode/core/workspace/driver"

export type Guard = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | WorkspaceDriver.Error, R>

export function make(sandbox: Sandbox.Service, signals: ProcessSignals["Service"], guard: Guard) {
  const error = (method: string, cause: unknown) => PlatformError.systemError({
    _tag: "Unknown", module: "ChildProcess", method, cause,
  })
  return ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (command._tag !== "StandardCommand")
      return yield* Effect.fail(error("spawn", "Remote piped commands are unsupported"))
    if (command.options.additionalFds || command.options.extendEnv || command.options.stdin !== undefined)
      return yield* Effect.fail(error("spawn", "Inherited environment, stdin and additional descriptors are unsupported"))
    const shell = command.options.shell
    const executable = shell ? typeof shell === "string" ? shell : "/bin/sh" : command.command
    const args = shell ? ["-c", [command.command, ...command.args.map(SandboxCommand.quotePosix)].join(" ")] : command.args
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(command.options.env ?? {})) {
      if (value === undefined)
        return yield* Effect.fail(error("spawn", "Unsetting remote environment variables is unsupported"))
      environment[key] = value
    }
    const process = yield* guard(sandbox.spawn(SandboxCommand.make(executable, args, {
      cwd: command.options.cwd,
      environment,
    }))).pipe(Effect.mapError((cause) => error("spawn", cause)))
    const completion = yield* process.awaitResult.pipe(
      Effect.mapError((cause) => error("exitCode", cause)), Effect.forkScoped,
    )
    const output = process.output.pipe(Stream.mapError((cause) => error("output", cause)))
    const unsupportedInput = Sink.fail(error("stdin", "E2B stdin is unsupported"))
    return ChildProcessSpawner.makeHandle({
      // effect-sandbox exposes an opaque process ID, not a local OS PID.
      pid: ChildProcessSpawner.ProcessId(0),
      exitCode: Fiber.join(completion).pipe(Effect.flatMap((result) => result.termination._tag === "Exited"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(result.termination.code))
        : Effect.fail(error("exitCode", `Process terminated by ${result.termination.signal}`)))),
      isRunning: Effect.sync(() => completion.pollUnsafe() === undefined),
      kill: (options) => {
        const signal = options?.killSignal ?? "SIGTERM"
        if (signal !== "SIGTERM" && signal !== "SIGKILL" && signal !== "SIGINT")
          return Effect.fail(error("kill", `Unsupported signal ${signal}`))
        return guard(signals.send(process.id, signal)).pipe(Effect.mapError((cause) => error("kill", cause)))
      },
      stdin: unsupportedInput,
      stdout: output.pipe(Stream.filter((chunk) => chunk.channel === "stdout"), Stream.map((chunk) => chunk.bytes)),
      stderr: output.pipe(Stream.filter((chunk) => chunk.channel === "stderr"), Stream.map((chunk) => chunk.bytes)),
      all: output.pipe(Stream.map((chunk) => chunk.bytes)),
      getInputFd: () => unsupportedInput,
      getOutputFd: () => Stream.fail(error("fd", "Additional descriptors are unsupported")),
      unref: Effect.fail(error("unref", "Remote process scope cannot be detached")),
    })
  }))
}
