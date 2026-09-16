export * as ActorFilesystem from "./actor-filesystem.ts"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Glob } from "@opencode-ai/core/util/glob"
import { Effect, FileSystem, Option, PlatformError, Schema } from "effect"
import { posix } from "node:path"

export class Error extends Schema.TaggedErrorClass<Error>()("Rivet.ActorFilesystemError", {
  operation: Schema.String,
  cause: Schema.Defect(),
  filesystemCode: Schema.optional(Schema.String),
}) {}

export type FilesystemOperation =
  | { readonly type: "read"; readonly path: string }
  | {
      readonly type: "write"
      readonly path: string
      readonly data: Uint8Array
      readonly flag?: "w" | "wx"
      readonly mode?: number
    }
  | { readonly type: "stat"; readonly path: string }
  | { readonly type: "mkdir"; readonly path: string; readonly recursive?: boolean }
  | { readonly type: "readdir"; readonly path: string; readonly recursive: boolean; readonly entries: boolean }
  | { readonly type: "exists"; readonly path: string }
  | { readonly type: "remove"; readonly path: string; readonly recursive?: boolean }
  | { readonly type: "move"; readonly from: string; readonly to: string }
  | { readonly type: "realpath"; readonly path: string }

export interface Filesystem {
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly writeFile: (path: string, data: Uint8Array, options?: { readonly flag?: "w" | "wx"; readonly mode?: number }) => Promise<unknown>
  readonly stat: (path: string) => Promise<{
    readonly isSymbolicLink: boolean
    readonly isDirectory: boolean
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
    readonly sizeExact?: number | bigint
    readonly blocks: number
  }>
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>
  readonly readdir: (path: string) => Promise<string[]>
  readonly readdirEntries: (path: string) => Promise<ReadonlyArray<{ readonly name: string; readonly isSymbolicLink: boolean; readonly isDirectory: boolean }>>
  readonly readdirRecursive: (path: string) => Promise<ReadonlyArray<{ readonly path: string; readonly type: string }>>
  readonly exists: (path: string) => Promise<boolean>
  readonly remove: (path: string, options?: { readonly recursive?: boolean }) => Promise<unknown>
  readonly move: (from: string, to: string) => Promise<unknown>
  readonly realpath: (path: string) => Promise<string>
}

export function make(filesystem: Filesystem, mountRoot: string): FSUtil.Interface {
  const mount = posix.resolve("/", mountRoot)
  if (mount === "/") throw new globalThis.Error("guest mount must not be the filesystem root")
  // The actor speaks guest-absolute paths rooted at /workspace; the caller may mount it anywhere.
  const toGuest = (resolved: string) => (mount === "/workspace" ? resolved : `/workspace${resolved.slice(mount.length)}`)
  const fromGuest = (guest: string) => (mount === "/workspace" ? guest : `${mount}${guest.slice("/workspace".length)}`)

  const path = (input: string) => {
    const resolved = input.startsWith("/") ? posix.resolve(input) : posix.resolve(mount, input)
    if (resolved !== mount && !resolved.startsWith(`${mount}/`)) throw new globalThis.Error(`path escapes guest mount: ${input}`)
    return toGuest(resolved)
  }
  const reason = (cause: unknown): "AlreadyExists" | "NotFound" | "PermissionDenied" | "Unknown" => {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
      if (cause.code === "EEXIST") return "AlreadyExists"
      if (cause.code === "ENOENT") return "NotFound"
      if (cause.code === "EACCES" || cause.code === "EPERM") return "PermissionDenied"
    }
    if (cause instanceof Error && /\bEEXIST\b|file exists/i.test(cause.message)) return "AlreadyExists"
    if (cause instanceof Error && /\bENOENT\b|no such file or directory/i.test(cause.message)) return "NotFound"
    return "Unknown"
  }
  const failure = (method: string, input: string, cause: unknown) =>
    PlatformError.systemError({
      _tag: reason(cause),
      module: "FileSystem",
      method,
      pathOrDescriptor: input,
      cause,
    })
  const call = <A>(method: string, input: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => failure(method, input, cause) })
  const guestPath = (input: string, method: string) =>
    Effect.try({
      try: () => path(input),
      catch: (cause) => failure(method, input, cause),
    })

  const exists = (input: string) =>
    guestPath(input, "exists").pipe(Effect.flatMap((target) => call("exists", input, () => filesystem.exists(target))))
  const readFile = (input: string) =>
    guestPath(input, "readFile").pipe(Effect.flatMap((target) => call("readFile", input, () => filesystem.readFile(target))))
  const writeFile: FileSystem.FileSystem["writeFile"] = (input, data, options) => {
    const flag = options?.flag
    if (flag !== undefined && flag !== "w" && flag !== "wx") {
      return Effect.fail(failure("writeFile", input, "write flag is unsupported"))
    }
    return guestPath(input, "writeFile").pipe(
      Effect.flatMap((target) =>
        call("writeFile", input, () =>
          filesystem.writeFile(target, data, {
            flag,
            mode: options?.mode,
          }),
        ),
      ),
    )
  }
  const readDirectory = (input: string, options?: { readonly recursive?: boolean }) =>
    guestPath(input, "readDirectory").pipe(
      Effect.flatMap((target) =>
        call("readDirectory", input, async () => {
          if (!options?.recursive) return filesystem.readdir(target)
          return (await filesystem.readdirRecursive(target)).map((entry) => posix.relative(target, entry.path))
        }),
      ),
    )
  const stat = (input: string) =>
    guestPath(input, "stat").pipe(
      Effect.flatMap((target) =>
        call("stat", input, async () => {
          const info = await filesystem.stat(target)
          return {
            type: info.isSymbolicLink ? "SymbolicLink" : info.isDirectory ? "Directory" : "File",
            mtime: Option.some(new Date(info.mtimeMs)),
            atime: Option.some(new Date(info.atimeMs)),
            birthtime: Option.some(new Date(info.birthtimeMs)),
            dev: info.dev,
            ino: Option.some(info.ino),
            mode: info.mode,
            nlink: Option.some(info.nlink),
            uid: Option.some(info.uid),
            gid: Option.some(info.gid),
            rdev: Option.some(info.rdev),
            size: FileSystem.Size(info.sizeExact ?? info.size),
            blksize: Option.none(),
            blocks: Option.some(info.blocks),
          } as const
        }),
      ),
    )
  const makeDirectory = (input: string, options?: { readonly recursive?: boolean; readonly mode?: number }) => {
    if (options?.mode !== undefined) return Effect.fail(failure("makeDirectory", input, "mode is unsupported"))
    return guestPath(input, "makeDirectory").pipe(
      Effect.flatMap((target) => call("makeDirectory", input, () => filesystem.mkdir(target, options))),
    )
  }
  const remove = (input: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) =>
    guestPath(input, "remove").pipe(
      Effect.flatMap((target) =>
        call("remove", input, () => filesystem.remove(target, { recursive: options?.recursive })),
      ),
      Effect.catchIf((error) => options?.force === true && error.reason._tag === "NotFound", () => Effect.void),
    )
  const rename = (from: string, to: string) =>
    Effect.all([guestPath(from, "rename"), guestPath(to, "rename")]).pipe(
      Effect.flatMap(([source, destination]) => call("rename", from, () => filesystem.move(source, destination))),
    )
  const unsupported = (method: string, input: string) => Effect.fail(failure(method, input, `${method} is unsupported`))
  const copy = (from: string, _to: string, _options?: { readonly overwrite?: boolean }) => unsupported("copy", from)

  const base = FileSystem.makeNoop({
    copy,
    copyFile: (from, to) => copy(from, to),
    exists,
    makeDirectory,
    readDirectory,
    readFile,
    realPath: (input) =>
      guestPath(input, "realPath").pipe(
        Effect.flatMap((target) =>
          call("realPath", input, () => filesystem.realpath(target)).pipe(
            Effect.flatMap((canonical) =>
              canonical === "/workspace" || canonical.startsWith("/workspace/")
                ? Effect.succeed(fromGuest(canonical))
                : Effect.fail(failure("realPath", input, "canonical path escapes guest mount")),
            ),
          ),
        ),
      ),
    remove,
    rename,
    stat,
    writeFile,
    readFileString: (input, encoding = "utf-8") => readFile(input).pipe(Effect.map((data) => new TextDecoder(encoding).decode(data))),
    writeFileString: (input, data, options) => writeFile(input, new TextEncoder().encode(data), options),
  })
  const readDirectoryEntries = (input: string) =>
    guestPath(input, "readDirectoryEntries").pipe(
      Effect.flatMap((target) =>
        call("readDirectoryEntries", input, async () =>
          (await filesystem.readdirEntries(target)).map(
            (entry): FSUtil.DirEntry => ({
              name: entry.name,
              type: entry.isSymbolicLink ? "symlink" : entry.isDirectory ? "directory" : "file",
            }),
          ),
        ),
      ),
    )
  const glob = (pattern: string, options: Glob.Options = {}) =>
    guestPath(options.cwd ?? "/workspace", "glob").pipe(
      Effect.flatMap((cwd) =>
        call("glob", pattern, async () => {
          const entries = await filesystem.readdirRecursive(cwd)
          return entries
            .filter((entry) => options.include === "all" || entry.type !== "directory")
            .filter((entry) => options.dot || !posix.relative(cwd, entry.path).split("/").some((part) => part.startsWith(".")))
            .filter((entry) => Glob.match(pattern, posix.relative(cwd, entry.path)))
            .map((entry) => (options.absolute ? fromGuest(entry.path) : posix.relative(cwd, entry.path)))
        }),
      ),
    )
  const up = (options: { targets: string[]; start: string; stop?: string }) =>
    Effect.gen(function* () {
      const result: string[] = []
      const start = path(options.start)
      const stop = options.stop ? path(options.stop) : "/workspace"
      let current = start
      while (true) {
        for (const target of options.targets) {
          const candidate = posix.join(current, target)
          if (yield* exists(fromGuest(candidate))) result.push(fromGuest(candidate))
        }
        if (current === stop || current === "/workspace") break
        current = posix.dirname(current)
      }
      return result
    })
  const findUp = (target: string, start: string, stop?: string) => up({ targets: [target], start, stop })
  const globUp = (pattern: string, start: string, stop?: string) =>
    Effect.gen(function* () {
      const result: string[] = []
      let current = path(start)
      const boundary = stop ? path(stop) : "/workspace"
      while (true) {
        result.push(...(yield* glob(pattern, { cwd: fromGuest(current), absolute: true, include: "file", dot: true })))
        if (current === boundary || current === "/workspace") break
        current = posix.dirname(current)
      }
      return result
    })

  return {
    ...base,
    isDir: (input) => stat(input).pipe(Effect.match({ onFailure: () => false, onSuccess: (info) => info.type === "Directory" })),
    isFile: (input) => stat(input).pipe(Effect.match({ onFailure: () => false, onSuccess: (info) => info.type === "File" })),
    existsSafe: (input) => exists(input).pipe(Effect.orElseSucceed(() => false)),
    readFileStringSafe: (input) =>
      base.readFileString(input).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      ),
    readJson: (input) =>
      base.readFileString(input).pipe(
        Effect.flatMap((data) =>
          Effect.try({
            try: () => JSON.parse(data),
            catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
          }),
        ),
      ),
    writeJson: (input, data, mode) => base.writeFileString(input, JSON.stringify(data, null, 2), { mode }),
    ensureDir: (input) => makeDirectory(input, { recursive: true }),
    writeWithDirs: (input, content, mode) =>
      makeDirectory(fromGuest(posix.dirname(path(input))), { recursive: true }).pipe(
        Effect.andThen(
          typeof content === "string"
            ? base.writeFileString(input, content, { mode })
            : writeFile(input, content, { mode }),
        ),
      ),
    readDirectoryEntries,
    resolve: (input) =>
      base.realPath(input).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(fromGuest(path(input))),
        ),
        Effect.orDie,
      ),
    findUp,
    up,
    globUp,
    glob,
    globMatch: Glob.match,
  }
}
