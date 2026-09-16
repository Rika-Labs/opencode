import assert from "node:assert/strict"
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Backends } from "../src/backends.ts"
import { Local } from "../src/local.ts"

test("local workload attaches to a caller root and provisions a fresh one without", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-workload-test-"))
  try {
    const root = join(base, "attached")
    await mkdir(root)
    const attached = await Local.Workload.create({ root })
    assert.equal(attached.root, root)
    assert.match(attached.sandboxId, /^local-[a-zA-Z0-9-]+$/)
    assert.equal(attached.boundaryToken, undefined)

    const provisioned = await Local.Workload.create()
    assert.match(provisioned.root, /opencode-local-/)
    assert.notEqual(provisioned.sandboxId, attached.sandboxId)
    await provisioned.delete()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("local workload runs commands with args, cwd, env, exit codes, and timeout exit 124", async () => {
  const workload = await Local.Workload.create()
  try {
    const echo = await workload.run("printf", { args: ["%s-%s", "a", "b"] })
    assert.equal(echo.exitCode, 0)
    assert.equal(echo.stdout.toString(), "a-b")

    const failing = await workload.run("sh", { args: ["-c", "exit 7"] })
    assert.equal(failing.exitCode, 7)

    const cwd = await workload.run("sh", { args: ["-c", "pwd"], cwd: tmpdir() })
    assert.equal(cwd.stdout.toString(), `${tmpdir()}\n`)

    const env = await workload.run("sh", { args: ["-c", "echo $LOCAL_WORKLOAD_PROBE"], env: { LOCAL_WORKLOAD_PROBE: "seen" } })
    assert.equal(env.stdout.toString(), "seen\n")

    const missing = workload.run("sh", { args: ["-c", "exit 3"], cwd: "/definitely/not/here" })
    await assert.rejects(missing)

    const timeout = await workload.run("sleep", { args: ["10"], timeoutMs: 100 })
    assert.equal(timeout.exitCode, 124)
  } finally {
    await workload.delete()
  }
})

test("local workload export and import round-trips binary data, modes, and symlinks", async () => {
  const source = await Local.Workload.create()
  const destination = await Local.Workload.create()
  try {
    await writeFile(join(source.root, "binary.bin"), Buffer.from([0, 1, 255]))
    await chmod(join(source.root, "binary.bin"), 0o751)
    await symlink("binary.bin", join(source.root, "binary.link"))

    const archive = await source.exportWorkspace()
    await destination.importWorkspace(archive)

    assert.deepEqual(await readFile(join(destination.root, "binary.bin")), Buffer.from([0, 1, 255]))
    assert.equal((await lstat(join(destination.root, "binary.bin"))).mode & 0o777, 0o751)
    assert.equal(await readFile(join(destination.root, "binary.link"), "utf8"), Buffer.from([0, 1, 255]).toString())
  } finally {
    await source.delete()
    await destination.delete()
  }
})

test("local workload delete releases the identity but never touches workspace files", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-workload-test-"))
  try {
    const root = join(base, "kept")
    await mkdir(root)
    await writeFile(join(root, "keep.txt"), "kept")
    const workload = await Local.Workload.create({ root })
    const deleted: string[] = []
    await workload.delete(async (entry) => {
      deleted.push(`${entry.state}:${entry.sandboxId}`)
    })
    assert.deepEqual(deleted, [`deleted:${workload.sandboxId}`])
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "kept")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("local workload reconnect validates the identity and requires the root", async () => {
  const base = await mkdtemp(join(tmpdir(), "local-workload-test-"))
  try {
    const root = join(base, "root")
    await mkdir(root)
    const workload = await Local.Workload.create({ root })
    const reconnected = await Local.Workload.reconnect({ sandboxId: workload.sandboxId, root })
    assert.equal(reconnected.sandboxId, workload.sandboxId)

    await assert.rejects(Local.Workload.reconnect({ sandboxId: "../escape", root }), /invalid local sandbox ID/)
    await assert.rejects(Local.Workload.reconnect({ sandboxId: workload.sandboxId, root: join(base, "gone") }), /local workspace root is missing/)

    const provisioned = await Backends.create("local")
    assert.ok(provisioned.root)
    assert.match(provisioned.root, /opencode-local-/)
    await provisioned.delete()
    await assert.rejects(Backends.reconnect("local", { sandboxId: workload.sandboxId }), /Local workspace root is missing/)
    assert.equal(Backends.validate("local", { sandboxId: workload.sandboxId, root }), undefined)
    assert.equal(Backends.validate("local", { sandboxId: workload.sandboxId }), "Local workspace root is missing")
    assert.equal(Backends.validate("local", { sandboxId: workload.sandboxId, root: join(base, "gone") }), "Local workspace root no longer exists")
    assert.equal(Backends.validate("e2b", { root }), "E2B identity is missing")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("local workload stop terminates tracked children and pause keeps the identity", async () => {
  const workload = await Local.Workload.create()
  try {
    const sleeping = workload.run("sleep", { args: ["30"] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await workload.stop()
    const result = await sleeping
    assert.notEqual(result.exitCode, 0)
    const paused = await workload.pause()
    assert.equal(paused.sandboxId, workload.sandboxId)
  } finally {
    await workload.delete()
  }
})
