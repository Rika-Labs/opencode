import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Scope, Semaphore } from "effect"
import type { DatabaseProvider, RawAccess, SqliteDatabase } from "rivetkit/db"
import type { OpenCode } from "@opencode/sdk/effect"

const live = Boolean(process.env.E2B_API_KEY) && Boolean(process.env.OPENROUTER_API_KEY)
const spend = process.env.E2E_MODEL_LIVE === "1"
const RESULT = "THREAD_E2E_RESULT "

const CONFIG = JSON.stringify({
  model: "or/openai/gpt-4o-mini",
  // The host's shell path does not exist inside the Linux sandbox.
  shell: "/bin/sh",
  providers: {
    or: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://openrouter.ai/api/v1", apiKey: "{env:OPENROUTER_API_KEY}" },
      models: { "openai/gpt-4o-mini": {} },
    },
  },
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  // The tree-sitter scanner loads a wasm module that the workerd conditions below
  // cannot resolve; the portable scanner is pure TypeScript.
  experimental: { portable_shell_scanner: true },
})

const PROMPT =
  "Use the shell tool exactly once to run this command: printf 'APPROVED' > /workspace/e2e-proof.txt && cat /workspace/e2e-proof.txt\nThen reply with exactly: DONE"

describe.skipIf(!live)("thread runtime live end-to-end", () => {
  test.skipIf(!spend)(
    "actor-hosted session drives a real model and a real E2B sandbox",
    async () => {
      if (process.env.OPENCODE_THREAD_E2E_CHILD === "1") {
        process.exit(
          await qualify().then(
            () => 0,
            (cause) => {
              console.error(cause)
              return 1
            },
          ),
        )
      }
      const directory = await mkdtemp(join(tmpdir(), "opencode-thread-e2e-"))
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
            E2B_API_KEY: process.env.E2B_API_KEY,
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
            E2E_MODEL_LIVE: process.env.E2E_MODEL_LIVE,
            OPENCODE_THREAD_E2E_CHILD: "1",
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
        const reported = stdout.split("\n").find((line) => line.startsWith(RESULT))
        expect(reported, `${stdout}\n${stderr}`).toBeString()
        const result = JSON.parse(reported!.slice(RESULT.length))
        expect(result.marker).toBe("APPROVED")
        expect(result.replyCount).toBeGreaterThanOrEqual(1)
        expect(result.destroyed).toBe(true)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    600_000,
  )
})

async function qualify() {
  const { actor, setup } = await import("rivetkit")
  const { createClient } = await import("rivetkit/client")
  const { db } = await import("rivetkit/db")
  const { AbsolutePath, Agent, Location } = await import("@opencode/sdk/effect")
  const { E2BWorkspace } = await import("../src/e2b-workspace")
  const { OpenCodeRivet } = await import("../src/host")
  const require = createRequire(import.meta.resolve("rivetkit"))
  const { getEnginePath } = require("@rivetkit/engine-cli") as { getEnginePath(): string }
  const port = 32000 + Math.floor(Math.random() * 1000) * 10
  const endpoint = `http://127.0.0.1:${port}`
  const mutex = Semaphore.makeUnsafe(1)
  const exclusive = <A, E, R>(_key: string, effect: Effect.Effect<A, E, R>) => mutex.withPermits(1)(effect)
  const raw = db({ warnOnManualTransactions: false })
  const database: DatabaseProvider<RawAccess & { sqlite: SqliteDatabase }> = {
    createClient: (context) => {
      if (!context.nativeDatabaseProvider) return Promise.reject(new Error("Thread actor requires Rivet native SQLite"))
      return context.nativeDatabaseProvider.open(context.actorId).then((sqlite) =>
        raw
          .createClient({ ...context, nativeDatabaseProvider: { open: () => Promise.resolve(sqlite) } })
          .then((client) => ({ ...client, sqlite }))
          .catch((cause: unknown) => sqlite.close().then(() => Promise.reject(cause))),
      )
    },
    onMigrate: (client) => raw.onMigrate(client),
  }
  const thread = actor({
    db: database,
    options: { actionTimeout: 600_000 },
    actions: {
      runTurn: (c, input: { text: string }) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const driver = yield* E2BWorkspace.create({ namespace: "thread-e2e", timeoutMs: 300_000, exclusive })
              const opencode: OpenCode.Interface = yield* OpenCodeRivet.create({
                storage: c.db.sqlite,
                models: { fetch: false },
                config: { content: CONFIG },
                workspaceProviders: { e2b: driver },
              })
              const workspaceID = yield* opencode.workspace.create({ provider: "e2b" })
              const provisioned = yield* opencode.workspace.provision({ workspaceID })
              const session = yield* opencode.sessions.create({
                agent: Agent.ID.make("build"),
                location: Location.Ref.make({ directory: AbsolutePath.make("/workspace"), workspaceID }),
              })
              yield* opencode.sessions.prompt({ sessionID: session.id, text: input.text })
              yield* opencode.sessions.wait({ sessionID: session.id }).pipe(Effect.timeout("480 seconds"))
              const listed = yield* opencode.message.list({ sessionID: session.id })
              const assistants = [...listed.data].filter((message) => message.type === "assistant")
              const texts = assistants
                .flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text))
                .filter((text) => text.trim().length > 0)
              const tools = assistants.flatMap((message) => message.content.filter((part) => part.type === "tool"))
              const marker = yield* Effect.scoped(
                Effect.gen(function* () {
                  const environment = yield* driver.connect({
                    workspaceID,
                    binding: provisioned.binding,
                    saveBinding: () => Effect.void,
                  })
                  const read = environment.overrides?.read
                  if (!read) return yield* Effect.die("E2B connection exposed no file reader")
                  return yield* read("/workspace/e2e-proof.txt").pipe(
                    Effect.map((entry) => new TextDecoder().decode(entry.bytes)),
                    Effect.catchTag("Environment.NotFound", () => Effect.succeed("")),
                  )
                }),
              )
              return {
                sessionID: session.id,
                reply: (texts.at(-1) ?? "").slice(-300),
                replyCount: texts.length,
                toolCount: tools.length,
                marker,
                workspaceID,
                binding: provisioned.binding,
              }
            }),
          ),
        ).catch((cause) => {
          console.error("THREAD_E2E_TURN_FAILURE " + String(cause).slice(0, 800))
          throw cause
        }),
    },
  })
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
  const registry = setup({
    use: { thread },
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
  let destroyed = false
  try {
    const deadline = Date.now() + 30_000
    while (true) {
      if (engine.exitCode !== null) throw new Error(`Native engine exited: ${await errors}\n${await output}`)
      const healthy = await fetch(`${endpoint}/health`).then(
        (response) => response.ok,
        () => false,
      )
      if (healthy) break
      if (Date.now() > deadline) throw new Error("Native engine did not become healthy within 30 seconds")
      await Bun.sleep(100)
    }
    await registry.startAndWait()
    const turned = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            client.thread.getOrCreate([crypto.randomUUID()]).runTurn({ text: PROMPT }),
          )
          const driver = yield* E2BWorkspace.create({ namespace: "thread-e2e", timeoutMs: 60_000, exclusive })
          const cleanup = yield* Effect.scope
          yield* Scope.addFinalizer(
            cleanup,
            driver.destroy({ workspaceID: result.workspaceID, binding: result.binding }).pipe(
              Effect.tap(() => Effect.sync(() => (destroyed = true))),
              Effect.orDie,
            ),
          )
          expect(result.marker).toBe("APPROVED")
          expect(result.replyCount).toBeGreaterThanOrEqual(1)
          return result
        }),
      ),
    )
    expect(destroyed).toBe(true)
    console.log(
      RESULT +
        JSON.stringify({
          sessionID: turned.sessionID,
          reply: turned.reply,
          replyCount: turned.replyCount,
          toolCount: turned.toolCount,
          marker: turned.marker,
          workspaceID: turned.workspaceID,
          destroyed,
        }),
    )
  } finally {
    // registry.shutdown() never returns once a turn has run, so the engine is
    // killed instead and the child exits on its own marker.
    await client.dispose()
    engine.kill("SIGKILL")
    await engine.exited
    await Promise.all([output, errors])
  }
}
