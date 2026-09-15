import assert from "node:assert/strict"
import { appendFile } from "node:fs/promises"
import { test } from "node:test"
import { NotFoundError, Sandbox } from "@e2b/code-interpreter"
import { Client } from "@rivetkit/effect"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Rivet } from "../../src/provider.ts"
import { WorkspaceActor } from "../../src/workspace-actor.ts"
import { registryRuntime } from "../registry-fixture.ts"

test("actor migration preserves workspace data and fences both retired generations", {
  timeout: 300_000,
  skip: process.env.E2B_LIVE === "1" ? false : "set E2B_LIVE=1",
}, async () => {
  const resources = new Set<string>()
  const journal = process.env.E2B_RESOURCE_JOURNAL ?? "/tmp/opencode-rivet-migration.jsonl"
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const client = yield* Client.Client
      const provider = Rivet.make(client)
      const workspace = yield* provider.create({ name: "migration", environment: { type: "agentos" } })
      const actor = client.makeActorAccessor(WorkspaceActor).getOrCreate(workspace.id)
      const original = yield* provider.bind(workspace.location)
      const binary = new Uint8Array([0, 127, 255, 13, 10, 42])
      yield* original.filesystem.makeDirectory(".git/objects", { recursive: true })
      yield* original.filesystem.writeFile(".git/objects/fixture", binary, { mode: 0o751 })
      const linked = yield* original.process.run(ChildProcess.make("sh", ["-c", "ln -s .git/objects/fixture binary.link"]))
      assert.equal(linked.exitCode, 0)
      const wait = (requestID: string) => Effect.gen(function* () {
        for (let attempt = 0; attempt < 1_000; attempt++) {
          const state = yield* actor.PromotionStatus({ requestID })
          if (state.status !== "idle" && state.sandboxID && !resources.has(state.sandboxID)) {
            resources.add(state.sandboxID)
            yield* Effect.promise(() => appendFile(journal, `${JSON.stringify({ id: state.sandboxID, requestID, state: "observed" })}\n`, { mode: 0o600 }))
          }
          if (state.status === "failed") assert.fail(state.message)
          if (state.status === "completed" && state.cleanup !== "pending") {
            assert.equal(state.cleanup, "complete", state.cleanupMessage)
            return state
          }
          yield* Effect.sleep("250 millis")
        }
        return assert.fail("migration did not reach terminal status")
      })
      const outward = { workspaceID: workspace.id, requestID: "outward", target: { type: "sandbox" as const, provider: "e2b" } }
      yield* provider.promote(outward)
      const promoted = yield* wait("outward")
      assert.equal(promoted.generation, 2)
      const sandbox = yield* provider.bind(workspace.location)
      assert.deepEqual(Array.from(yield* sandbox.filesystem.readFile(".git/objects/fixture")), Array.from(binary))
      assert.equal((yield* sandbox.filesystem.stat(".git/objects/fixture")).mode & 0o777, 0o751)
      assert.equal(yield* sandbox.filesystem.realPath("binary.link"), "/workspace/.git/objects/fixture")
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(original.filesystem.writeFileString("stale", "bad")), /stale/i))
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(original.process.run(ChildProcess.make("touch", ["stale-process"]))), /stale/i))
      yield* sandbox.filesystem.writeFileString("native.txt", "created in full sandbox")
      yield* provider.promote({ workspaceID: workspace.id, requestID: "return", target: { type: "agentos" } })
      const returned = yield* wait("return")
      assert.equal(returned.generation, 3)
      const restored = yield* provider.bind(workspace.location)
      assert.deepEqual(Array.from(yield* restored.filesystem.readFile(".git/objects/fixture")), Array.from(binary))
      assert.equal(yield* restored.filesystem.readFileString("native.txt"), "created in full sandbox")
      assert.equal((yield* restored.filesystem.stat(".git/objects/fixture")).mode & 0o777, 0o751)
      assert.equal(yield* restored.filesystem.realPath("binary.link"), "/workspace/.git/objects/fixture")
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(sandbox.filesystem.writeFileString("stale", "bad")), /stale/i))
      assert.equal((yield* provider.promote(outward)).status, "completed")
      assert.equal((yield* provider.environment({ workspaceID: workspace.id })).generation, 3)
      const conflict = yield* actor.BeginPromotion({ requestID: "outward", target: "agentos" }).pipe(Effect.flip)
      assert.equal(conflict.reason, "promotion_conflict")
      yield* actor.Stop()
    }).pipe(Effect.provide(registryRuntime), Effect.scoped))
  } finally {
    for (const id of resources) {
      await Sandbox.kill(id)
      await assert.rejects(Sandbox.getInfo(id), NotFoundError)
      await appendFile(journal, `${JSON.stringify({ id, state: "deleted" })}\n`, { mode: 0o600 })
    }
  }
})
