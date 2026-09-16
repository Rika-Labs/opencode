import assert from "node:assert/strict"
import { basename } from "node:path"
import { test } from "node:test"
import { Effect } from "effect"
import { WorkspaceActor } from "../../src/workspace-actor.ts"
import { actorProvider, live, registryRuntime, storageDirectory } from "../registry-fixture.ts"

test("real registry actions persist lifecycle, serialize commands, and isolate actors", {
  timeout: 300_000,
}, async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const accessor = yield* WorkspaceActor.client
        const one = accessor.getOrCreate(`${basename(storageDirectory)}-one`)
        const two = accessor.getOrCreate(`${basename(storageDirectory)}-two`)

        const initializedOne = yield* one.Initialize(actorProvider)
        assert.equal(initializedOne.backend, actorProvider.provider)
        assert.equal(initializedOne.generation, 1)
        assert.equal(initializedOne.lifecycle, "running")
        const rootOne = initializedOne.root
        const initializedTwo = yield* two.Initialize(actorProvider)
        assert.equal(initializedTwo.backend, actorProvider.provider)
        assert.equal(initializedTwo.generation, 1)
        const generationOne = (yield* one.GetEnvironment()).generation
        const generationTwo = (yield* two.GetEnvironment()).generation

        const first = one.Run({
          generation: generationOne,
          command: "sh",
          args: ["-c", "printf Astart >> order; sleep 0.2; printf Aend >> order"],
          timeoutMs: 5000,
          maxOutputBytes: 100,
        })
        const second = one.Run({
          generation: generationOne,
          command: "sh",
          args: ["-c", "printf Bstart >> order; sleep 0.1; printf Bend >> order"],
          timeoutMs: 5000,
          maxOutputBytes: 100,
        })
        const results = yield* Effect.all([first, second], { concurrency: "unbounded" })
        assert.deepEqual(
          results.map((result) => result.exitCode),
          [0, 0],
        )
        const order = (yield* one.Run({
          generation: generationOne,
          command: "cat",
          args: ["order"],
          timeoutMs: 5000,
          maxOutputBytes: 100,
        })).stdout
        assert.ok(["AstartAendBstartBend", "BstartBendAstartAend"].includes(order), order)
        assert.notEqual(
          (yield* two.Run({
            generation: generationTwo,
            command: "sh",
            args: ["-c", "test -e order"],
            timeoutMs: 5000,
            maxOutputBytes: 100,
          })).exitCode,
          0,
        )

        assert.deepEqual(yield* one.GetEnvironment(), {
          backend: actorProvider.provider,
          generation: 1,
          lifecycle: "running",
          root: live ? undefined : rootOne,
        })
        assert.deepEqual(yield* one.Stop(), {
          backend: actorProvider.provider,
          generation: 1,
          lifecycle: "stopped",
          root: live ? undefined : rootOne,
        })
        assert.deepEqual(yield* one.GetEnvironment(), {
          backend: actorProvider.provider,
          generation: 1,
          lifecycle: "stopped",
          root: live ? undefined : rootOne,
        })
        const stopped = yield* one
          .Run({ generation: generationOne, command: "printf", args: ["no"], timeoutMs: 1000, maxOutputBytes: 100 })
          .pipe(Effect.flip)
        assert.equal(stopped._tag, "Rivet.WorkspaceActorError")
        assert.equal(stopped.reason, "stopped")

        assert.equal(
          (yield* two.Run({
            generation: generationTwo,
            command: "printf",
            args: ["alive"],
            timeoutMs: 5000,
            maxOutputBytes: 100,
          })).stdout,
          "alive",
        )

        assert.equal(
          (yield* two.Run({
            generation: generationTwo,
            command: "printf",
            args: ["bounded direct run"],
            timeoutMs: 50_000,
            maxOutputBytes: 100,
          })).stdout,
          "bounded direct run",
        )
        const excessiveTimeout = yield* two
          .Run({ generation: generationTwo, command: "printf", args: ["late"], timeoutMs: 50_001, maxOutputBytes: 100 })
          .pipe(Effect.flip)
        assert.equal(excessiveTimeout._tag, "Rivet.WorkspaceActorError")
        assert.equal(excessiveTimeout.reason, "environment_failed")

        yield* two.Stop()
      }).pipe(Effect.provide(registryRuntime), Effect.timeout("120 seconds")),
    ),
  )
})
