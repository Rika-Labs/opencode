import { Workload } from "./e2b.ts"
import { AgentOS, Error, type FilesystemOperation } from "./agentos.ts"
import { Effect, Schema } from "effect"

const VoidResult = Schema.Struct({ type: Schema.Literal("void") })
const ReadResult = Schema.Struct({ type: Schema.Literal("read"), data: Schema.String })
const ExistsResult = Schema.Struct({ type: Schema.Literal("exists"), value: Schema.Boolean })
const PathResult = Schema.Struct({ type: Schema.Literal("path"), path: Schema.String })
const NamesResult = Schema.Struct({ type: Schema.Literal("names"), names: Schema.Array(Schema.String) })
const DirectoryEntriesResult = Schema.Struct({
  type: Schema.Literal("directoryEntries"),
  entries: Schema.Array(Schema.Struct({ name: Schema.String, isDirectory: Schema.Boolean, isSymbolicLink: Schema.Boolean })),
})
const RecursiveEntriesResult = Schema.Struct({
  type: Schema.Literal("recursiveEntries"),
  entries: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.Literals(["directory", "file", "symlink"]), size: Schema.Number })),
})
const StatResult = Schema.Struct({
  type: Schema.Literal("stat"),
  stat: Schema.Struct({
    isDirectory: Schema.Boolean, isSymbolicLink: Schema.Boolean, mtimeMs: Schema.Number, atimeMs: Schema.Number, ctimeMs: Schema.Number,
    birthtimeMs: Schema.Number, dev: Schema.Number, ino: Schema.Number, mode: Schema.Number, nlink: Schema.Number,
    uid: Schema.Number, gid: Schema.Number, rdev: Schema.Number, size: Schema.Number, blocks: Schema.Number,
  }),
})
const FailureResult = Schema.Struct({ ok: Schema.Literal(false), code: Schema.String, message: Schema.String })
const SuccessResult = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown })
type AgentEnvironment = Effect.Success<ReturnType<typeof AgentOS.open>>
type FilesystemResult = Effect.Success<ReturnType<AgentEnvironment["filesystem"]>>

export function open(workload: Workload) {
  let pending = Promise.resolve()
  let closed = false
  const serialized = <A>(task: () => Promise<A>) => {
    const result = pending.then(task)
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  const failure = (operation: string, cause: unknown, filesystemCode?: string) => new Error({ operation, cause, filesystemCode })
  const run = (input: { command: string; args?: readonly string[]; cwd?: string; timeoutMs: number; maxOutputBytes: number }) => serialized(async () => {
    if (closed) throw failure("run", "Environment is stopped")
    const result = await workload.run(input.command, { args: input.args, cwd: input.cwd, timeoutMs: input.timeoutMs })
    const stdout = Buffer.from(result.stdout).subarray(0, input.maxOutputBytes)
    const stderr = Buffer.from(result.stderr).subarray(0, Math.max(0, input.maxOutputBytes - stdout.length))
    return { exitCode: result.exitCode, outcome: "exited" as const, stdout, stderr, output: Buffer.concat([stdout, stderr]), truncated: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.maxOutputBytes }
  })
  const filesystem = (input: FilesystemOperation): Promise<FilesystemResult> => serialized(async () => {
    if (closed) throw failure(input.type, "Environment is stopped")
    const encoded = Buffer.from(JSON.stringify(input.type === "write" ? { ...input, data: Buffer.from(input.data).toString("base64") } : input)).toString("base64")
    const process = await workload.run("python3", { args: ["-I", "-S", "-c", filesystemHelper, encoded], timeoutMs: 30_000 })
    if (process.exitCode !== 0) throw failure(input.type, process.stderr || "filesystem helper failed")
    const envelope = await Schema.decodeUnknownPromise(Schema.Union([FailureResult, SuccessResult]))(JSON.parse(process.stdout))
    if (!envelope.ok) throw failure(input.type, envelope.message, envelope.code)
    const schema = input.type === "read" ? ReadResult : input.type === "stat" ? StatResult : input.type === "exists" ? ExistsResult : input.type === "realpath" ? PathResult : input.type === "readdir" ? input.recursive ? RecursiveEntriesResult : input.entries ? DirectoryEntriesResult : NamesResult : VoidResult
    const value = await Schema.decodeUnknownPromise(schema)(envelope.result)
    if (value.type === "read") return { type: value.type, data: Buffer.from(value.data, "base64") }
    if (value.type === "names") return { type: value.type, names: [...value.names] }
    if (value.type === "directoryEntries") return { type: value.type, entries: value.entries.map((entry) => ({ ...entry })) }
    if (value.type === "recursiveEntries") return { type: value.type, entries: value.entries.map((entry) => ({ ...entry })) }
    if (value.type === "stat") return { type: value.type, stat: { ...value.stat } }
    return value
  })
  return {
    run: (input: Parameters<typeof run>[0]) => Effect.tryPromise({ try: () => run(input), catch: (cause) => cause instanceof Error ? cause : failure("run", cause) }),
    filesystem: (input: FilesystemOperation) => Effect.tryPromise({ try: () => filesystem(input), catch: (cause) => cause instanceof Error ? cause : failure(input.type, cause) }),
    stop: Effect.tryPromise({ try: () => serialized(async () => { closed = true; await workload.stop() }), catch: (cause) => failure("stop", cause) }),
    workload,
  }
}

const filesystemHelper = String.raw`import base64,errno,json,os,shutil,stat,sys
r=json.loads(base64.b64decode(sys.argv[1])); t=r["type"]
def emit(value): print(json.dumps({"ok":True,"result":value},separators=(",",":")))
try:
 if t=="read": emit({"type":"read","data":base64.b64encode(open(r["path"],"rb").read()).decode()})
 elif t=="write":
  f=os.open(r["path"],os.O_WRONLY|os.O_CREAT|(os.O_EXCL if r.get("flag")=="wx" else os.O_TRUNC),r.get("mode",438))
  with os.fdopen(f,"wb",closefd=True) as out: out.write(base64.b64decode(r["data"])); out.flush(); os.fsync(out.fileno())
  emit({"type":"void"})
 elif t=="exists": emit({"type":"exists","value":os.path.exists(r["path"])})
 elif t=="mkdir": os.makedirs(r["path"],exist_ok=True) if r.get("recursive") else os.mkdir(r["path"]); emit({"type":"void"})
 elif t=="remove": shutil.rmtree(r["path"]) if r.get("recursive") and os.path.isdir(r["path"]) and not os.path.islink(r["path"]) else (os.rmdir(r["path"]) if os.path.isdir(r["path"]) and not os.path.islink(r["path"]) else os.unlink(r["path"])); emit({"type":"void"})
 elif t=="move": os.rename(r["from"],r["to"]); emit({"type":"void"})
 elif t=="realpath": emit({"type":"path","path":os.path.realpath(r["path"])})
 elif t=="readdir":
  if r["recursive"]:
   entries=[]
   for root,dirs,files in os.walk(r["path"],followlinks=False):
    for name in dirs+files:
     p=os.path.join(root,name); s=os.lstat(p); entries.append({"path":p,"type":"symlink" if stat.S_ISLNK(s.st_mode) else "directory" if stat.S_ISDIR(s.st_mode) else "file","size":s.st_size})
   emit({"type":"recursiveEntries","entries":entries})
  elif r["entries"]:
   emit({"type":"directoryEntries","entries":[{"name":e.name,"isDirectory":e.is_dir(follow_symlinks=False),"isSymbolicLink":e.is_symlink()} for e in os.scandir(r["path"])]})
  else: emit({"type":"names","names":os.listdir(r["path"])})
 elif t=="stat":
  s=os.lstat(r["path"]); emit({"type":"stat","stat":{"isDirectory":stat.S_ISDIR(s.st_mode),"isSymbolicLink":stat.S_ISLNK(s.st_mode),"mtimeMs":s.st_mtime*1000,"atimeMs":s.st_atime*1000,"ctimeMs":s.st_ctime*1000,"birthtimeMs":s.st_ctime*1000,"dev":s.st_dev,"ino":s.st_ino,"mode":s.st_mode,"nlink":s.st_nlink,"uid":s.st_uid,"gid":s.st_gid,"rdev":s.st_rdev,"size":s.st_size,"blocks":s.st_blocks}})
except OSError as e: print(json.dumps({"ok":False,"code":errno.errorcode.get(e.errno,"EIO"),"message":str(e)},separators=(",",":")))`
