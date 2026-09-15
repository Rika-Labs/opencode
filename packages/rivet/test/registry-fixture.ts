import { mkdtemp } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Client, Registry } from "@rivetkit/effect"
import { Effect, Layer, Result } from "effect"
import { layer, WorkspaceActor } from "../src/workspace-actor.ts"

export const storageDirectory = await mkdtemp(join(tmpdir(), "opencode-rivet-registry-"))
const registry = Registry.layer({ sqlite: "local", namespace: "default", noWelcome: true })
const actors = layer({ storageDirectory }).pipe(Layer.provideMerge(registry))
const client = Registry.test.pipe(Layer.provide(actors))

const readiness = Layer.effectDiscard(
  Effect.gen(function* () {
    const probe = (yield* Client.Client).makeActorAccessor(WorkspaceActor).getOrCreate(WorkspaceV2.ID.make("wrk_readiness"))
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = yield* probe.GetEnvironment().pipe(Effect.result)
      if (Result.isSuccess(result)) return
      const error = result.failure
      if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Rivet.WorkspaceActorError") return
      yield* Effect.sleep("100 millis")
    }
    yield* Effect.die(new globalThis.Error("rivet runner did not register within 10 seconds"))
  }),
)

export const registryRuntime = readiness.pipe(Layer.provideMerge(client))

process.on("exit", () => {
  rmSync(storageDirectory, { recursive: true, force: true })
})
