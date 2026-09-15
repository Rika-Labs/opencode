import assert from "node:assert/strict"
import { appendFile } from "node:fs/promises"
import { test } from "node:test"
import { Daytona, DaytonaNotFoundError } from "@daytonaio/sdk"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { SandboxAgent } from "sandbox-agent"
import { daytona } from "sandbox-agent/daytona"
import { Sandbox } from "../../src/sandbox.ts"

const journal = process.env.DAYTONA_RESOURCE_JOURNAL ?? "/tmp/opencode-daytona-resources.jsonl"
const enabled = process.env.DAYTONA_LIVE === "1"

test(
  "Daytona preserves adapter filesystem semantics across stop and rejects a deleted ID",
  { timeout: 300_000, skip: enabled ? false : "set DAYTONA_LIVE=1 to run the Daytona live test" },
  async () => {
    const name = `amp-daytona-${Date.now()}`
    const provider = daytona({
      create: {
        name,
        labels: { owner: "amp", purpose: "rivet-live-verification" },
        autoStopInterval: 0,
        autoDeleteInterval: -1,
      },
      deleteTimeoutSeconds: 120,
    })
    const daytonaClient = new Daytona()
    let id: string | undefined
    let agent: SandboxAgent | undefined
    try {
      id = await provider.create()
      await appendFile(
        journal,
        `${JSON.stringify({ provider: "daytona", id, name, createdAt: new Date().toISOString() })}\n`,
      )
      agent = await SandboxAgent.start({ sandbox: provider, sandboxId: `daytona/${id}` })
      const adapter = Sandbox.make(agent, "/home/sandbox")
      const binary = new Uint8Array([0, 255, 1, 128, 10])
      await Effect.runPromise(adapter.filesystem.makeDirectory("live"))
      await Effect.runPromise(adapter.filesystem.writeFile("live/data.bin", binary, { mode: 0o640 }))
      assert.deepEqual(await Effect.runPromise(adapter.filesystem.readFile("live/data.bin")), binary)
      const stat = await Effect.runPromise(adapter.filesystem.stat("live/data.bin"))
      assert.equal(stat.type, "File")
      assert.equal(stat.mode & 0o777, 0o640)
      assert.equal(stat.size, BigInt(binary.length))
      await Effect.runPromise(
        adapter.process.run(
          ChildProcess.make("/bin/ln", ["-s", "data.bin", "live/link.bin"], { cwd: "/home/sandbox" }),
        ),
      )
      const linkStat = await Effect.runPromise(
        adapter.process.run(ChildProcess.make("/usr/bin/stat", ["--printf=%F", "--", "/home/sandbox/live/link.bin"])),
      )
      assert.equal(linkStat.stdout.toString(), "symbolic link")
      assert.equal(await Effect.runPromise(adapter.filesystem.realPath("live/link.bin")), "/home/sandbox/live/data.bin")
      await Effect.runPromise(
        adapter.filesystem.writeFileString("live/exclusive.txt", "first", { flag: "wx", mode: 0o600 }),
      )
      await assert.rejects(
        Effect.runPromise(
          adapter.filesystem.writeFileString("live/exclusive.txt", "second", { flag: "wx", mode: 0o600 }),
        ),
      )
      assert.equal(await Effect.runPromise(adapter.filesystem.readFileString("live/exclusive.txt")), "first")
      await agent.dispose()
      agent = undefined
      const remote = await daytonaClient.get(id)
      await remote.stop(120)
      await remote.start(120)
      agent = await SandboxAgent.start({ sandbox: provider, sandboxId: `daytona/${id}` })
      const resumed = Sandbox.make(agent, "/home/sandbox")
      assert.deepEqual(await Effect.runPromise(resumed.filesystem.readFile("live/data.bin")), binary)
      assert.equal(resumed.sandboxId, `daytona/${id}`)
      await agent.destroySandbox()
      agent = undefined
      await appendFile(journal, `${JSON.stringify({ provider: "daytona", id, state: "deleted" })}\n`)
      await assert.rejects(daytonaClient.get(id), DaytonaNotFoundError)
      await assert.rejects(SandboxAgent.start({ sandbox: provider, sandboxId: `daytona/${id}` }))
      id = undefined
    } finally {
      const cleanupErrors: unknown[] = []
      await agent?.dispose().catch((error: unknown) => cleanupErrors.push(error))
      if (id) {
        const remote = await daytonaClient.get(id).catch((error: unknown) => {
          if (error instanceof DaytonaNotFoundError) return undefined
          cleanupErrors.push(error)
          return undefined
        })
        if (remote) {
          await remote.delete(120).catch((error: unknown) => cleanupErrors.push(error))
        }
        await assert
          .rejects(daytonaClient.get(id), DaytonaNotFoundError)
          .then(() =>
            appendFile(
              journal,
              `${JSON.stringify({ provider: "daytona", id, state: "confirmed-deleted-in-finally" })}\n`,
            ),
          )
          .catch((error: unknown) => cleanupErrors.push(error))
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Daytona cleanup failed")
    }
  },
)
