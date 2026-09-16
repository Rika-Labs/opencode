import assert from "node:assert/strict"
import { basename } from "node:path"
import { test } from "node:test"
import { Effect } from "effect"
import { WorkspaceActor } from "../../src/workspace-actor.ts"
import { actorProvider, registryRuntime, storageDirectory } from "../registry-fixture.ts"

const phase = process.env.OPENCODE_RIVET_RESUME_PHASE
// The actor key must be stable across phases; the fixture's storage directory is per-process,
// but the engine storage path (and therefore the durable actor identity) is shared.
const key = `${basename(process.env.RIVETKIT_STORAGE_PATH ?? storageDirectory)}-resume`

// Phase 1 and phase 2 run in separate processes against the same durable actor storage, with the
// engine restarted between them, so phase 2 must wake the actor from persisted state and reconnect
// the persisted workload identity.

if (phase === "1")
  test("resume phase 1 provisions a workspace and commits durable state", { timeout: 120_000 }, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = (yield* WorkspaceActor.client).getOrCreate(key)
          const environment = yield* actor.Initialize(actorProvider)
          assert.equal(environment.lifecycle, "running")
          const generation = (yield* actor.GetEnvironment()).generation
          yield* actor.Run({
            generation,
            command: "sh",
            args: ["-c", "printf resumed > marker.txt"],
            timeoutMs: 5_000,
            maxOutputBytes: 100,
          })
        }).pipe(Effect.provide(registryRuntime), Effect.timeout("60 seconds")),
      ),
    )
  })

if (phase === "2")
  test("resume phase 2 wakes the actor on a fresh engine and reconnects the persisted workload", { timeout: 120_000 }, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = (yield* WorkspaceActor.client).getOrCreate(key)
          const environment = yield* actor.GetEnvironment()
          assert.equal(environment.lifecycle, "running")
          assert.equal(environment.generation, 1)
          const result = yield* actor.Run({
            generation: environment.generation,
            command: "sh",
            args: ["-c", "cat marker.txt"],
            timeoutMs: 5_000,
            maxOutputBytes: 100,
          })
          assert.equal(result.stdout, "resumed")
          const stopped = yield* actor.Stop()
          assert.equal(stopped.lifecycle, "stopped")
        }).pipe(Effect.provide(registryRuntime), Effect.timeout("60 seconds")),
      ),
    )
  })
