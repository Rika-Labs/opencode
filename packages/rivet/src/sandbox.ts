export * as Sandbox from "./sandbox.ts"

import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Glob } from "@opencode-ai/core/util/glob"
import type { SandboxAgent, SandboxProvider } from "sandbox-agent"
import { Duration, Effect, FileSystem, Option, PlatformError, Stream } from "effect"
import { posix } from "node:path"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export interface Options {
  readonly provider: SandboxProvider
  readonly sandboxId: string
  readonly root?: string
}

export class Error extends globalThis.Error {
  readonly operation: string
  override readonly cause: unknown

  constructor(operation: string, cause: unknown) {
    super(`Sandbox ${operation} failed`, { cause })
    this.name = "Rivet.SandboxError"
    this.operation = operation
    this.cause = cause
  }
}

export const open = Effect.fn("Rivet.Sandbox.open")(function* (options: Options) {
  if (!options.sandboxId.startsWith(`${options.provider.name}/`)) {
    return yield* Effect.fail(new Error("validate", `sandboxId must use the ${options.provider.name}/ prefix`))
  }
  const { SandboxAgent } = yield* Effect.tryPromise({
    try: () => import("sandbox-agent"),
    catch: (cause) => new Error("load", cause),
  })
  const client = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => SandboxAgent.start({ sandbox: options.provider, sandboxId: options.sandboxId }),
      catch: (cause) => new Error("connect", cause),
    }),
    (client) => Effect.promise(() => client.dispose()),
  )
  return make(client, options.root)
})

type Client = Pick<
  SandboxAgent,
  "sandboxId" | "readFsFile" | "writeFsFile" | "listFsEntries" | "mkdirFs" | "deleteFsEntry" | "moveFs" | "statFs" | "runProcess" | "uploadFsBatch"
>

export function make(client: Client, guestRoot = "/workspace") {
  const root = posix.resolve("/", guestRoot)
  const path = (input: string) => {
    const resolved = input.startsWith("/") ? posix.resolve(input) : posix.resolve(root, input)
    if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new globalThis.Error(`path escapes guest root: ${input}`)
    return resolved
  }
  const reason = (cause: unknown): "AlreadyExists" | "NotFound" | "PermissionDenied" | "Unknown" => {
    if (typeof cause === "object" && cause !== null && "status" in cause) {
      if (cause.status === 404) return "NotFound"
      if (cause.status === 403) return "PermissionDenied"
      if (cause.status === 409) return "AlreadyExists"
    }
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
  const target = (method: string, input: string) => Effect.try({ try: () => path(input), catch: (cause) => failure(method, input, cause) })
  const call = <A>(method: string, input: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => failure(method, input, cause) })
  const body = (data: Uint8Array) => new Blob([data.slice().buffer])
  const unsupported = (method: string, input: string) => Effect.fail(failure(method, input, `${method} is not supported by Sandbox Agent 0.4.2`))
  const remote = (method: string, input: string, command: string, args: string[], alreadyExistsExitCode?: number) =>
    call(method, input, () => client.runProcess({ command, args })).pipe(
      Effect.flatMap((result) =>
        result.timedOut || result.exitCode !== 0
          ? Effect.fail(
              failure(
                method,
                input,
                result.exitCode === alreadyExistsExitCode
                  ? { status: 409, message: result.stderr || "destination already exists" }
                  : result.stderr || `remote command exited ${result.exitCode ?? "without status"}`,
              ),
            )
          : Effect.succeed(result.stdout),
      ),
    )
  const readFile = (input: string) => target("readFile", input).pipe(Effect.flatMap((path) => call("readFile", input, () => client.readFsFile({ path }))))
  const writeFile: FileSystem.FileSystem["writeFile"] = (input, data, options) => {
    if (options?.flag !== undefined && options.flag !== "w" && options.flag !== "wx") return unsupported(`writeFile flag ${options.flag}`, input)
    return target("writeFile", input).pipe(
      Effect.flatMap((destination) => {
        const name = `.opencode-write-${crypto.randomUUID()}`
        const archive = tarFile(name, data, options?.mode ?? 0o666)
        return call("writeFile", input, () => client.uploadFsBatch(body(archive), { path: root })).pipe(
          Effect.andThen(
            remote(
              "writeFile",
              input,
              "/bin/sh",
              [
                "-c",
                options?.flag === "wx"
                  ? 'if [ -e "$2" ] || [ -L "$2" ]; then rm -f -- "$1"; exit 73; fi; ln -- "$1" "$2"; code=$?; rm -f -- "$1"; if [ $code -ne 0 ] && { [ -e "$2" ] || [ -L "$2" ]; }; then exit 73; fi; exit $code'
                  : 'mv -f -- "$1" "$2"',
                "sh",
                posix.join(root, name),
                destination,
              ],
              options?.flag === "wx" ? 73 : undefined,
            ),
          ),
          Effect.asVoid,
        )
      }),
    )
  }
  const readDirectory = (input: string, options?: { readonly recursive?: boolean }) => {
    if (options?.recursive) return unsupported("recursive readDirectory", input)
    return target("readDirectory", input).pipe(
      Effect.flatMap((path) => call("readDirectory", input, () => client.listFsEntries({ path }))),
      Effect.map((entries) => entries.map((entry) => entry.name)),
    )
  }
  const makeDirectory = (input: string, options?: { readonly recursive?: boolean; readonly mode?: number }) => {
    if (options?.mode !== undefined || options?.recursive === false) return unsupported("makeDirectory options", input)
    return target("makeDirectory", input).pipe(Effect.flatMap((path) => call("makeDirectory", input, () => client.mkdirFs({ path }))), Effect.asVoid)
  }
  const remove = (input: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) =>
    target("remove", input).pipe(
      Effect.flatMap((path) => call("remove", input, () => client.deleteFsEntry({ path, recursive: options?.recursive }))),
      Effect.asVoid,
      Effect.catchIf((error) => options?.force === true && error.reason._tag === "NotFound", () => Effect.void),
    )
  const rename = (from: string, to: string) =>
    Effect.all([target("rename", from), target("rename", to)]).pipe(
      Effect.flatMap(([source, destination]) => call("rename", from, () => client.moveFs({ from: source, to: destination, overwrite: false }))),
      Effect.asVoid,
    )
  const exists = (input: string) =>
    target("exists", input).pipe(
      Effect.flatMap((path) => call("exists", input, () => client.statFs({ path }))),
      Effect.as(true),
      Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(false)),
    )
  const base = FileSystem.makeNoop({
    copy: (from) => unsupported("copy", from),
    copyFile: (from) => unsupported("copyFile", from),
    exists,
    makeDirectory,
    readDirectory,
    readFile,
    readFileString: (input, encoding = "utf-8") => readFile(input).pipe(Effect.map((data) => new TextDecoder(encoding).decode(data))),
    realPath: (input) =>
      target("realPath", input).pipe(
        Effect.flatMap((target) => remote("realPath", input, "/usr/bin/realpath", ["-m", "--", target])),
        Effect.map((output) => path(output.trimEnd())),
      ),
    remove,
    rename,
    stat: (input) =>
      target("stat", input).pipe(
        Effect.flatMap((target) =>
          remote("stat", input, "/usr/bin/stat", ["--printf=%F\n%X\n%Y\n%W\n%d\n%i\n%f\n%h\n%u\n%g\n%r\n%s\n%o\n%b", "--", target]),
        ),
        Effect.map((output) => {
          const value = output.split("\n")
          const date = (raw: string) => Option.some(new Date(Number(raw) * 1000))
          return {
            type: value[0] === "directory" ? "Directory" : value[0] === "symbolic link" ? "SymbolicLink" : "File",
            atime: date(value[1]),
            mtime: date(value[2]),
            birthtime: Number(value[3]) >= 0 ? date(value[3]) : Option.none(),
            dev: Number(value[4]),
            ino: Option.some(Number(value[5])),
            mode: Number.parseInt(value[6], 16),
            nlink: Option.some(Number(value[7])),
            uid: Option.some(Number(value[8])),
            gid: Option.some(Number(value[9])),
            rdev: Option.some(Number(value[10])),
            size: FileSystem.Size(BigInt(value[11])),
            blksize: Option.some(FileSystem.Size(BigInt(value[12]))),
            blocks: Option.some(Number(value[13])),
          } as const
        }),
      ),
    writeFile,
    writeFileString: (input, data, options) => writeFile(input, new TextEncoder().encode(data), options),
  })
  const filesystem: FSUtil.Interface = {
    ...base,
    isDir: (input) => target("isDir", input).pipe(Effect.flatMap((path) => call("isDir", input, () => client.statFs({ path }))), Effect.map((stat) => stat.entryType === "directory"), Effect.orElseSucceed(() => false)),
    isFile: (input) => target("isFile", input).pipe(Effect.flatMap((path) => call("isFile", input, () => client.statFs({ path }))), Effect.map((stat) => stat.entryType === "file"), Effect.orElseSucceed(() => false)),
    existsSafe: (input) => exists(input).pipe(Effect.orElseSucceed(() => false)),
    readFileStringSafe: (input) => base.readFileString(input).pipe(Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(undefined))),
    readJson: (input) => base.readFileString(input).pipe(Effect.flatMap((data) => Effect.try({ try: () => JSON.parse(data), catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }) }))),
    writeJson: (input, data, mode) => base.writeFileString(input, JSON.stringify(data, null, 2), { mode }),
    ensureDir: (input) => makeDirectory(input, { recursive: true }),
    writeWithDirs: (input, content, mode) => makeDirectory(posix.dirname(path(input)), { recursive: true }).pipe(Effect.andThen(typeof content === "string" ? base.writeFileString(input, content, { mode }) : writeFile(input, content, { mode }))),
    readDirectoryEntries: (input) => target("readDirectoryEntries", input).pipe(
      Effect.flatMap((path) => call("readDirectoryEntries", input, () => client.listFsEntries({ path }))),
      Effect.map((entries) => entries.map((entry): FSUtil.DirEntry => ({ name: entry.name, type: entry.entryType }))),
    ),
    resolve: (input) => Effect.sync(() => path(input)),
    findUp: () => Effect.die(new globalThis.Error("findUp is not supported by Sandbox Agent 0.4.2")),
    up: () => Effect.die(new globalThis.Error("up is not supported by Sandbox Agent 0.4.2")),
    globUp: () => Effect.die(new globalThis.Error("globUp is not supported by Sandbox Agent 0.4.2")),
    glob: () => Effect.die(new globalThis.Error("glob is not supported by Sandbox Agent 0.4.2")),
    globMatch: Glob.match,
  }
  const describe = (command: ChildProcess.Command): string => command._tag === "StandardCommand" ? [command.command, ...command.args].join(" ") : "piped command"
  const run = Effect.fn("Rivet.Sandbox.run")(function* (command: ChildProcess.Command, options?: AppProcess.RunOptions) {
    const label = describe(command)
    if (
      command._tag !== "StandardCommand" ||
      options?.stdin !== undefined ||
      options?.signal !== undefined ||
      options?.combineOutput === true ||
      (options?.maxOutputBytes !== undefined && options.maxErrorBytes !== undefined && options.maxOutputBytes !== options.maxErrorBytes) ||
      command.options.additionalFds ||
      command.options.detached ||
      command.options.extendEnv ||
      command.options.forceKillAfter !== undefined ||
      command.options.killSignal !== undefined ||
      command.options.shell !== undefined
    ) {
      return yield* new AppProcess.AppProcessError({ command: label, cause: new globalThis.Error("Sandbox command option is unsupported") })
    }
    const result = yield* Effect.tryPromise({
      try: () => client.runProcess({
        command: command.command,
        args: [...command.args],
        cwd: command.options.cwd === undefined ? root : path(command.options.cwd),
        env: command.options.env === undefined ? undefined : Object.fromEntries(Object.entries(command.options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        timeoutMs: options?.timeout === undefined ? undefined : Duration.toMillis(options.timeout),
        maxOutputBytes: options?.maxOutputBytes ?? options?.maxErrorBytes,
      }),
      catch: (cause) => new AppProcess.AppProcessError({ command: label, cause }),
    })
    if (result.timedOut) return yield* new AppProcess.AppProcessError({ command: label, cause: new globalThis.Error("Timed out") })
    if (result.exitCode === undefined || result.exitCode === null) return yield* new AppProcess.AppProcessError({ command: label, cause: new globalThis.Error("Process exited without a status") })
    return {
      command: label,
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    }
  })
  const spawn = (command: ChildProcess.Command) => Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "spawn", pathOrDescriptor: describe(command), cause: "spawn is unsupported" }))
  const process = AppProcess.Service.of({
    ...ChildProcessSpawner.make(spawn),
    run,
    runStream: (command) => Stream.fail(new AppProcess.AppProcessError({ command: describe(command), cause: new globalThis.Error("runStream is unsupported") })),
  })
  const uploadTar = (archive: Uint8Array, destination = root) =>
    target("uploadTar", destination).pipe(
      Effect.flatMap((path) => Effect.try({ try: () => validateTar(archive), catch: (cause) => new Error("validateTar", cause) }).pipe(Effect.as(path))),
      Effect.flatMap((path) => Effect.tryPromise({ try: () => client.uploadFsBatch(body(archive), { path }), catch: (cause) => new Error("uploadTar", cause) })),
    )
  return { sandboxId: client.sandboxId, root, filesystem, process, uploadTar }
}

function tarFile(name: string, data: Uint8Array, mode: number) {
  const size = Math.ceil((512 + data.length) / 512) * 512 + 1024
  const archive = new Uint8Array(size)
  const header = archive.subarray(0, 512)
  const text = (offset: number, length: number, value: string) => header.set(new TextEncoder().encode(value).subarray(0, length), offset)
  const octal = (offset: number, length: number, value: number) => text(offset, length, value.toString(8).padStart(length - 1, "0"))
  text(0, 100, name)
  octal(100, 8, mode)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, data.length)
  octal(136, 12, Math.floor(Date.now() / 1000))
  text(148, 8, "        ")
  text(156, 1, "0")
  text(257, 6, "ustar\0")
  text(263, 2, "00")
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  text(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  archive.set(data, 512)
  return archive
}

function validateTar(archive: Uint8Array) {
  const decoder = new TextDecoder()
  const links = new Set<string>()
  const field = (header: Uint8Array, offset: number, length: number) => decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/, "")
  const safe = (value: string) => {
    if (!value || posix.isAbsolute(value) || posix.normalize(value) === ".." || posix.normalize(value).startsWith("../")) throw new globalThis.Error(`unsafe tar path: ${value}`)
    return posix.normalize(value).replace(/^\.\//, "")
  }
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return
    const name = safe(posix.join(field(header, 345, 155), field(header, 0, 100)))
    if ([...links].some((link) => name.startsWith(`${link}/`))) throw new globalThis.Error(`tar entry traverses symlink: ${name}`)
    const type = field(header, 156, 1)
    if (!["", "0", "1", "2", "3", "4", "5", "6", "7"].includes(type)) throw new globalThis.Error(`unsupported tar entry type: ${type}`)
    if (type === "1" || type === "2") {
      const target = field(header, 157, 100)
      safe(type === "2" ? posix.join(posix.dirname(name), target) : target)
      if (type === "2") links.add(name)
    }
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new globalThis.Error(`invalid tar entry size: ${name}`)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new globalThis.Error("tar archive is missing an end marker")
}
