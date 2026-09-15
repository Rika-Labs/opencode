import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const modules = join(import.meta.dirname, "../../..", "node_modules/.bun")
const sidecar = (await readdir(modules)).find((name) => name.startsWith("@rivet-dev+agentos-sidecar-linux-x64-gnu@"))
assert(sidecar, "native AgentOS sidecar is not installed")
process.env.AGENTOS_SIDECAR_BIN = join(
  modules,
  sidecar,
  "node_modules/@rivet-dev/agentos-sidecar-linux-x64-gnu/agentos-sidecar",
)
