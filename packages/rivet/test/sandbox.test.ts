import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { createServer } from "node:http"
import { Effect, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { SandboxAgent } from "sandbox-agent"
import { Sandbox } from "../src/sandbox.ts"

const requests: Array<{ method: string; url: string; body: Uint8Array }> = []
const server = createServer(async (request, response) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  requests.push({ method: request.method ?? "", url: request.url ?? "", body })
  response.setHeader("content-type", "application/json")
  if (request.url?.startsWith("/v1/fs/file") && request.method === "GET") {
    response.setHeader("content-type", "application/octet-stream")
    response.end(new Uint8Array([0, 255, 1]))
    return
  }
  if (request.url?.startsWith("/v1/fs/upload-batch")) {
    response.end(JSON.stringify({ paths: [], truncated: false }))
    return
  }
  if (request.url === "/v1/processes/run") {
    const input = JSON.parse(body.toString())
    const exitCode = input.command === "/bin/sh" && input.args[4] === "/workspace/existing" ? 73 : 0
    const stdout = input.command === "/usr/bin/realpath"
      ? `${input.args[2]}\n`
      : input.command === "/usr/bin/stat"
        ? "regular file\n1700000000\n1700000001\n1600000000\n1\n2\n81a4\n1\n1000\n1000\n0\n3\n4096\n8"
        : input.command === "printf"
          ? "out"
          : ""
    response.end(JSON.stringify({ durationMs: 1, exitCode, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false }))
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ status: 404, title: "not found" }))
})

let agent: SandboxAgent
let sandbox: ReturnType<typeof Sandbox.make>

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("HTTP server has no TCP address")
  agent = await SandboxAgent.connect({ baseUrl: `http://127.0.0.1:${address.port}`, skipHealthCheck: true })
  sandbox = Sandbox.make(agent)
})

after(async () => {
  await agent.dispose()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe("sandbox adapter", () => {
  test("uses the SandboxAgent HTTP filesystem protocol and atomic remote writes", async () => {
    requests.length = 0
    assert.deepEqual(await Effect.runPromise(sandbox.filesystem.readFile("a.txt")), new Uint8Array([0, 255, 1]))
    await Effect.runPromise(sandbox.filesystem.writeFile("binary", new Uint8Array([4, 5, 6]), { flag: "wx", mode: 0o640 }))
    assert.match(requests[0].url, /^\/v1\/fs\/file\?path=%2Fworkspace%2Fa.txt$/)
    assert.match(requests[1].url, /^\/v1\/fs\/upload-batch\?path=%2Fworkspace$/)
    assert.equal(requests[1].body[100], 48)
    assert.equal(Number.parseInt(Buffer.from(requests[1].body.subarray(100, 108)).toString(), 8), 0o640)
    assert.deepEqual([...requests[1].body.subarray(512, 515)], [4, 5, 6])
    const command = JSON.parse(Buffer.from(requests[2].body).toString())
    assert.equal(command.command, "/bin/sh")
    assert.match(command.args[1], /ln --/)
    assert.doesNotMatch(command.args[1], /mkdir/)
    assert.equal(command.args[4], "/workspace/binary")
    assert.throws(() => Effect.runSync(sandbox.filesystem.resolve("../escape")), /path escapes guest root/)
  })

  test("gets canonical paths and complete stat data through framed process arguments", async () => {
    requests.length = 0
    assert.equal(await Effect.runPromise(sandbox.filesystem.realPath("src")), "/workspace/src")
    const stat = await Effect.runPromise(sandbox.filesystem.stat("file"))
    assert.equal(stat.type, "File")
    assert.equal(stat.mode, 0o100644)
    assert.equal(stat.size, 3n)
    assert.equal(Option.getOrThrow(stat.mtime).getTime(), 1700000001000)
    const realpath = JSON.parse(Buffer.from(requests[0].body).toString())
    assert.deepEqual(realpath.args, ["-m", "--", "/workspace/src"])
    const command = JSON.parse(Buffer.from(requests[1].body).toString())
    assert.equal(command.command, "/usr/bin/stat")
    assert.equal(command.args.every((argument: string) => !argument.includes("\0")), true)
    assert.equal(command.args[2], "/workspace/file")
  })

  test("reports exclusive writes as AlreadyExists without creating parents", async () => {
    requests.length = 0
    const error = await Effect.runPromise(Effect.flip(sandbox.filesystem.writeFileString("existing", "second", { flag: "wx" })))
    assert.equal(error.reason._tag, "AlreadyExists")
    const command = JSON.parse(Buffer.from(requests[1].body).toString())
    assert.doesNotMatch(command.args[1], /mkdir/)
  })

  test("runs supported one-shot processes and rejects lossy options", async () => {
    requests.length = 0
    const result = await Effect.runPromise(sandbox.process.run(ChildProcess.make("printf", ["ok"], { cwd: "/workspace/src" })))
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.toString(), "out")
    const command = JSON.parse(Buffer.from(requests[0].body).toString())
    assert.deepEqual(command, { command: "printf", args: ["ok"], cwd: "/workspace/src" })
    const controller = new AbortController()
    await assert.rejects(Effect.runPromise(sandbox.process.run(ChildProcess.make("sleep", ["1"]), { signal: controller.signal })), /unsupported/)
    assert.equal(requests.length, 1)
  })

  test("rejects traversal archives before the SDK uploads them", async () => {
    requests.length = 0
    const archive = new Uint8Array(1536)
    archive.set(new TextEncoder().encode("../secret"), 0)
    archive.set(new TextEncoder().encode("00000000000"), 124)
    await assert.rejects(
      Effect.runPromise(sandbox.uploadTar(archive)),
      (error: Sandbox.Error) => error.cause instanceof Error && /unsafe tar path/.test(error.cause.message),
    )
    assert.equal(requests.length, 0)
  })
})
