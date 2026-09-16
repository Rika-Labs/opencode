import assert from "node:assert/strict"
import { appendFile } from "node:fs/promises"
import { test } from "node:test"
import { NotFoundError, Sandbox } from "@e2b/code-interpreter"
import { Workload } from "../src/e2b.ts"

const enabled = process.env.E2B_LIVE === "1"
const journal = process.env.E2B_RESOURCE_JOURNAL ?? "/tmp/opencode-e2b-workloads.jsonl"
const sdkVersion = "2.49.1"

const probe = String.raw`import base64,json,struct,sys,urllib.error,urllib.parse,urllib.request
base="http://127.0.0.1:49983"
wrong="opencode-deliberately-invalid-access-token"
results=[]
def request(name,url,method,user,token,body=None,content_type=None):
  headers={"Authorization":"Basic "+base64.b64encode((user+":").encode()).decode()}
  if token is not None: headers["X-Access-Token"]=token
  if content_type is not None:
    headers["Content-Type"]=content_type
    headers["Connect-Protocol-Version"]="1"
  try:
    response=urllib.request.urlopen(urllib.request.Request(url,data=body,headers=headers,method=method),timeout=10)
    status=response.status
    payload=response.read(512).decode("utf-8","replace")
  except urllib.error.HTTPError as error:
    status=error.code
    payload=error.read(512).decode("utf-8","replace")
  except Exception as error:
    results.append({"probe":name,"user":user,"token":"missing" if token is None else "wrong","transport":type(error).__name__})
    return
  lower=payload.lower()
  authenticated=status in (401,403) or any(value in lower for value in ("unauthenticated","unauthorized","authentication","access token","invalid token"))
  results.append({"probe":name,"user":user,"token":"missing" if token is None else "wrong","status":status,"auth":authenticated,"bytes":len(payload.encode())})
payload=json.dumps({"process":{"cmd":"/usr/bin/touch","args":["/tmp/opencode-envd-auth-bypass"],"envs":{},"cwd":"/tmp"}},separators=(",",":")).encode()
frame=b"\x00"+struct.pack(">I",len(payload))+payload
for user in ("root","user"):
  for token in (None,wrong):
    request("process",base+"/process.Process/Start","POST",user,token,frame,"application/connect+json")
    query=urllib.parse.urlencode({"path":"/etc/shadow","username":user})
    request("files",base+"/files?"+query,"GET",user,token)
print(json.dumps(results,separators=(",",":")))
`

test("E2B envd rejects direct guest requests without its access token", { timeout: 300_000, skip: enabled ? false : "set E2B_LIVE=1" }, async () => {
  let workload: Workload | undefined
  let journalID: string | undefined
  const record = async (entry: { sandboxId: string; boundaryToken?: string; state: "created" | "deleted" }) => {
    if (entry.state === "created") journalID = entry.sandboxId
    await appendFile(journal, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  }
  try {
    workload = await Workload.create({ timeoutMs: 180_000, metadata: { purpose: "disposable-envd-auth-probe" }, journal: record })
    assert.equal(journalID, workload.sandboxId)
    const sandbox = await Sandbox.connect(workload.sandboxId, { timeoutMs: 30_000 })
    const info = await Sandbox.getInfo(workload.sandboxId)
    const validRoot = await sandbox.commands.run("printf host-sdk-root", { user: "root" })
    const validUser = await sandbox.commands.run("printf host-sdk-user", { user: "user" })
    assert.equal(validRoot.stdout, "host-sdk-root")
    assert.equal(validUser.stdout, "host-sdk-user")
    assert.ok((await sandbox.files.read("/etc/hostname", { user: "root" })).length > 0)
    assert.ok((await sandbox.files.read("/etc/hostname", { user: "user" })).length > 0)

    const result = await workload.run("/usr/bin/python3", { args: ["-c", probe], timeoutMs: 60_000 })
    assert.equal(result.exitCode, 0, result.stderr.toString())
    const statuses: Array<{ probe: string; user: string; token: string; status?: number; auth?: boolean; bytes?: number; transport?: string }> = JSON.parse(result.stdout.toString())
    assert.equal(statuses.length, 8)
    for (const status of statuses) {
      assert.equal(status.transport, undefined, JSON.stringify(status))
      assert.equal(status.auth, true, JSON.stringify(status))
      assert.ok(status.status === 401 || status.status === 403 || status.status === 200, JSON.stringify(status))
      assert.ok((status.bytes ?? 513) <= 512, JSON.stringify(status))
    }
    assert.equal(await sandbox.files.exists("/tmp/opencode-envd-auth-bypass"), false)
    process.stdout.write(`E2B SDK ${sdkVersion}; envd ${info.envdVersion}; ${JSON.stringify(statuses)}\n`)
  } finally {
    if (workload) {
      const id = workload.sandboxId
      await workload.delete(record)
      await assert.rejects(Sandbox.connect(id, { timeoutMs: 30_000 }), NotFoundError)
    }
  }
})
