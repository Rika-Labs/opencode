import assert from "node:assert/strict"
import { mkdtemp, mkdir, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Effect } from "effect"
import { make, type Filesystem } from "../src/actor-filesystem.ts"

// The adapter contract passes guest-absolute paths through; map them onto a scratch host directory.
const local = (root: string): Filesystem => {
  const host = (path: string) => join(root, path.replace(/^\/workspace\/?/, ""))
  return {
  readFile: async (path) => {
    const { readFile } = await import("node:fs/promises")
    return readFile(host(path))
  },
  writeFile: async (path, data, options) => {
    const { open } = await import("node:fs/promises")
    const handle = await open(host(path), options?.flag === "wx" ? "wx" : "w", options?.mode)
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
  },
  stat: async (path) => {
    const { lstat } = await import("node:fs/promises")
    const info = await lstat(host(path))
    return {
      isSymbolicLink: info.isSymbolicLink(),
      isDirectory: info.isDirectory(),
      mtimeMs: info.mtimeMs,
      atimeMs: info.atimeMs,
      ctimeMs: info.ctimeMs,
      birthtimeMs: info.birthtimeMs,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      nlink: info.nlink,
      uid: info.uid,
      gid: info.gid,
      rdev: info.rdev,
      size: info.size,
      blocks: info.blocks,
    }
  },
  mkdir: async (path, options) => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(host(path), { recursive: options?.recursive })
  },
  readdir: async (path) => {
    const { readdir } = await import("node:fs/promises")
    return readdir(host(path)).then((names) => names.sort())
  },
  readdirEntries: async (path) => {
    const { readdir } = await import("node:fs/promises")
    return readdir(host(path), { withFileTypes: true }).then((entries) => entries.map((entry) => ({
      name: entry.name,
      isSymbolicLink: entry.isSymbolicLink(),
      isDirectory: entry.isDirectory(),
    })))
  },
  readdirRecursive: async (path) => {
    const { readdir } = await import("node:fs/promises")
    const entries: { path: string; type: string }[] = []
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name)
        entries.push({ path: full, type: entry.isDirectory() ? "directory" : "file" })
        if (entry.isDirectory()) await walk(full)
      }
    }
    await walk(host(path))
    return entries.map((entry) => ({ ...entry, path: `/${join("workspace", entry.path.slice(root.length + 1))}` }))
  },
  exists: (path) => Promise.resolve(existsSync(host(path))),
  remove: async (path, options) => {
    const { rm } = await import("node:fs/promises")
    await rm(host(path), { recursive: options?.recursive })
  },
  move: async (from, to) => {
    const { rename } = await import("node:fs/promises")
    await rename(host(from), host(to))
  },
  realpath: async (path) => {
    const { realpath } = await import("node:fs/promises")
    return realpath(host(path)).then((resolved) => `/${join("workspace", resolved.slice(root.length + 1))}`)
  },
  }
}

test("adapts a real filesystem workspace without mapping paths through the host", async () => {
  const host = await mkdtemp(join(tmpdir(), "opencode-actor-filesystem-"))
  await mkdir(join(host, "workspace"))
  const fs = make(local(join(host, "workspace")), "/workspace")
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
      ...local(join(host, "workspace")),
      readFile: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
    },
    "/workspace",
  )
  const failure = await Effect.runPromise(denied.readFile("project/src/b.ts").pipe(Effect.flip))
  assert.equal(failure.reason._tag, "PermissionDenied")

  const exclusive = await Effect.runPromise(fs.writeFileString("project/src/b.ts", "c", { flag: "wx" }).pipe(Effect.flip))
  assert.equal(exclusive.reason._tag, "AlreadyExists")

  await symlink("b.ts", join(host, "workspace/project/src/link.ts"))
  const links = await Effect.runPromise(fs.readDirectoryEntries("project/src"))
  assert.deepEqual(links.find((entry) => entry.name === "link.ts"), { name: "link.ts", type: "symlink" })
})
