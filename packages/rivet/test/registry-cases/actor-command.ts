import assert from "node:assert/strict"
import { basename } from "node:path"
import { test } from "node:test"
import { Effect } from "effect"
import { WorkspaceActor } from "../../src/workspace-actor.ts"
import { actorProvider, registryRuntime, storageDirectory } from "../registry-fixture.ts"

const command = (script: string) => ({
  command: "sh",
  args: ["-c", script],
  timeoutMs: 5_000,
  maxOutputBytes: 1_000,
})

test("command lifecycle reconciles identity, cancellation, status, and output", {
  timeout: 300_000,
}, async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const actor = (yield* WorkspaceActor.client).getOrCreate(`${basename(storageDirectory)}-command`)
        const environment = yield* actor.Initialize(actorProvider)
        assert.equal(environment.generation, 1)
        const generation = (yield* actor.GetEnvironment()).generation
        const epoch = yield* actor.CommandEpoch({ generation })

        const staleGeneration = yield* actor
          .Run({
            generation: generation - 1,
            command: "printf",
            args: ["stale"],
            timeoutMs: 5_000,
            maxOutputBytes: 100,
          })
          .pipe(Effect.flip)
        assert.equal(staleGeneration.reason, "stale_generation")

        const unknown = yield* actor.CommandStatus({ id: "unknown", epoch }).pipe(Effect.flip)
        assert.equal(unknown.reason, "unknown_command")

        const stale = yield* actor
          .StartCommand({ id: "stale", epoch: "previous-wake", command: command("touch stale") })
          .pipe(Effect.flip)
        assert.equal(stale.reason, "unknown_command")
        yield* actor.CancelCommand({ id: "before", epoch })
        const rejected = yield* actor
          .StartCommand({ id: "before", epoch, command: command("touch should-not-exist") })
          .pipe(Effect.flip)
        assert.equal(rejected.reason, "command_conflict")

        const slow = command("sleep 1.5; printf late > cancelled")
        assert.deepEqual(yield* actor.StartCommand({ id: "cancel", epoch, command: slow }), { id: "cancel" })
        assert.deepEqual(yield* actor.StartCommand({ id: "cancel", epoch, command: slow }), { id: "cancel" })
        const conflict = yield* actor
          .StartCommand({ id: "cancel", epoch, command: command("printf different") })
          .pipe(Effect.flip)
        assert.equal(conflict.reason, "command_conflict")
        yield* actor.CancelCommand({ id: "cancel", epoch })
        yield* Effect.sleep("500 millis")
        assert.equal((yield* actor.CommandStatus({ id: "cancel", epoch })).status, "cancelled")
        // Wait past the guest write deadline so a failed kill cannot hide behind the test ending early.
        yield* Effect.sleep("2 seconds")
        assert.equal(
          (yield* actor.Run({
            generation,
            command: "sh",
            args: ["-c", "test ! -e cancelled"],
            timeoutMs: 5_000,
            maxOutputBytes: 100,
          })).exitCode,
          0,
        )

        yield* actor.StartCommand({ id: "responsive", epoch, command: command("sleep 5; printf leaked > responsive") })
        const queuedFilesystem = actor
          .Filesystem({ generation, request: { type: "read", path: "/workspace/missing" } })
          .pipe(Effect.exit, Effect.forkChild)
        yield* queuedFilesystem
        assert.equal((yield* actor.CommandStatus({ id: "responsive", epoch })).status, "running")
        yield* actor.CancelCommand({ id: "responsive", epoch }).pipe(Effect.timeout("3 seconds"))
        assert.equal((yield* actor.CommandStatus({ id: "responsive", epoch })).status, "cancelled")

        const oversized = yield* actor
          .Filesystem({
            generation,
            request: { type: "write", path: "/workspace/oversized", data: "A".repeat(1_398_105) },
          })
          .pipe(Effect.flip)
        assert.match(String(oversized), /Incoming message too long/)

        yield* actor.StartCommand({ id: "output", epoch, command: command("printf one; printf two >&2; printf three") })
        const status = yield* Effect.gen(function* () {
          while (true) {
            const current = yield* actor.CommandStatus({ id: "output", epoch })
            if (current.status !== "running") return current
            yield* Effect.sleep("20 millis")
          }
        })
        assert.equal(status.status, "completed")
        if (status.status === "completed") {
          assert.equal(status.result.stdout, "onethree")
          assert.equal(status.result.stderr, "two")
          // Cross-stream interleaving is scheduler-dependent; the merge must contain both streams in full.
          assert.deepEqual([...status.result.output].sort(), [..."onetwothree"].sort())
        }
        const files = yield* actor.Run({
          generation,
          command: "sh",
          args: ["-c", "test ! -e should-not-exist && test ! -e cancelled && test ! -e stale"],
          timeoutMs: 5_000,
          maxOutputBytes: 100,
        })
        assert.equal(files.exitCode, 0)
        yield* actor.Stop()
      }).pipe(Effect.provide(registryRuntime), Effect.timeout("20 seconds")),
    ),
  )
})
