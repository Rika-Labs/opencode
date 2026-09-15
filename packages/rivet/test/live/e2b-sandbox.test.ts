import assert from "node:assert/strict"
import { appendFile } from "node:fs/promises"
import { test } from "node:test"
import { NotFoundError, Sandbox } from "@e2b/code-interpreter"
import { Effect } from "effect"
import { SandboxAgent, SandboxDestroyedError, type SandboxProvider } from "sandbox-agent"
import { make } from "../../src/sandbox.ts"

const journal = process.env.E2B_RESOURCE_JOURNAL ?? "/tmp/opencode-e2b-resources.jsonl"
const enabled = process.env.E2B_LIVE === "1"

test(
  "E2B preserves adapter filesystem semantics across pause and permanently rejects a killed ID",
  { timeout: 300_000, skip: enabled ? false : "set E2B_LIVE=1 to run the E2B live test" },
  async () => {
    let id: string | undefined
    let agent: SandboxAgent | undefined
    let killed = false
    const connect = () => {
      if (!id) throw new Error("sandbox has not been created")
      return Sandbox.connect(id, { timeoutMs: 180_000 })
    }
    const ensureServer = async () => {
      const sandbox = await connect()
      const installed = await sandbox.commands.run(
        "test -x /usr/local/bin/sandbox-agent || (curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.2/install.sh | sh)",
      )
      assert.equal(installed.exitCode, 0, installed.stderr)
      await sandbox.commands.run(
        "PATH=/usr/local/bin:$HOME/.local/bin:$PATH sandbox-agent server --no-token --host 0.0.0.0 --port 3000",
        { background: true, timeoutMs: 0 },
      )
    }
    const provider: SandboxProvider = {
      name: "e2b",
      defaultCwd: "/home/user",
      create: async () => {
        throw new Error("live test provisions explicitly so its ID is journaled immediately")
      },
      reconnect: async () => {
        await connect().catch((error: unknown) => {
          if (error instanceof NotFoundError) throw new SandboxDestroyedError(id ?? "unknown", "e2b", { cause: error })
          throw error
        })
      },
      ensureServer,
      getUrl: async () => `https://${(await connect()).getHost(3000)}`,
      pause: async () => {
        await (await connect()).pause()
      },
      destroy: async () => {
        await (await connect()).kill()
      },
      kill: async () => {
        await (await connect()).kill()
      },
    }

    try {
      const created = await Sandbox.create({
        allowInternetAccess: true,
        metadata: { owner: "amp", thread: "e2b-live-rivet", purpose: "disposable-verification" },
        timeoutMs: 180_000,
      })
      const sandboxID = String(created.sandboxId)
      id = sandboxID
      await appendFile(
        journal,
        `${JSON.stringify({ provider: "e2b", id, createdAt: new Date().toISOString(), state: "created" })}\n`,
        { mode: 0o600 },
      )
      await ensureServer()
      agent = await SandboxAgent.start({ sandbox: provider, sandboxId: `e2b/${id}` })
      assert.equal(agent.sandboxId, `e2b/${id}`)
      const adapter = make(agent, "/home/user")
      const binary = new Uint8Array([0, 255, 1, 128, 10])
      await Effect.runPromise(adapter.filesystem.makeDirectory("fixture"))
      await Effect.runPromise(adapter.filesystem.writeFile("fixture/data.bin", binary, { flag: "wx", mode: 0o640 }))
      assert.deepEqual(await Effect.runPromise(adapter.filesystem.readFile("fixture/data.bin")), binary)
      const stat = await Effect.runPromise(adapter.filesystem.stat("fixture/data.bin"))
      assert.equal(stat.type, "File")
      assert.equal(stat.mode & 0o777, 0o640)
      assert.equal(stat.size, BigInt(binary.length))
      const link = await created.commands.run("ln -s data.bin /home/user/fixture/link.bin")
      assert.equal(link.exitCode, 0, link.stderr)
      const metadata = await created.commands.run(
        "stat -c '%a %F' /home/user/fixture/data.bin /home/user/fixture/link.bin",
      )
      assert.equal(metadata.stdout, "640 regular file\n777 symbolic link\n")
      assert.equal(
        await Effect.runPromise(adapter.filesystem.realPath("fixture/link.bin")),
        "/home/user/fixture/data.bin",
      )
      await assert.rejects(
        Effect.runPromise(adapter.filesystem.writeFile("fixture/data.bin", new Uint8Array([9]), { flag: "wx" })),
      )

      await agent.dispose()
      agent = undefined
      await provider.pause?.(sandboxID)
      await appendFile(journal, `${JSON.stringify({ provider: "e2b", id, state: "paused" })}\n`)
      agent = await SandboxAgent.start({ sandbox: provider, sandboxId: `e2b/${id}` })
      const resumed = make(agent, "/home/user")
      assert.equal(agent.sandboxId, `e2b/${id}`)
      assert.deepEqual(await Effect.runPromise(resumed.filesystem.readFile("fixture/data.bin")), binary)
      assert.equal(
        await Effect.runPromise(resumed.filesystem.realPath("fixture/link.bin")),
        "/home/user/fixture/data.bin",
      )
      const linkStat = await Effect.runPromise(resumed.filesystem.stat("fixture/link.bin"))
      assert.equal(linkStat.type, "SymbolicLink")

      await agent.dispose()
      agent = undefined
      await provider.kill?.(sandboxID)
      killed = true
      await appendFile(journal, `${JSON.stringify({ provider: "e2b", id, state: "killed" })}\n`)
      await assert.rejects(Sandbox.connect(id, { timeoutMs: 30_000 }), NotFoundError)
      await assert.rejects(
        SandboxAgent.start({ sandbox: provider, sandboxId: `e2b/${id}`, skipHealthCheck: true }),
        SandboxDestroyedError,
      )
    } finally {
      const cleanupErrors: unknown[] = []
      await agent?.dispose().catch((error: unknown) => cleanupErrors.push(error))
      if (id && !killed) {
        await Sandbox.connect(id, { timeoutMs: 30_000 })
          .then((sandbox) => sandbox.kill())
          .catch((error: unknown) => {
            if (!(error instanceof NotFoundError)) cleanupErrors.push(error)
          })
        await assert
          .rejects(Sandbox.connect(id, { timeoutMs: 30_000 }), NotFoundError)
          .then(() =>
            appendFile(journal, `${JSON.stringify({ provider: "e2b", id, state: "confirmed-killed-in-finally" })}\n`),
          )
          .catch((error: unknown) => cleanupErrors.push(error))
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "E2B cleanup failed")
    }
  },
)
