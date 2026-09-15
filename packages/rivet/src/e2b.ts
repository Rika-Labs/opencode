import type { CommandResult, SandboxConnectOpts, SandboxOpts } from "@e2b/code-interpreter"
import { validateArchive } from "./workspace-transfer.ts"

export interface CreateOptions extends SandboxOpts {
  readonly journal?: (entry: JournalEntry) => Promise<void>
}

export interface ReconnectOptions extends SandboxConnectOpts {
  readonly sandboxId: string
  readonly boundaryToken: string
}

export interface RunOptions {
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface JournalEntry {
  readonly sandboxId: string
  readonly boundaryToken: string
  readonly state: "created" | "deleted"
}

const helper = String.raw`#!/usr/bin/python3
import base64,ctypes,fcntl,json,os,sys,tarfile,tempfile,time
state_path="/run/opencode-workload.json"
def state():
  with open(state_path) as f: value=json.load(f)
  path=value["cgroup"]
  if value["token"] != sys.argv[2] or not os.path.isdir(path) or os.stat(path).st_ino != value["inode"]: raise SystemExit(70)
  return value,path
def decode(): return json.loads(base64.b64decode(sys.argv[3]))
lock=open(state_path,"r+")
fcntl.flock(lock,fcntl.LOCK_EX)
value,path=state()
if sys.argv[1] == "inspect": raise SystemExit(0)
if sys.argv[1] == "check": raise SystemExit(72 if value["sealed"] else 0)
if sys.argv[1] == "stop":
  if not value["sealed"]:
    value["sealed"]=True
    lock.seek(0); json.dump(value,lock,separators=(",",":")); lock.truncate(); lock.flush(); os.fsync(lock.fileno())
  with open(path+"/cgroup.kill","w") as f: f.write("1")
  for _ in range(500):
    if "populated 0" in open(path+"/cgroup.events").read(): raise SystemExit(0)
    time.sleep(.01)
  raise SystemExit(71)
if sys.argv[1] == "export":
  if not value["sealed"]: raise SystemExit(73)
  staging=tempfile.mkdtemp(prefix="export-",dir="/run/opencode-boundary")
  archive=staging+"/workspace.tar"
  os.chown(staging,1000,1000); os.chmod(staging,0o700)
  pid=os.fork()
  if pid == 0:
    try:
      libc=ctypes.CDLL(None,use_errno=True)
      if libc.prctl(47,4,0,0,0) != 0: raise OSError(ctypes.get_errno(),"PR_CAP_AMBIENT_CLEAR_ALL")
      os.setgroups([]); os.setgid(1000); os.setuid(1000)
      header=(ctypes.c_uint32*2)(0x20080522,0)
      data=(ctypes.c_uint32*6)(0,0,0,0,0,0)
      if libc.capset(header,data) != 0: raise OSError(ctypes.get_errno(),"capset")
      if libc.prctl(38,1,0,0,0) != 0: raise OSError(ctypes.get_errno(),"PR_SET_NO_NEW_PRIVS")
      os.execve("/usr/bin/tar",["/usr/bin/tar","-C","/workspace","-cf",archive,"."],{"HOME":"/home/user","PATH":"/usr/bin:/bin","LANG":"C"})
    except BaseException: os._exit(126)
  _,status=os.waitpid(pid,0)
  code=os.waitstatus_to_exitcode(status)
  if code: raise SystemExit(code)
  os.chown(archive,1000,1000); os.chmod(archive,0o600)
  print(archive)
  raise SystemExit(0)
if sys.argv[1] == "remove":
  target=sys.argv[3]
  prefix="/run/opencode-boundary/export-"
  parent=os.path.dirname(target)
  if not parent.startswith(prefix) or os.path.basename(target)!="workspace.tar" or "/" in parent[len(prefix):]: raise SystemExit(70)
  os.unlink(target); os.rmdir(os.path.dirname(target)); raise SystemExit(0)
if sys.argv[1] == "import":
  archive=sys.argv[3]
  if not archive.startswith("/run/opencode-boundary/import-") or not archive.endswith("/workspace.tar"): raise SystemExit(70)
  root=os.path.realpath("/workspace")
  links=set()
  with tarfile.open(archive,"r:") as source:
    members=source.getmembers()
    if not members or len(members)>1000000: raise SystemExit(74)
    for member in members:
      name=os.path.normpath(member.name)
      if os.path.isabs(member.name) or name == ".." or name.startswith("../") or member.isdev() or member.isfifo(): raise SystemExit(74)
      parts=name.split("/")
      if any("/".join(parts[:i]) in links for i in range(1,len(parts))): raise SystemExit(74)
      if member.issym() or member.islnk():
        target=os.path.realpath(os.path.join(root,os.path.dirname(name),member.linkname)) if member.issym() else os.path.realpath(os.path.join(root,member.linkname))
        if os.path.commonpath([root,target]) != root: raise SystemExit(74)
        links.add(name)
      if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): raise SystemExit(74)
    source.extractall(root,members=members,numeric_owner=False,filter="fully_trusted")
    for member in members:
      if member.issym(): os.utime(os.path.join(root,member.name),ns=(int(member.mtime)*1000000000,)*2,follow_symlinks=False)
  os.unlink(archive); os.rmdir(os.path.dirname(archive)); raise SystemExit(0)
if value["sealed"]: raise SystemExit(72)
request=decode()
ready_r,ready_w=os.pipe()
pid=os.fork()
if pid == 0:
  os.close(ready_r)
  try:
    with open(path+"/cgroup.procs","w") as f: f.write(str(os.getpid()))
    os.write(ready_w,b"1")
    os.close(ready_w)
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(47,4,0,0,0) != 0: raise OSError(ctypes.get_errno(),"PR_CAP_AMBIENT_CLEAR_ALL")
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
    header=(ctypes.c_uint32*2)(0x20080522,0)
    data=(ctypes.c_uint32*6)(0,0,0,0,0,0)
    if libc.capset(header,data) != 0: raise OSError(ctypes.get_errno(),"capset")
    if libc.prctl(38,1,0,0,0) != 0: raise OSError(ctypes.get_errno(),"PR_SET_NO_NEW_PRIVS")
    os.chdir(request["cwd"])
    os.execvpe(request["file"],request["argv"],request["env"])
  except BaseException:
    os._exit(126)
os.close(ready_w)
if os.read(ready_r,1) != b"1":
  os.waitpid(pid,0)
  raise SystemExit(126)
os.close(ready_r)
fcntl.flock(lock,fcntl.LOCK_UN)
deadline=time.monotonic()+request["timeout"]
while True:
  found,status=os.waitpid(pid,os.WNOHANG)
  if found: raise SystemExit(os.waitstatus_to_exitcode(status))
  if time.monotonic() >= deadline:
    fcntl.flock(lock,fcntl.LOCK_EX)
    value,path=state()
    value["sealed"]=True
    lock.seek(0); json.dump(value,lock,separators=(",",":")); lock.truncate(); lock.flush(); os.fsync(lock.fileno())
    with open(path+"/cgroup.kill","w") as f: f.write("1")
    os.waitpid(pid,0)
    while "populated 1" in open(path+"/cgroup.events").read(): time.sleep(.01)
    raise SystemExit(124)
  time.sleep(.02)
`

type E2BSandbox = Awaited<ReturnType<typeof import("@e2b/code-interpreter")["Sandbox"]["create"]>>

export class Workload {
  readonly sandboxId: string
  readonly boundaryToken: string
  private stopped = false

  private constructor(private readonly sandbox: E2BSandbox, boundaryToken: string, private readonly connectOptions: SandboxConnectOpts) {
    this.sandboxId = sandbox.sandboxId
    this.boundaryToken = boundaryToken
  }

  static async create(options: CreateOptions = {}) {
    if (options.secure === false) throw new Error("E2B workload requires secure controller authentication")
    if (options.envs && Object.keys(options.envs).length > 0) throw new Error("E2B workload does not allow sandbox-global environment variables")
    const { journal, ...sandboxOptions } = options
    const { Sandbox } = await import("@e2b/code-interpreter")
    const sandbox = await Sandbox.create(sandboxOptions)
    const boundaryToken = crypto.randomUUID().replaceAll("-", "")
    const workload = new Workload(sandbox, boundaryToken, sandboxOptions)
    try {
      await journal?.({ sandboxId: sandbox.sandboxId, boundaryToken, state: "created" })
      await workload.install()
      return workload
    } catch (error) {
      const cleanup = await Workload.cleanup(sandbox, boundaryToken, sandboxOptions, journal)
      if (cleanup) throw new AggregateError([error, cleanup], "failed to create and clean up E2B workload", { cause: error })
      throw error
    }
  }

  static async reconnect(options: ReconnectOptions) {
    Workload.validateIdentity(options.sandboxId, options.boundaryToken)
    const { sandboxId, boundaryToken, ...connectOptions } = options
    const { Sandbox } = await import("@e2b/code-interpreter")
    const sandbox = await Sandbox.connect(sandboxId, connectOptions)
    if (sandbox.sandboxId !== sandboxId) throw new Error("E2B reconnected with a different sandbox ID")
    const workload = new Workload(sandbox, boundaryToken, connectOptions)
    await workload.verify()
    return workload
  }

  async run(file: string, options: RunOptions = {}) {
    if (file.includes("/") && !file.startsWith("/")) throw new Error("workload executable path must be absolute")
    const request = Buffer.from(
      JSON.stringify({
        file,
        argv: [file, ...(options.args ?? [])],
        cwd: options.cwd ?? "/workspace",
        env: { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin", ...(options.env ?? {}) },
        timeout: (options.timeoutMs ?? 60_000) / 1000,
      }),
    ).toString("base64")
    const result = await this.root(`run ${this.boundaryToken} ${request}`, (options.timeoutMs ?? 60_000) + 10_000).catch(async (error) => {
      const cleanup = await this.stop().catch((stopError) => stopError)
      if (cleanup instanceof Error) throw new AggregateError([error, cleanup], "workload command response lost and stop reconciliation failed", { cause: error })
      throw error
    })
    if (result.exitCode === 72) throw new Error("workload boundary is stopped")
    return result
  }

  async stop() {
    const result = await this.root(`stop ${this.boundaryToken}`, 15_000)
    if (result.exitCode !== 0) throw new Error(`failed to stop workload boundary: ${result.stderr}`)
    this.stopped = true
  }

  async exportWorkspace() {
    if (!this.stopped) throw new Error("workload must be stopped before export")
    const result = await this.root(`export ${this.boundaryToken}`, 70_000)
    if (result.exitCode !== 0) throw new Error(`workspace export failed: ${result.stderr}`)
    const path = result.stdout.trim()
    try {
      return await this.sandbox.files.read(path, { format: "bytes", user: "user" })
    } finally {
      await this.root(`remove ${this.boundaryToken} ${path}`, 10_000)
    }
  }

  async importWorkspace(data: Uint8Array) {
    if (this.stopped) throw new Error("workload boundary is stopped")
    await validateArchive(data)
    const directory = `/run/opencode-boundary/import-${crypto.randomUUID().replaceAll("-", "")}`
    const archive = `${directory}/workspace.tar`
    const installed = await this.command(`install -d -o 1000 -g 1000 -m 700 ${directory}`, 10_000)
    if (installed.exitCode !== 0) throw new Error(`workspace import staging failed: ${installed.stderr}`)
    try {
      await this.sandbox.files.write(archive, data.slice().buffer, { user: "user" })
      const result = await this.root(`import ${this.boundaryToken} ${archive}`, 70_000)
      if (result.exitCode !== 0) throw new Error(`workspace import failed: ${result.stderr}`)
    } catch (cause) {
      await this.command(`rm -rf -- ${directory}`, 10_000).catch(() => undefined)
      throw cause
    }
  }

  async pause() {
    await this.verify()
    await this.sandbox.pause()
    return { sandboxId: this.sandboxId, boundaryToken: this.boundaryToken }
  }

  async delete(journal?: (entry: JournalEntry) => Promise<void>) {
    const error = await Workload.cleanup(this.sandbox, this.boundaryToken, this.connectOptions, journal)
    if (error) throw error
  }

  private async install() {
    const encoded = Buffer.from(helper).toString("base64")
    const command = `set -eu; install -d -m 700 /usr/local/lib/opencode-boundary; install -d -m 711 /run/opencode-boundary; printf %s ${encoded} | base64 -d > /usr/local/lib/opencode-boundary/helper; chmod 700 /usr/local/lib/opencode-boundary/helper; install -d -o 1000 -g 1000 /workspace; cg=/sys/fs/cgroup/opencode-${this.boundaryToken}; mkdir "$cg"; inode=$(stat -c %i "$cg"); printf '{"token":"%s","cgroup":"%s","inode":%s,"sealed":false}\n' ${this.boundaryToken} "$cg" "$inode" > /run/opencode-workload.json; chmod 600 /run/opencode-workload.json`
    const result = await this.command(command, 30_000)
    if (result.exitCode !== 0) throw new Error(`failed to install workload boundary: ${result.stderr}`)
    await this.verify()
  }

  private async verify() {
    const valid = await this.root(`check ${this.boundaryToken}`, 10_000)
      .then((result) => result.exitCode === 0)
      .catch(() => false)
    if (!valid) throw new Error("workload boundary identity is missing or stale")
  }

  private async root(args: string, timeoutMs: number): Promise<CommandResult> {
    return this.command(`/usr/bin/env -i HOME=/root PATH=/usr/bin:/bin LANG=C /usr/bin/python3 -I -S /usr/local/lib/opencode-boundary/helper ${args}`, timeoutMs)
  }

  private async command(command: string, timeoutMs: number): Promise<CommandResult> {
    const { CommandExitError } = await import("@e2b/code-interpreter")
    return this.sandbox.commands.run(command, { user: "root", cwd: "/", envs: { HOME: "/root", PATH: "/usr/bin:/bin", LANG: "C" }, timeoutMs }).catch((error) => {
      if (error instanceof CommandExitError) return error
      throw error
    })
  }

  private static validateIdentity(sandboxId: string, boundaryToken: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sandboxId)) throw new Error("invalid E2B sandbox ID")
    if (!/^[0-9a-f]{32}$/.test(boundaryToken)) throw new Error("invalid workload boundary token")
  }

  private static async cleanup(sandbox: E2BSandbox, boundaryToken: string, connectOptions: SandboxConnectOpts, journal?: (entry: JournalEntry) => Promise<void>) {
    const failures: unknown[] = []
    await sandbox.kill().catch((error) => failures.push(error))
    const { Sandbox, NotFoundError } = await import("@e2b/code-interpreter")
    const deleted = await Sandbox.connect(sandbox.sandboxId, { ...connectOptions, timeoutMs: 30_000, signal: undefined })
      .then(() => false)
      .catch((error) => {
        if (error instanceof NotFoundError) return true
        failures.push(error)
        return false
      })
    if (deleted) await journal?.({ sandboxId: sandbox.sandboxId, boundaryToken, state: "deleted" }).catch((error) => failures.push(error))
    if (!deleted && failures.length === 0) failures.push(new Error("E2B sandbox still exists after cleanup"))
    if (failures.length === 0) return
    return new AggregateError(failures, "failed to clean up E2B sandbox")
  }
}
