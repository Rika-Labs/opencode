import { describe, expect, test } from "bun:test"
import { Workspace } from "@opencode/schema/workspace"
import { Effect, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { E2BWorkspace } from "../src/e2b-workspace.ts"

const live = process.env.E2B_LIVE === "1"

describe.skipIf(!live)("E2BWorkspace live qualification", () => {
  test(
    "direct driver runs files and processes on a real sandbox",
    async () => {
      let cleanupCompleted = false

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const cleanup = yield* Effect.scope
            const mutex = Semaphore.makeUnsafe(1)
            const driver = yield* E2BWorkspace.create({
              namespace: "opencode-rivet-live",
              timeoutMs: 180_000,
              exclusive: (_, effect) => mutex.withPermits(1)(effect),
            })
            const workspaceID = Workspace.ID.create()
            const created = yield* driver.create({ workspaceID })
            yield* Scope.addFinalizer(
              cleanup,
              driver
                .destroy({ workspaceID, binding: created.binding })
                .pipe(
                  Effect.tap(() => Effect.sync(() => (cleanupCompleted = true))),
                  Effect.orDie,
                ),
            )
            const connect = () =>
              driver.connect({ workspaceID, binding: created.binding, saveBinding: () => Effect.void })

            yield* Effect.scoped(
              Effect.gen(function* () {
                const environment = yield* connect()
                const files = environment.overrides
                yield* files.write("/workspace/live.bin", new Uint8Array([0, 1, 255]))
                const back = yield* files.read("/workspace/live.bin")
                expect(back.bytes).toEqual(new Uint8Array([0, 1, 255]))
                expect(back.info.type).toBe("file")

                const handle = yield* environment.spawner.spawn(ChildProcess.make("printf", ["live-bytes"]))
                const chunks = yield* Stream.runCollect(handle.stdout)
                const flat = chunks.flatMap((chunk) => [...chunk])
                expect(new TextDecoder().decode(new Uint8Array(flat))).toBe("live-bytes")

                const shell = yield* environment.spawner.spawn(ChildProcess.make("sh", ["-c", "exit 3"]))
                const shellCode = yield* shell.exitCode
                expect(shellCode).toBe(3)

                const hung = yield* environment.spawner.spawn(ChildProcess.make("sleep", ["30"]))
                yield* hung.kill({ killSignal: "SIGKILL" })
                const killed = yield* hung.exitCode.pipe(Effect.exit, Effect.timeout("30 seconds"))
                expect(killed._tag).toBe("Success")
                expect(yield* hung.isRunning).toBe(false)
              }),
            )

            yield* driver.suspendForIdle({
              workspaceID,
              binding: created.binding,
              saveBinding: () => Effect.void,
            })

            yield* Effect.scoped(
              Effect.gen(function* () {
                const environment = yield* connect()
                const back = yield* environment.overrides.read("/workspace/live.bin")
                expect(back.bytes).toEqual(new Uint8Array([0, 1, 255]))
              }),
            )
          }).pipe(Effect.timeout("90 seconds")),
        ),
      )
      expect(cleanupCompleted).toBe(true)
    },
    120_000,
  )
})
