export * as SandboxEnvironment from "./sandbox-environment.ts"

import { ActorFilesystem, type Filesystem, type FilesystemOperation } from "./actor-filesystem.ts"
import { Workload as E2BWorkload } from "./e2b.ts"
import type { Workload } from "./workload.ts"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { lstat, mkdir, open as openFile, readdir, realpath, rename, rm } from "node:fs/promises"
import { join, posix } from "node:path"

const VoidResult = { type: "void" as const }

type FilesystemResult =
  | { readonly type: "void" }
  | { readonly type: "read"; readonly data: Uint8Array }
  | { readonly type: "exists"; readonly value: boolean }
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "names"; readonly names: string[] }
  | { readonly type: "directoryEntries"; readonly entries: ReadonlyArray<{ readonly name: string; readonly isDirectory: boolean; readonly isSymbolicLink: boolean }> }
  | { readonly type: "recursiveEntries"; readonly entries: ReadonlyArray<{ readonly path: string; readonly type: "directory" | "file" | "symlink"; readonly size: number }> }
  | {
      readonly type: "stat"
      readonly stat: {
        readonly isDirectory: boolean
        readonly isSymbolicLink: boolean
        readonly mtimeMs: number
        readonly atimeMs: number
        readonly ctimeMs: number
        readonly birthtimeMs: number
        readonly dev: number
        readonly ino: number
        readonly mode: number
        readonly nlink: number
        readonly uid: number
        readonly gid: number
        readonly rdev: number
        readonly size: number
        readonly blocks: number
      }
    }

export function guestPathFromHost(path: string, aliases: readonly string[]) {
  for (const root of aliases) {
    if (path === root) return "/workspace"
    if (path.startsWith(`${root}/`)) return `/workspace/${path.slice(root.length + 1)}`
  }
  return path
}

export function open(workload: Workload.Interface) {
  let pending = Promise.resolve()
  let closed = false
  let realRoot: string | undefined
  const serialized = <A>(task: () => Promise<A>) => {
    const result = pending.then(task)
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  const nodeFilesystemCode = (cause: unknown): string | undefined => {
    if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") return cause.code
    if (cause instanceof Error && /\bEEXIST\b|file exists/i.test(cause.message)) return "EEXIST"
    if (cause instanceof Error && /\bENOENT\b|no such file or directory/i.test(cause.message)) return "ENOENT"
    if (cause instanceof Error && /\bEACCES\b|\bEPERM\b|permission denied/i.test(cause.message)) return "EACCES"
  }
  const failure = (operation: string, cause: unknown, filesystemCode?: string) => {
    const fields: { operation: string; cause: unknown; filesystemCode?: string } = { operation, cause }
    if (filesystemCode !== undefined) fields.filesystemCode = filesystemCode
    return new ActorFilesystem.Error(fields)
  }
  const rootAliases = () => {
    const root = workload.root
    if (root === undefined) return []
    const aliases = [root]
    if (realRoot !== undefined && realRoot !== root) aliases.push(realRoot)
    return aliases
  }
  const toHost = (path: string) => {
    if (workload.root === undefined) return path
    if (path === "/workspace") return workload.root
    if (path.startsWith("/workspace/")) return `${workload.root}/${path.slice("/workspace/".length)}`
    return path
  }
  const fromHost = (path: string) => guestPathFromHost(path, rootAliases())
  const locate = (input: FilesystemOperation): FilesystemOperation => {
    if (workload.root === undefined) return input
    if (input.type === "move") return { ...input, from: toHost(input.from), to: toHost(input.to) }
    return { ...input, path: toHost(input.path) }
  }
  const files = (): Filesystem => {
    if (workload.root !== undefined) return hostFilesystem()
    if (workload instanceof E2BWorkload) return workload.guestFiles
    throw failure("filesystem", "Filesystem is unsupported for this workload")
  }
  const run = (input: { command: string; args?: readonly string[]; cwd?: string; timeoutMs: number; maxOutputBytes: number }, signal?: AbortSignal) => serialized(async () => {
    if (closed) throw failure("run", "Environment is stopped")
    const cwd = input.cwd === undefined ? undefined : toHost(input.cwd.startsWith("/") ? input.cwd : posix.resolve("/workspace", input.cwd))
    const result = await workload.run(input.command, { args: input.args, cwd, timeoutMs: input.timeoutMs, signal })
    const stdout = Buffer.from(result.stdout).subarray(0, input.maxOutputBytes)
    const stderr = Buffer.from(result.stderr).subarray(0, Math.max(0, input.maxOutputBytes - stdout.length))
    return {
      exitCode: result.exitCode,
      outcome: "exited" as const,
      stdout,
      stderr,
      output: Buffer.from(result.output).subarray(0, input.maxOutputBytes),
      truncated: Buffer.byteLength(result.output) > input.maxOutputBytes,
    }
  })
  const filesystem = (input: FilesystemOperation): Promise<FilesystemResult> => serialized(async () => {
    if (closed) throw failure(input.type, "Environment is stopped")
    if (workload.root !== undefined && realRoot === undefined) {
      realRoot = await realpath(workload.root).catch(() => workload.root)
    }
    const located = locate(input)
    const result = await applyFilesystem(files(), located)
    if (result.type === "recursiveEntries") return { type: result.type, entries: result.entries.map((entry) => ({ ...entry, path: fromHost(entry.path) })) }
    if (result.type === "path") return { type: result.type, path: fromHost(result.path) }
    return result
  })
  return {
    run: (input: Parameters<typeof run>[0]) => {
      const controller = new AbortController()
      return Effect.tryPromise({ try: () => run(input, controller.signal), catch: (cause) => cause instanceof ActorFilesystem.Error ? cause : failure("run", cause, nodeFilesystemCode(cause)) }).pipe(
        Effect.onInterrupt(() =>
          Effect.promise(async () => {
            controller.abort()
          }),
        ),
      )
    },
    filesystem: (input: FilesystemOperation) => Effect.tryPromise({ try: () => filesystem(input), catch: (cause) => cause instanceof ActorFilesystem.Error ? cause : failure(input.type, cause, nodeFilesystemCode(cause)) }),
    stop: Effect.tryPromise({ try: () => serialized(async () => { closed = true; await workload.stop() }), catch: (cause) => failure("stop", cause, nodeFilesystemCode(cause)) }),
    workload,
  }
}

async function applyFilesystem(filesystem: Filesystem, input: FilesystemOperation): Promise<FilesystemResult> {
  if (input.type === "read") return { type: "read", data: await filesystem.readFile(input.path) }
  if (input.type === "write") {
    const writeOptions: { flag?: "w" | "wx"; mode?: number } = {}
    if (input.flag !== undefined) writeOptions.flag = input.flag
    if (input.mode !== undefined) writeOptions.mode = input.mode
    await filesystem.writeFile(input.path, input.data, writeOptions)
    return VoidResult
  }
  if (input.type === "exists") return { type: "exists", value: await filesystem.exists(input.path) }
  if (input.type === "mkdir") {
    await filesystem.mkdir(input.path, { recursive: input.recursive })
    return VoidResult
  }
  if (input.type === "remove") {
    await filesystem.remove(input.path, { recursive: input.recursive })
    return VoidResult
  }
  if (input.type === "move") {
    await filesystem.move(input.from, input.to)
    return VoidResult
  }
  if (input.type === "realpath") return { type: "path", path: await filesystem.realpath(input.path) }
  if (input.type === "readdir") {
    if (input.recursive) {
      const entries = await filesystem.readdirRecursive(input.path)
      const sized = await Promise.all(
        entries.map(async (entry) => {
          const info = await filesystem.stat(entry.path)
          const type: "directory" | "file" | "symlink" =
            entry.type === "directory" || entry.type === "symlink" ? entry.type : "file"
          return { path: entry.path, type, size: info.size }
        }),
      )
      return { type: "recursiveEntries", entries: sized }
    }
    if (input.entries) return { type: "directoryEntries", entries: [...(await filesystem.readdirEntries(input.path))] }
    return { type: "names", names: await filesystem.readdir(input.path) }
  }
  const stat = await filesystem.stat(input.path)
  return {
    type: "stat",
    stat: {
      isDirectory: stat.isDirectory,
      isSymbolicLink: stat.isSymbolicLink,
      mtimeMs: stat.mtimeMs,
      atimeMs: stat.atimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: stat.birthtimeMs,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      rdev: stat.rdev,
      size: stat.size,
      blocks: stat.blocks,
    },
  }
}

function hostFilesystem(): Filesystem {
  return {
    readFile: async (path) => {
      const { readFile } = await import("node:fs/promises")
      return readFile(path)
    },
    writeFile: async (path, data, options) => {
      const handle = await openFile(path, options?.flag === "wx" ? "wx" : "w", options?.mode)
      try {
        await handle.writeFile(data)
      } finally {
        await handle.close()
      }
    },
    stat: async (path) => {
      const info = await lstat(path)
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
      await mkdir(path, { recursive: options?.recursive })
    },
    readdir: async (path) => readdir(path),
    readdirEntries: async (path) => {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isSymbolicLink: entry.isSymbolicLink(),
        isDirectory: entry.isDirectory(),
      }))
    },
    readdirRecursive: async (path) => {
      const entries: { path: string; type: string }[] = []
      const walk = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const full = join(directory, entry.name)
          entries.push({
            path: full,
            type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
          })
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full)
        }
      }
      await walk(path)
      return entries
    },
    exists: (path) => Promise.resolve(existsSync(path)),
    remove: async (path, options) => {
      await rm(path, { recursive: options?.recursive })
    },
    move: async (from, to) => {
      await rename(from, to)
    },
    realpath: (path) => realpath(path),
  }
}