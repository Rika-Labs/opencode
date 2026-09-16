import { readdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"

const tests = (await readdir("dist/node-test"))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => `dist/node-test/${file}`)
assert(tests.length > 0, "no bundled Node tests found; run build:test:node first")
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-timeout=180000", ...tests], {
  stdio: "inherit",
})
const exit = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", resolve)
})

process.exit(exit ?? 1)
