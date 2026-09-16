import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Deferred, Effect, Fiber } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqliteBindings, SqliteDatabase } from "rivetkit/db"
import { EffectDrizzleSqlite } from "@opencode/core/database/drizzle"
import { RivetSqlite } from "../src/sqlite"

// Real in-memory SQLite behind the installed Rivet native-handle contract.
// This tests adaptation, not Rivet durability, transport, or actor lifecycle.
function fixture() {
  const database = new Database(":memory:")
  const calls: string[] = []
  let active = false
  let failCommit = false
  const execute = async (sql: string, params?: SqliteBindings) => {
    const statement = database.prepare(sql)
    const rows = statement.values(...((params ?? []) as Array<string | number | null | Uint8Array>)) ?? []
    return { columns: statement.columnNames, rows, changes: 0 }
  }
  const storage: SqliteDatabase = {
    async execute(sql, params) {
      if (active) throw new Error("Statement escaped the transaction handle")
      calls.push("execute")
      return execute(sql, params)
    },
    async exec(sql) {
      database.exec(sql)
    },
    async executeBatch() {
      throw new Error("Unused by adapter")
    },
    async beginTransaction() {
      calls.push("begin")
      database.exec("BEGIN")
      active = true
      return {
        async execute(sql, params) {
          calls.push("transaction.execute")
          return execute(sql, params)
        },
        async exec(sql) {
          database.exec(sql)
        },
        async commit() {
          calls.push("commit")
          if (failCommit) throw new Error("Commit failed")
          database.exec("COMMIT")
          active = false
        },
        async rollback() {
          calls.push("rollback")
          database.exec("ROLLBACK")
          active = false
        },
      }
    },
    async query(sql, params) {
      return execute(sql, params)
    },
    async run(sql, params) {
      await execute(sql, params)
    },
    async close() {
      calls.push("close")
      database.close()
    },
  }
  return {
    storage,
    calls,
    failCommit: () => {
      failCommit = true
    },
    [Symbol.dispose]: () => database.close(),
  }
}

test("uses actor-owned SQLite and preserves positional rows and bindings", async () => {
  using f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT, data BLOB)`
      yield* sql`INSERT INTO items VALUES (${1}, ${"hello"}, ${new Uint8Array([1, 2, 3])})`
      expect(yield* sql`SELECT id, value, data FROM items`).toEqual([
        { id: 1, value: "hello", data: new Uint8Array([1, 2, 3]) },
      ])
      expect(yield* sql`SELECT 1 AS id, 2 AS id, NULL AS empty`.values).toEqual([[1, 2, null]])
      expect(yield* sql`SELECT 'literal;semicolon' AS value`).toEqual([{ value: "literal;semicolon" }])
    }).pipe(Effect.provide(RivetSqlite.sqliteLayer({ storage: f.storage }))),
  )
  expect(f.calls).not.toContain("close")
  expect(await f.storage.query("SELECT count(*) AS count FROM items")).toMatchObject({ rows: [[1]] })
})

test("commits through the transaction handle and rolls back failures and nesting", async () => {
  using f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`
      expect(yield* sql.withTransaction(sql`INSERT INTO items VALUES (1)`.pipe(Effect.as("committed")))).toBe(
        "committed",
      )
      expect(
        (yield* Effect.exit(
          sql.withTransaction(sql`INSERT INTO items VALUES (2)`.pipe(Effect.andThen(Effect.fail("abort")))),
        ))._tag,
      ).toBe("Failure")
      const nested = yield* Effect.exit(sql.withTransaction(sql.withTransaction(sql`INSERT INTO items VALUES (3)`)))
      expect(nested._tag).toBe("Failure")
      expect(yield* sql`SELECT id FROM items`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(RivetSqlite.sqliteLayer({ storage: f.storage }))),
  )
  expect(f.calls.filter((call) => call === "begin")).toHaveLength(3)
  expect(f.calls.filter((call) => call === "commit")).toHaveLength(1)
  expect(f.calls.filter((call) => call === "rollback")).toHaveLength(2)
})

test("rolls back failed commit", async () => {
  using f = fixture()
  f.failCommit()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`
      const result = yield* Effect.exit(sql.withTransaction(sql`INSERT INTO items VALUES (1)`))
      expect(result._tag).toBe("Failure")
      expect(yield* sql`SELECT id FROM items`).toEqual([])
    }).pipe(Effect.provide(RivetSqlite.sqliteLayer({ storage: f.storage }))),
  )
  expect(f.calls).toContain("rollback")
})

test("core Drizzle routes transaction statements through Rivet", async () => {
  using f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
      yield* db.transaction((tx) => tx.run("INSERT INTO items VALUES (7, 'drizzle')"))
      expect(yield* db.all("SELECT * FROM items")).toEqual([{ id: 7, value: "drizzle" }])
      expect(yield* db.values("SELECT 1 AS id, 2 AS id")).toEqual([[1, 2]])
      expect(yield* sql`SELECT count(*) AS count FROM items`).toEqual([{ count: 1 }])
    }).pipe(Effect.provide(RivetSqlite.sqliteLayer({ storage: f.storage }))),
  )
  expect(f.calls).toContain("transaction.execute")
  expect(f.calls).toContain("commit")
})

test("interrupting a transaction waits for rollback", async () => {
  using f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const ready = yield* Deferred.make<void>()
      yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`
      const fiber = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO items VALUES (1)`
            yield* Deferred.succeed(ready, undefined)
            yield* Effect.never
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      expect(yield* sql`SELECT id FROM items`).toEqual([])
    }).pipe(Effect.provide(RivetSqlite.sqliteLayer({ storage: f.storage }))),
  )
  expect(f.calls).toContain("rollback")
})
