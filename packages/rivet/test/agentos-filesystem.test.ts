import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { AgentOs } from "@rivet-dev/agentos-core"
import { Effect } from "effect"
import { make } from "../src/agentos-filesystem.ts"

test("adapts the live guest filesystem without mapping paths through the host", async () => {
  const host = await mkdtemp(join(tmpdir(), "opencode-agentos-filesystem-"))
  const workspace = join(host, "workspace")
  await mkdir(workspace)
  const vm = await AgentOs.create({
    database: { type: "sqlite_file", path: join(host, "vm.sqlite") },
    mounts: [{ path: "/workspace", plugin: { id: "host_dir", config: { hostPath: workspace } }, readOnly: false }],
  })
  try {
    const fs = make(vm.filesystem, "/workspace")
    await Effect.runPromise(fs.writeWithDirs("project/src/a.txt", "a"))
    await Effect.runPromise(fs.writeFileString("project/src/b.ts", "b"))
    assert.equal(await Effect.runPromise(fs.readFileString("/workspace/project/src/a.txt")), "a")
    assert.deepEqual(await Effect.runPromise(fs.readDirectory("project/src")), ["a.txt", "b.ts"])
    assert.deepEqual(await Effect.runPromise(fs.glob("**/*.ts", { cwd: "project", absolute: true })), [
      "/workspace/project/src/b.ts",
    ])
    await Effect.runPromise(fs.rename("project/src/a.txt", "project/src/moved.txt"))
    assert.equal(await Effect.runPromise(fs.readFileString("project/src/moved.txt")), "a")
    assert.deepEqual(await Effect.runPromise(fs.findUp("src", "/workspace/project/src")), ["/workspace/project/src"])
    await assert.rejects(Effect.runPromise(fs.readFile("/etc/passwd")))

    const missing = await Effect.runPromise(fs.readFile("missing.txt").pipe(Effect.flip))
    assert.equal(missing.reason._tag, "NotFound")
    assert.equal(await Effect.runPromise(fs.readFileStringSafe("missing.txt")), undefined)
    const denied = make(
      {
        ...vm.filesystem,
        readFile: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
      },
      "/workspace",
    )
    const permissionDenied = await Effect.runPromise(denied.readFile("project/src/b.ts").pipe(Effect.flip))
    assert.equal(permissionDenied.reason._tag, "PermissionDenied")
    const unavailable = make(
      {
        ...vm.filesystem,
        readFile: () => Promise.reject(new Error("sidecar transport unavailable")),
      },
      "/workspace",
    )
    await assert.rejects(Effect.runPromise(unavailable.readFileStringSafe("missing.txt")))

    await Effect.runPromise(fs.writeJson("mode.json", {}, 0o600))
    assert.equal((await vm.filesystem.stat("/workspace/mode.json")).mode & 0o777, 0o600)
    await Effect.runPromise(fs.writeWithDirs("mode/path.txt", "yes", 0o640))
    assert.equal((await vm.filesystem.stat("/workspace/mode/path.txt")).mode & 0o777, 0o640)

    const existing = await Effect.runPromise(
      fs.writeFileString("project/src/b.ts", "overwritten", { flag: "wx" }).pipe(Effect.flip),
    )
    assert.equal(existing.reason._tag, "AlreadyExists")
    assert.equal(await Effect.runPromise(fs.readFileString("project/src/b.ts")), "b")
    await Effect.runPromise(fs.writeFile("bytes.txt", new Uint8Array([1]), { mode: 0o600 }))
    assert.equal((await vm.filesystem.stat("/workspace/bytes.txt")).mode & 0o777, 0o600)
    await assert.rejects(Effect.runPromise(fs.writeFileString("append.txt", "no", { flag: "a" })))
    assert.equal(await vm.filesystem.exists("/workspace/append.txt"), false)
    const contenders = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        Effect.runPromise(fs.writeFileString("exclusive.txt", String(index), { flag: "wx", mode: 0o640 })),
      ),
    )
    assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1)
    assert.equal(contenders.filter((result) => result.status === "rejected").length, 15)
    const winner = await Effect.runPromise(fs.readFileString("exclusive.txt"))
    assert.match(winner, /^(?:[0-9]|1[0-5])$/)
    assert.equal((await vm.filesystem.stat("/workspace/exclusive.txt")).mode & 0o777, 0o640)
    await assert.rejects(Effect.runPromise(fs.writeFileString("exclusive.txt", "replacement", { flag: "wx" })))
    assert.equal(await Effect.runPromise(fs.readFileString("exclusive.txt")), winner)
    await Effect.runPromise(fs.remove("missing.txt", { force: true }))

    await symlink("project", join(workspace, "project-link"))
    assert.equal(await Effect.runPromise(fs.realPath("project-link")), "/workspace/project")
    await assert.rejects(Effect.runPromise(fs.copy("project-link", "copied-link")))
    assert.equal(await vm.filesystem.exists("/workspace/copied-link"), false)

    await symlink("/etc", join(workspace, "escape-link"))
    await assert.rejects(Effect.runPromise(fs.realPath("escape-link")))
    assert.throws(() => make(vm.filesystem, "/workspace/project"))
  } finally {
    await vm.dispose()
    await rm(host, { recursive: true, force: true })
  }
})
