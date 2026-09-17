import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Run in an isolated process: both Rivet and OpenCode read runtime directories
// from the environment. Never borrow a running developer engine or credentials.
test("native actor SQLite hosts embedded sessions across sleep/wake", async () => {
  if (process.env.OPENCODE_RIVET_QUALIFICATION_CHILD === "1") return qualify()
  const directory = await mkdtemp(join(tmpdir(), "opencode-rivet-host-"))
  try {
    // This selects Core's pragma guards/native-module stubs, NOT Cloudflare
    // storage. Actual SQL uses Rivet NAPI + its LocalNative backend below.
    // Without these guards Core enables WAL; Rivet 2.3.17 then fails reopening
    // the actor at PRAGMA journal_mode=DELETE (SQLite code 14) after sleep.
    const child = Bun.spawn([process.execPath, "--conditions=workerd", "test", import.meta.path], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
        RIVETKIT_STORAGE_PATH: directory,
        RIVETKIT_ENGINE_AUTO_DOWNLOAD: "0",
        RIVET__TELEMETRY__ENABLED: "false",
        OPENCODE_RIVET_QUALIFICATION_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain("Native SQLite session/inbox sleep-wake qualification passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)

async function qualify() {
  const { actor, setup } = await import("rivetkit")
  const { createClient } = await import("rivetkit/client")
  const { OpenCodeRivet } = await import("../src/host")
  const { Effect } = await import("effect")
  const require = createRequire(import.meta.resolve("rivetkit"))
  const { getEnginePath } = require("@rivetkit/engine-cli") as { getEnginePath(): string }
  const port = 30000 + Math.floor(Math.random() * 2000) * 10
  const endpoint = `http://127.0.0.1:${port}`
  await mkdir(join(process.env.HOME!, "engine"), { recursive: true })
  const engine = Bun.spawn([getEnginePath(), "start"], {
    env: {
      ...process.env,
      RIVET__GUARD__HOST: "127.0.0.1",
      RIVET__GUARD__PORT: String(port),
      RIVET__API_PEER__HOST: "127.0.0.1",
      RIVET__API_PEER__PORT: String(port + 1),
      RIVET__METRICS__HOST: "127.0.0.1",
      RIVET__METRICS__PORT: String(port + 10),
      // RivetKit's engine manager creates the default storage root, but a
      // custom file system path is consumed verbatim by the engine.
      RIVET__FILE_SYSTEM__PATH: join(process.env.HOME!, "engine"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = new Response(engine.stdout).text()
  const errors = new Response(engine.stderr).text()
  const asleep = Promise.withResolvers<void>()
  const probe = actor({
    db: OpenCodeRivet.database({
      config: { content: "{}" },
      models: { fetch: false },
      workspaceProviders: {
        probe: {
          create: () => Effect.succeed({ binding: {} }),
          connect: () => Effect.die(new Error("probe connect is not implemented")),
          suspendForIdle: () => Effect.void,
          destroy: () => Effect.void,
        },
      },
    }),
    createVars: () => ({ generation: crypto.randomUUID() }),
    onSleep: () => asleep.resolve(),
    actions: {
      async create(c) {
        const session = await c.db.opencode.sessions.create({
          agent: "build",
          location: { directory: process.env.HOME! },
        })
        await c.db.opencode.sessions.prompt({ sessionID: session.id, text: "Persist without model execution", resume: false })
        return { session, generation: c.vars.generation, actorID: c.actorId }
      },
      async read(c, sessionID: string) {
        return {
          session: await c.db.opencode.sessions.get({ sessionID }),
          inbox: await c.db.opencode.sessions.inbox.list({ sessionID }),
          generation: c.vars.generation,
          actorID: c.actorId,
          sqlite: await c.db.storage.execute("SELECT sqlite_version() AS version"),
        }
      },
      async workspace(c, provider: string) {
        const workspaceID = await c.db.opencode.workspace.create({ provider })
        return { workspaceID }
      },
      sleep(c) { c.sleep() },
    },
  })
  const registry = setup({
    use: { probe },
    runtime: "native",
    sqlite: "local",
    endpoint,
    token: "",
    namespace: "default",
    startEngine: false,
    startServices: false,
    noWelcome: true,
    shutdown: { disableSignalHandlers: true, gracePeriodMs: 1000 },
  })
  const client = createClient<typeof registry>({ endpoint, token: "", namespace: "default" })
  try {
    const deadline = Date.now() + 15_000
    while (true) {
      if (engine.exitCode !== null) throw new Error(`Native engine exited: ${await errors}\n${await output}`)
      if (await fetch(`${endpoint}/health`).then((r) => r.ok, () => false)) break
      if (Date.now() > deadline) throw new Error("Native engine did not become healthy within 15 seconds")
      await Bun.sleep(100)
    }
    await registry.startAndWait()
    const handle = client.probe.getOrCreate([crypto.randomUUID()])
    const first = await handle.create()
    const workspace = await handle.workspace("probe")
    expect(workspace.workspaceID).toBeString()
    await expect(handle.workspace("missing")).rejects.toThrow()
    const before = await handle.read(first.session.id)
    expect(before.inbox).toHaveLength(1)
    await handle.sleep()
    await asleep.promise
    // Native cleanup runs after onSleep. The next action must be routed to a
    // fresh actor generation, rather than retaining the prior SDK instance.
    const after = await handle.read(first.session.id)
    expect(after.actorID).toBe(first.actorID)
    expect(after.generation).not.toBe(first.generation)
    expect(after.session.id).toBe(first.session.id)
    expect(after.inbox).toEqual(before.inbox)
    expect(after.sqlite.rows[0]?.[0]).toBeString()
    console.log("Native SQLite session/inbox sleep-wake qualification passed")
  } finally {
    await client.dispose()
    await registry.shutdown()
    engine.kill("SIGKILL")
    await engine.exited
    await Promise.all([output, errors])
  }
}
