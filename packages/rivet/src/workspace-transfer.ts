import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"

const maximumArchiveBytes = 536_870_912
const maximumEntries = 1_000_000
const maximumContentBytes = 2_147_483_648
const execute = promisify(execFile)

let resolved: Promise<string> | undefined
const python = () => (resolved ??= findInterpreter())

async function findInterpreter() {
  const probe = "import inspect,sys,tarfile\nsys.exit(0 if 'filter' in inspect.signature(tarfile.TarFile.extractall).parameters else 1)"
  for (const candidate of ["python3", "python3.13", "python3.12", "python3.11"]) {
    const supported = await execute(candidate, ["-I", "-S", "-c", probe]).then(() => true, () => false)
    if (supported) return candidate
  }
  throw new Error("workspace transfer requires a Python interpreter with tarfile extraction filters")
}

export async function archiveWorkspace(directory: string) {
  const root = await realpath(directory)
  const temporary = await mkdtemp(join(tmpdir(), "opencode-workspace-export-"))
  const archive = join(temporary, "workspace.tar")
  try {
    await execute("tar", ["--format=ustar", "-C", root, "-cf", archive, "."])
    if ((await stat(archive)).size > maximumArchiveBytes) throw new Error(`workspace archive exceeds ${maximumArchiveBytes} bytes`)
    const data = await readFile(archive)
    await validateArchive(data)
    return data
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function extractWorkspace(data: Uint8Array, destination: string) {
  await validateArchive(data)
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { recursive: false })
  const temporary = await mkdtemp(join(tmpdir(), "opencode-workspace-import-"))
  const archive = join(temporary, "workspace.tar")
  try {
    await writeFile(archive, data)
    await execute(await python(), ["-I", "-S", "-c", extractScript, archive, String(maximumEntries), String(maximumContentBytes), destination])
  } catch (cause) {
    await rm(destination, { recursive: true, force: true })
    throw cause
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function validateArchive(data: Uint8Array) {
  if (data.byteLength === 0 || data.byteLength > maximumArchiveBytes) throw new Error("workspace archive has an invalid size")
  const temporary = await mkdtemp(join(tmpdir(), "opencode-workspace-validate-"))
  const archive = join(temporary, "workspace.tar")
  try {
    await writeFile(archive, data)
    await execute(await python(), ["-I", "-S", "-c", validateScript, archive, String(maximumEntries), String(maximumContentBytes)])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function workspaceManifest(directory: string) {
  const result = await execute(await python(), ["-I", "-S", "-c", manifestScript, await realpath(directory)])
  return JSON.parse(result.stdout) as unknown
}

const validation = String.raw`import os,sys,tarfile
size=os.path.getsize(sys.argv[1])
if size < 1024 or size%512: raise ValueError("archive is truncated")
with open(sys.argv[1],"rb") as raw:
 raw.seek(size-1024)
 if raw.read()!=b"\0"*1024: raise ValueError("archive is missing termination blocks")
links=set(); seen=set(); total=0
with tarfile.open(sys.argv[1],"r:") as source:
 members=source.getmembers()
 if not members or len(members)>int(sys.argv[2]): raise ValueError("invalid archive entry count")
 for member in members:
  name=os.path.normpath(member.name)
  if name in seen: raise ValueError("duplicate archive entry")
  seen.add(name); total+=member.size
  if total>int(sys.argv[3]): raise ValueError("archive content is too large")
  if member.pax_headers or os.path.isabs(member.name) or name==".." or name.startswith("../") or member.isdev() or member.isfifo(): raise ValueError("unsafe archive entry")
  parts=name.split("/")
  if any("/".join(parts[:i]) in links for i in range(1,len(parts))): raise ValueError("entry traverses symlink")
  if member.issym() or member.islnk():
   target=os.path.normpath(os.path.join(os.path.dirname(name),member.linkname) if member.issym() else member.linkname)
   if os.path.isabs(member.linkname) or target==".." or target.startswith("../"): raise ValueError("link escapes archive")
   if member.islnk() and (target not in seen or target in links): raise ValueError("unsafe hardlink target")
   links.add(name)
  if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): raise ValueError("unsupported archive entry")`
const validateScript = validation
const extractScript = `${validation}
 source.extractall(sys.argv[4],members=members,numeric_owner=False,filter="fully_trusted")
 for member in members:
  if member.issym(): os.utime(os.path.join(sys.argv[4],member.name),ns=(int(member.mtime)*1000000000,)*2,follow_symlinks=False)`
export const manifestScript = String.raw`import hashlib,json,os,stat,sys
root=sys.argv[1]; result=[]
for parent,dirs,files in os.walk(root,topdown=True,followlinks=False):
 for name in sorted(dirs+files):
  path=os.path.join(parent,name); info=os.lstat(path); relative=os.path.relpath(path,root)
  kind="symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file"
  item={"path":relative,"type":kind,"mtimeNs":info.st_mtime_ns}
  if kind!="symlink": item["mode"]=stat.S_IMODE(info.st_mode)
  if kind=="file": item["size"]=info.st_size; item["sha256"]=hashlib.sha256(open(path,"rb").read()).hexdigest()
  if kind=="symlink": item["target"]=os.readlink(path)
  result.append(item)
result.sort(key=lambda item:item["path"])
print(json.dumps(result,separators=(",",":"),sort_keys=True))`
