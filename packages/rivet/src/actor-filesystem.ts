export * as ActorFilesystem from "./actor-filesystem.ts"

import { Failed, NotFound, WrongKind, type FileInfo, type FilesImpl, type FileType } from "@opencode/core/environment/files"
import { Effect, Schema } from "effect"

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

const fileType = (entry: { readonly isSymbolicLink: boolean; readonly isDirectory: boolean }): FileType => {
  if (entry.isSymbolicLink) return "symlink"
  if (entry.isDirectory) return "directory"
  return "file"
}

const toInfo = (stat: Awaited<ReturnType<Filesystem["stat"]>>): FileInfo => ({
  type: fileType(stat),
  size: stat.size,
  mtimeMs: stat.mtimeMs,
})

const missing = (cause: unknown) =>
  (typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR")) ||
  (typeof cause === "object" && cause !== null && "filesystemCode" in cause && cause.filesystemCode === "ENOENT") ||
  (cause instanceof globalThis.Error && /\bENOENT\b|no such file or directory/i.test(cause.message))

const fail = (path: string, cause: unknown) =>
  missing(cause) ? new NotFound({ path }) : new Failed({ path, cause })

export function filesImpl(filesystem: Filesystem): FilesImpl {
  return {
    read: (path, range) =>
      Effect.tryPromise({
        try: async () => {
          const stat = await filesystem.stat(path)
          const type = fileType(stat)
          if (type !== "file") throw new WrongKind({ path, actual: type })
          const bytes = await filesystem.readFile(path)
          if (range === undefined) return { info: toInfo(stat), bytes }
          return { info: toInfo(stat), bytes: bytes.subarray(range.offset, range.offset + range.length) }
        },
        catch: (cause) => (cause instanceof WrongKind ? cause : fail(path, cause)),
      }),
    write: (path, bytes) =>
      Effect.tryPromise({
        try: () => filesystem.writeFile(path, bytes),
        catch: (cause) => new Failed({ path, cause }),
      }).pipe(Effect.asVoid),
    stat: (path) =>
      Effect.tryPromise({
        try: async () => toInfo(await filesystem.stat(path)),
        catch: (cause) => fail(path, cause),
      }),
    list: (path) =>
      Effect.tryPromise({
        try: async () => {
          const stat = await filesystem.stat(path)
          const type = fileType(stat)
          if (type !== "directory") throw new WrongKind({ path, actual: type })
          return (await filesystem.readdirEntries(path)).map((entry) => ({
            name: entry.name,
            type: fileType(entry),
          }))
        },
        catch: (cause) => (cause instanceof WrongKind ? cause : fail(path, cause)),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: () => filesystem.remove(path, { recursive: true }),
        catch: (cause) => new Failed({ path, cause }),
      }).pipe(Effect.asVoid),
    move: (from, to) =>
      Effect.tryPromise({
        try: () => filesystem.move(from, to),
        catch: (cause) => fail(from, cause),
      }).pipe(Effect.asVoid),
    mkdir: (path) =>
      Effect.tryPromise({
        try: () => filesystem.mkdir(path, { recursive: true }),
        catch: (cause) => new Failed({ path, cause }),
      }).pipe(Effect.asVoid),
  }
}
