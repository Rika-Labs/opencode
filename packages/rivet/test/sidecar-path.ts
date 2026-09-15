import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export function sidecarPath() {
  const require = createRequire(fileURLToPath(import.meta.resolve("@rikalabs/agentos-core")))
  const resolver = require("@rikalabs/agentos-sidecar") as { getSidecarPath(): string }
  const path = resolver.getSidecarPath()
  assert(path, "native agentOS sidecar is not resolvable")
  return path
}
