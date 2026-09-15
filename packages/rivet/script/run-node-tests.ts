import { readdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import { join } from "node:path"

const tests = (await readdir("dist/node-test"))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => `dist/node-test/${file}`)
assert(tests.length > 0, "no bundled Node tests found; run build:test:node first")
const modules = join(process.cwd(), "../..", "node_modules/.bun")
const sidecar = (await readdir(modules)).find((name) => name.startsWith("@rivet-dev+agentos-sidecar-linux-x64-gnu@"))
assert(sidecar, "native AgentOS sidecar is not installed")
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-timeout=180000", ...tests], {
  env: {
    ...process.env,
    AGENTOS_SIDECAR_BIN: join(modules, sidecar, "node_modules/@rivet-dev/agentos-sidecar-linux-x64-gnu/agentos-sidecar"),
  },
  stdio: "inherit",
})
const exit = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", resolve)
})

process.exit(exit ?? 1)
