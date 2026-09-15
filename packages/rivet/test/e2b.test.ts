import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { NotFoundError, Sandbox } from "@e2b/code-interpreter"
import { Workload } from "../src/e2b.ts"

const enabled = process.env.E2B_LIVE === "1"
const journal = process.env.E2B_RESOURCE_JOURNAL ?? "/tmp/opencode-e2b-workloads.jsonl"
const execute = promisify(execFile)

test("E2B cgroup fences detached work across stop and pause", { timeout: 300_000, skip: enabled ? false : "set E2B_LIVE=1" }, async () => {
  let workload: Workload | undefined
  const record = (entry: object) => appendFile(journal, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  try {
    workload = await Workload.create({ timeoutMs: 180_000, metadata: { purpose: "disposable-bounded-workload-test" }, journal: record })
    const id = workload.sandboxId
    const token = workload.boundaryToken
    await assert.rejects(Workload.reconnect({ sandboxId: `${id};id`, boundaryToken: token }), /invalid E2B sandbox ID/)
    await assert.rejects(Workload.reconnect({ sandboxId: id, boundaryToken: `${token};id` }), /invalid workload boundary token/)
    await assert.rejects(Workload.create({ secure: false }), /secure controller authentication/)
    await assert.rejects(Workload.create({ envs: { POISON: "1" } }), /sandbox-global environment/)
    const privileges = await workload.run("/bin/sh", {
      args: ["-c", "grep -E '^(NoNewPrivs|Cap(Inh|Prm|Eff|Amb)):' /proc/self/status; if sudo -n id -u >/tmp/sudo-root 2>&1; then exit 95; fi; ! sh -c 'echo $$ > /sys/fs/cgroup/cgroup.procs'"],
    })
    assert.equal(privileges.exitCode, 0, privileges.stderr)
    assert.match(privileges.stdout, /NoNewPrivs:\s+1/)
    assert.match(privileges.stdout, /CapInh:\s+0{16}/)
    assert.match(privileges.stdout, /CapPrm:\s+0{16}/)
    assert.match(privileges.stdout, /CapEff:\s+0{16}/)
    assert.match(privileges.stdout, /CapAmb:\s+0{16}/)
    await workload.run("/bin/sh", { args: ["-c", "printf '\\0\\1known-binary\\377' > /workspace/known.bin; chmod 751 /workspace/known.bin; ln -s known.bin /workspace/known.link"] })
    const writer = await workload.run("/bin/sh", { args: ["-c", "while :; do date +%s%N >> /workspace/writes; sleep .05; done </dev/null >/dev/null 2>&1 &"] })
    assert.equal(writer.exitCode, 0, writer.stderr)
    const sandbox = await Sandbox.connect(id, { timeoutMs: 30_000 })
    const stale = await Workload.reconnect({ sandboxId: id, boundaryToken: token, timeoutMs: 30_000 })
    const exporter = await sandbox.commands.run("while :; do date +%s%N >> /tmp/exporter-alive; sleep .05; done", { user: "user", background: true, timeoutMs: 0 })
    await sandbox.commands.run(`printf '%s\n' 'while :; do echo escaped >> /workspace/profile-escape; sleep .05; done &' > /home/user/.bash_profile; ln -s /workspace/known.bin /tmp/opencode-workspace-${token}.tar`, { user: "user" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const races = Array.from({ length: 20 }, (_, index) =>
      workload!.run("/bin/sh", { args: ["-c", `sleep .1; echo ${index} >> /workspace/late-marker`] }).catch((error) => error),
    )
    await Promise.all([workload.stop(), ...races])
    await workload.stop()
    const before = await sandbox.files.read("/workspace/writes")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await sandbox.files.read("/workspace/writes"), before)
    assert.equal((await sandbox.commands.list()).some((process) => process.pid === exporter.pid), true)
    await assert.rejects(stale.run("/bin/true"), /stopped/)
    const archive = await workload.exportWorkspace()
    const directory = await mkdtemp(join(tmpdir(), "opencode-e2b-archive-"))
    try {
      await writeFile(join(directory, "workspace.tar"), archive)
      await execute("tar", ["-xf", join(directory, "workspace.tar"), "-C", directory])
      assert.deepEqual(await readFile(join(directory, "known.bin")), Buffer.from([0, 1, ...Buffer.from("known-binary"), 255]))
      assert.equal((await lstat(join(directory, "known.bin"))).mode & 0o777, 0o751)
      assert.equal((await lstat(join(directory, "known.link"))).isSymbolicLink(), true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    assert.deepEqual(await sandbox.files.read(`/tmp/opencode-workspace-${token}.tar`, { format: "bytes" }), Buffer.from([0, 1, ...Buffer.from("known-binary"), 255]))
    assert.equal(await sandbox.files.exists("/workspace/profile-escape"), false)
    const lateMarker = (await sandbox.files.exists("/workspace/late-marker")) ? await sandbox.files.read("/workspace/late-marker") : ""
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await sandbox.files.exists("/workspace/late-marker")) ? await sandbox.files.read("/workspace/late-marker") : "", lateMarker)
    await assert.rejects(workload.run("/bin/true"), /stopped/)
    await assert.rejects(Workload.reconnect({ sandboxId: id, boundaryToken: token, timeoutMs: 30_000 }), /missing or stale/)
    await sandbox.commands.kill(exporter.pid)
    await workload.delete(record)
    await assert.rejects(Sandbox.connect(id, { timeoutMs: 30_000 }), NotFoundError)
    workload = undefined

    workload = await Workload.create({ timeoutMs: 180_000, metadata: { purpose: "disposable-bounded-workload-resume-test" }, journal: record })
    const paused = await workload.pause()
    workload = await Workload.reconnect({ sandboxId: paused.sandboxId, boundaryToken: paused.boundaryToken, timeoutMs: 180_000 })
    assert.equal(workload.sandboxId, paused.sandboxId)
    assert.equal(workload.boundaryToken, paused.boundaryToken)
    assert.equal((await workload.run("/usr/bin/id", { args: ["-u"] })).stdout.trim(), "1000")
    await workload.run("/bin/sh", { args: ["-c", "while :; do date +%s%N >> /workspace/timeout-sibling; sleep .05; done </dev/null >/dev/null 2>&1 &"] })
    const timeout = await workload.run("/bin/sleep", { args: ["10"], timeoutMs: 100 })
    assert.equal(timeout.exitCode, 124)
    const timeoutSandbox = await Sandbox.connect(workload.sandboxId, { timeoutMs: 30_000 })
    const timeoutBefore = await timeoutSandbox.files.read("/workspace/timeout-sibling")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await timeoutSandbox.files.read("/workspace/timeout-sibling"), timeoutBefore)
    await assert.rejects(workload.run("/bin/true"), /stopped/)
    await workload.stop()
    await workload.stop()
  } finally {
    if (workload) {
      const id = workload.sandboxId
      await workload.delete(record)
      await assert.rejects(Sandbox.connect(id, { timeoutMs: 30_000 }), NotFoundError)
    }
  }
})
