import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { Workload } from "../src/e2b.ts"

const enabled = process.env.E2B_LIVE === "1"
const journal = process.env.E2B_RESOURCE_JOURNAL ?? "/tmp/opencode-e2b-workloads.jsonl"
const execute = promisify(execFile)

test("E2B workload spawn, abort, rename, pause/reconnect, and stop", { timeout: 300_000, skip: enabled ? false : "set E2B_LIVE=1" }, async () => {
  let workload: Workload | undefined
  const record = (entry: object) => appendFile(journal, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  try {
    workload = await Workload.create({ timeoutMs: 180_000, metadata: { purpose: "disposable-bounded-workload-test" }, journal: record })
    const id = workload.sandboxId
    await assert.rejects(Workload.reconnect({ sandboxId: `${id};id` }), /invalid E2B sandbox ID/)
    await assert.rejects(Workload.create({ secure: false }), /secure controller authentication/)
    await assert.rejects(Workload.create({ envs: { POISON: "1" } }), /sandbox-global environment/)
    const identity = await workload.run("/usr/bin/id", { args: ["-u"] })
    assert.equal(identity.exitCode, 0, identity.stderr.toString())
    assert.equal(identity.stdout.toString().trim(), "1000")

    await workload.guestFiles.writeFile("/workspace/known.bin", Buffer.from([0, 1, ...Buffer.from("known-binary"), 255]))
    await workload.guestFiles.move("/workspace/known.bin", "/workspace/renamed.bin")
    assert.deepEqual(Buffer.from(await workload.guestFiles.readFile("/workspace/renamed.bin")), Buffer.from([0, 1, ...Buffer.from("known-binary"), 255]))
    assert.equal(await workload.guestFiles.realpath("/workspace/renamed.bin"), "/workspace/renamed.bin")

    const controller = new AbortController()
    const hung = workload.run("/bin/sleep", { args: ["30"], signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    await assert.rejects(hung)

    await workload.stop()
    await workload.stop()
    await assert.rejects(workload.run("/bin/true"), /stopped/)
    const archive = await workload.exportWorkspace()
    const directory = await mkdtemp(join(tmpdir(), "opencode-e2b-archive-"))
    try {
      await writeFile(join(directory, "workspace.tar"), archive)
      await execute("tar", ["-xf", join(directory, "workspace.tar"), "-C", directory])
      assert.deepEqual(await readFile(join(directory, "renamed.bin")), Buffer.from([0, 1, ...Buffer.from("known-binary"), 255]))
      assert.equal((await lstat(join(directory, "renamed.bin"))).isFile(), true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    await workload.delete(record)
    await assert.rejects(Workload.reconnect({ sandboxId: id, timeoutMs: 30_000 }))
    workload = undefined

    workload = await Workload.create({ timeoutMs: 180_000, metadata: { purpose: "disposable-bounded-workload-resume-test" }, journal: record })
    await workload.guestFiles.writeFile("/workspace/resume.bin", Buffer.from([7, 8, 9]))
    const paused = await workload.pause()
    workload = await Workload.reconnect({ sandboxId: paused.sandboxId, timeoutMs: 180_000 })
    assert.equal(workload.sandboxId, paused.sandboxId)
    assert.equal((await workload.run("/usr/bin/id", { args: ["-u"] })).stdout.toString().trim(), "1000")
    assert.deepEqual(Buffer.from(await workload.guestFiles.readFile("/workspace/resume.bin")), Buffer.from([7, 8, 9]))
    await workload.stop()
    await workload.stop()
  } finally {
    if (workload) {
      const id = workload.sandboxId
      await workload.delete(record)
      await assert.rejects(Workload.reconnect({ sandboxId: id, timeoutMs: 30_000 }))
    }
  }
})
