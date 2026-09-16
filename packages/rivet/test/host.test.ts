import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { AbsolutePath, Agent, Location, SessionMessage } from "@opencode/sdk/effect"
import { OpenCode } from "@opencode/sdk/effect"
import type { SqliteBindings, SqliteDatabase } from "rivetkit/db"
import { OpenCodeRivet } from "../src/host"

// Actor-owned storage shape behind the Rivet native-handle contract.
// Shared :memory: database models one actor database across activations;
// this tests adaptation and recovery, not Rivet durability or transport.
function storage() {
  const database = new Database(":memory:")
  const run = async (sql: string, params?: SqliteBindings) => {
    const statement = database.prepare(sql)
    const rows = statement.values(...((params ?? []) as Array<string | number | null | Uint8Array>)) ?? []
    return { columns: statement.columnNames, rows, changes: 0 }
  }
  let active = false
  const handle: SqliteDatabase = {
    async execute(sql, params) {
      if (active) throw new Error("Statement escaped the transaction handle")
      return run(sql, params)
    },
    async exec(sql) {
      database.exec(sql)
    },
    async executeBatch() {
      throw new Error("Unused by adapter")
    },
    async beginTransaction() {
      database.exec("BEGIN")
      active = true
      return {
        async execute(sql, params) {
          return run(sql, params)
        },
        async exec(sql) {
          database.exec(sql)
        },
        async commit() {
          database.exec("COMMIT")
          active = false
        },
        async rollback() {
          database.exec("ROLLBACK")
          active = false
        },
      }
    },
    async query(sql, params) {
      return run(sql, params)
    },
    async run(sql, params) {
      await run(sql, params)
    },
    async close() {
      database.close()
    },
  }
  return { handle, [Symbol.dispose]: () => database.close() }
}

const boot = (handle: SqliteDatabase, directory: string) =>
  OpenCodeRivet.create({
    storage: handle,
    models: { fetch: false },
    config: { content: JSON.stringify({ directory, project: false }) },
  })

const locate = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

test("actor SQLite backs prompt admission with message-ID idempotency", async () => {
  using store = storage()
  const directory = mkdtempSync(join(tmpdir(), "opencode-rivet-host-"))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode: OpenCode.Interface = yield* boot(store.handle, directory)
        const session = yield* opencode.sessions.create({
          agent: Agent.ID.make("build"),
          location: locate(directory),
        })
        const messageID = SessionMessage.ID.create()
        const first = yield* opencode.sessions.prompt({
          sessionID: session.id,
          id: messageID,
          text: "first admission",
          resume: false,
        })
        const second = yield* opencode.sessions.prompt({
          sessionID: session.id,
          id: messageID,
          text: "retried payload is ignored",
          resume: false,
        })
        expect(second.id).toBe(first.id)
        const pending = yield* opencode.sessions.inbox.list({ sessionID: session.id })
        expect(pending).toHaveLength(1)
      }),
    ),
  )
})

test("admitted work survives host reactivation on the same actor database", async () => {
  using store = storage()
  const directory = mkdtempSync(join(tmpdir(), "opencode-rivet-reactivate-"))
  const sessionID = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode: OpenCode.Interface = yield* boot(store.handle, directory)
        const session = yield* opencode.sessions.create({
          agent: Agent.ID.make("build"),
          location: locate(directory),
        })
        yield* opencode.sessions.prompt({ sessionID: session.id, text: "durable work", resume: false })
        return session.id
      }),
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode: OpenCode.Interface = yield* boot(store.handle, directory)
        const recovered = yield* opencode.sessions.get({ sessionID })
        expect(recovered.id).toBe(sessionID)
        const pending = yield* opencode.sessions.inbox.list({ sessionID })
        expect(pending).toHaveLength(1)
      }),
    ),
  )
})

test("separate actor databases isolate sessions", async () => {
  using first = storage()
  using second = storage()
  const directory = mkdtempSync(join(tmpdir(), "opencode-rivet-isolate-"))
  const sessionID = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode: OpenCode.Interface = yield* boot(first.handle, directory)
        const session = yield* opencode.sessions.create({
          agent: Agent.ID.make("build"),
          location: locate(directory),
        })
        return session.id
      }),
    ),
  )
  const missing = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode: OpenCode.Interface = yield* boot(second.handle, directory)
        return yield* opencode.sessions.get({ sessionID })
      }),
    ),
  )
  expect(missing._tag).toBe("Failure")
})
