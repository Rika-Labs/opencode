import assert from "node:assert/strict"
import { readFile, readdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import { test } from "node:test"
import { Effect } from "effect"
import { WorkspaceActor } from "../../src/workspace-actor.ts"
import { registryRuntime, storageDirectory } from "../registry-fixture.ts"

test("real registry actions persist lifecycle, serialize commands, and isolate actors", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const accessor = yield* WorkspaceActor.client
        const one = accessor.getOrCreate(`${basename(storageDirectory)}-one`)
        const two = accessor.getOrCreate(`${basename(storageDirectory)}-two`)
        const existingActorDirectories = yield* Effect.promise(() =>
          readdir(join(storageDirectory, "actors")).catch(() => Array<string>()),
        )

        const initializedOne = yield* one.Initialize()
        assert.deepEqual(initializedOne, {
          backend: "agentos",
          generation: 1,
          lifecycle: "running",
        })
        const initializedTwo = yield* two.Initialize()
        assert.deepEqual(initializedTwo, {
          backend: "agentos",
          generation: 1,
          lifecycle: "running",
        })
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
          backend: "agentos",
          generation: 1,
          lifecycle: "running",
        })
        assert.deepEqual(yield* one.Stop(), {
          backend: "agentos",
          generation: 1,
          lifecycle: "stopped",
        })
        assert.deepEqual(yield* one.GetEnvironment(), {
          backend: "agentos",
          generation: 1,
          lifecycle: "stopped",
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

        const actorDirectories = yield* Effect.promise(() => readdir(join(storageDirectory, "actors")))
        const twoDirectory = yield* Effect.promise(async () => {
          const entries = await Promise.all(
            actorDirectories
              .filter((name) => !existingActorDirectories.includes(name))
              .map(async (name) => ({
                name,
                one: await readFile(
                  join(storageDirectory, "actors", name, "workspace", "generation-1", "order"),
                  "utf8",
                ).then(
                  () => true,
                  () => false,
                ),
              })),
          )
          return entries.find((entry) => !entry.one)!.name
        })
        yield* Effect.promise(() =>
          rm(join(storageDirectory, "actors", twoDirectory, "workspace", "generation-1"), {
            recursive: true,
            force: true,
          }),
        )
        const missing = yield* two.GetEnvironment().pipe(Effect.flip)
        assert.equal(missing._tag, "Rivet.WorkspaceActorError")
        assert.equal(missing.reason, "storage_missing")
        const recreate = yield* two.Initialize().pipe(Effect.flip)
        assert.equal(recreate._tag, "Rivet.WorkspaceActorError")
        assert.equal(recreate.reason, "storage_missing")
        assert.deepEqual(yield* two.Stop(), {
          backend: "agentos",
          generation: 1,
          lifecycle: "stopped",
        })
      }).pipe(Effect.provide(registryRuntime), Effect.timeout("25 seconds")),
    ),
  )

  const actorDirectories = await readdir(join(storageDirectory, "actors"))
  assert.ok(actorDirectories.length >= 2)
  assert.equal(
    (
      await Promise.all(
        actorDirectories.map((name) =>
          readFile(join(storageDirectory, "actors", name, "workspace", "generation-1", "order"), "utf8").catch(
            () => "",
          ),
        ),
      )
    ).filter(Boolean).length,
    1,
  )
})
