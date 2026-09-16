import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const selected = process.env.OPENCODE_RIVET_REGISTRY_CASE

if (selected === "actor-command") await import("./registry-cases/actor-command.ts")
if (selected === "actor-long-command") await import("./registry-cases/actor-long-command.ts")
if (selected === "provider") await import("./registry-cases/provider.ts")
if (selected === "resume") await import("./registry-cases/resume.ts")
if (selected === "workspace-actor") await import("./registry-cases/workspace-actor.ts")

if (!selected) {
  const cases = ["actor-long-command", "actor-command", "provider", "resume", "workspace-actor"]
    .filter((name) => !process.env.OPENCODE_RIVET_ONLY_CASE || name === process.env.OPENCODE_RIVET_ONLY_CASE)
  test("registry-backed suites run in isolated processes", { timeout: cases.length * (process.env.E2B_LIVE === "1" ? 110_000 : 60_000) }, async () => {
    assert(cases.length > 0, "no registry cases selected")
    for (const name of cases) {
      const enginePort = await availablePort()
      const runtimeDirectory = await mkdtemp(join(tmpdir(), "opencode-rivet-engine-"))
      const timeout = "110000"
      const args = process.versions.bun
        ? ["test", "--timeout", timeout, "test/registry.test.ts"]
        : ["--import", "tsx", "--test", "--test-force-exit", `--test-timeout=${timeout}`, import.meta.filename]
      const phases = name === "resume" ? ["1", "2"] : [undefined]
      let exit: number | null = null
      for (const [index, phase] of phases.entries()) {
        const child = spawn(process.execPath, args, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_TEST_CONTEXT: undefined,
            OPENCODE_RIVET_REGISTRY_CASE: name,
            OPENCODE_RIVET_RESUME_PHASE: phase,
            RIVETKIT_STORAGE_PATH: runtimeDirectory,
            RIVET_RUN_ENGINE: "1",
            RIVET_RUN_ENGINE_HOST: "127.0.0.1",
            RIVET_RUN_ENGINE_PORT: String(enginePort),
            RIVET_RUN_SERVICES: "0",
          },
          stdio: "inherit",
        })
        exit = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject)
          child.once("exit", resolve)
        })
        if (exit !== 0 || index < phases.length - 1) await stopEngine(runtimeDirectory)
        if (exit !== 0) break
      }
      await stopEngine(runtimeDirectory)
      await rm(runtimeDirectory, { recursive: true, force: true })
      assert.equal(exit, 0, `${name} registry case failed`)
    }
  })
}

async function stopEngine(runtimeDirectory: string) {
  const engines = process.platform === "linux" ? await procEngines(runtimeDirectory) : await lsofEngines(runtimeDirectory)
  engines.forEach((pid) => process.kill(pid, "SIGTERM"))
  for (let attempt = 0; attempt < 50 && engines.some(running); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  engines.filter(running).forEach((pid) => process.kill(pid, "SIGKILL"))
}

async function procEngines(runtimeDirectory: string) {
  const pids = (await readdir("/proc"))
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
  const matches = await Promise.all(
    pids.map(async (pid) => {
      const [environment, command] = await Promise.all([
        readFile(`/proc/${pid}/environ`, "utf8").catch(() => ""),
        readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
      ])
      return environment.split("\0").includes(`RIVETKIT_STORAGE_PATH=${runtimeDirectory}`) && command.includes("rivet-engine")
        ? pid
        : undefined
    }),
  )
  return matches.filter((pid) => pid !== undefined)
}

async function lsofEngines(runtimeDirectory: string) {
  const result = await promisify(execFile)("lsof", ["-nPt", "+D", runtimeDirectory]).catch(() => ({ stdout: "" }))
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
