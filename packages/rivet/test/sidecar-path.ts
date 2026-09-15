import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export function sidecarPath() {
  const require = createRequire(fileURLToPath(import.meta.resolve("@rivet-dev/agentos-core")))
  const resolver = require("@rivet-dev/agentos-sidecar") as { getSidecarPath(): string }
  const path = resolver.getSidecarPath()
  assert(path, "native agentOS sidecar is not resolvable")
  return path
}
