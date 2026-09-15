import { mkdtemp } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "@rivetkit/effect"
import { Layer } from "effect"
import { layer } from "../src/workspace-actor.ts"

export const storageDirectory = await mkdtemp(join(tmpdir(), "opencode-rivet-registry-"))
const registry = Registry.layer({ sqlite: "local", namespace: "default", noWelcome: true })
const actors = layer({ storageDirectory }).pipe(Layer.provideMerge(registry))
export const registryRuntime = Registry.test.pipe(Layer.provide(actors))

process.on("exit", () => {
  rmSync(storageDirectory, { recursive: true, force: true })
})
