export * as RivetSqlite from "./sqlite"

import { Context, Effect, Exit, Layer } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { SqlClient, Statement } from "effect/unstable/sql"
import { classifySqliteError, SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import type { SqliteBindings, SqliteDatabase } from "rivetkit/db"
import { Sqlite } from "@opencode/core/database/sqlite"

export interface Options extends Sqlite.ClientConfig {
  /** Actor-owned native handle supplied by Rivet's nativeDatabaseProvider.open(actorId). */
  readonly storage: SqliteDatabase
}

// Rivet promises have no cancellation API. Wait for in-flight SQL before rollback
// or returning interruption, and never abandon a newly acquired transaction.
const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SqlError({ reason: classifySqliteError(cause, { operation }) }),
  }).pipe(Effect.uninterruptible)

// Use the native result's columns and rows, not RawAccess.execute(): object rows
// discard duplicate column names needed by Drizzle's positional query mapper.
const connection = (storage: Pick<SqliteDatabase, "execute">) => {
  const execute = (query: string, params: ReadonlyArray<unknown> = []) =>
    attempt("execute", () => storage.execute(query, [...params]))
  const value = (input: unknown) => (input instanceof ArrayBuffer ? new Uint8Array(input) : input)
  return Sqlite.makeConnection(
    (query, params) =>
      execute(query, params).pipe(
        Effect.map((result) =>
          result.rows.map((row) =>
            Object.fromEntries(result.columns.map((column, index) => [column, value(row[index])])),
          ),
        ),
      ),
    (query, params) => execute(query, params).pipe(Effect.map((result) => result.rows.map((row) => row.map(value)))),
    {},
  )
}

/**
 * Borrows actor-owned SQLite; disposing this layer never closes the actor's DB.
 * Compose with Database.configuredClient(sqliteLayer({ storage })). Rivet's
 * native transaction lease coordinates access; never emulate it with SQL BEGIN.
 */
export const sqliteLayer = (options: Options) => {
  const native = Layer.succeed(Sqlite.Native, options.storage)
  const client = Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const storage = options.storage
      const client = yield* SqlClient.make({
        acquirer: Effect.succeed(connection(storage)),
        compiler: Statement.makeCompilerSqlite(options.transformQueryNames),
        spanAttributes: [...Object.entries(options.spanAttributes ?? {}), ["db.system.name", "sqlite"]],
        transformRows: options.transformResultNames
          ? Statement.defaultTransforms(options.transformResultNames).array
          : undefined,
      })
      // Statements inside withTransaction route through this per-client
      // transaction tag instead of raw storage.
      const transactionService = client.transactionService
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.withFiber((fiber) => {
            const services = fiber.context
            if (Context.getOption(services, transactionService)._tag === "Some")
              return Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    cause: new Error("Nested Rivet SQLite transactions are not supported"),
                    operation: "transaction",
                  }),
                }),
              )
            return Effect.gen(function* () {
              const transaction = yield* attempt("beginTransaction", () => storage.beginTransaction())
              const result = yield* Effect.exit(
                Effect.provideContext(
                  restore(effect),
                  Context.add(services, transactionService, [connection(transaction), 0] as const),
                ),
              )
              const rollback = attempt("rollback", () => transaction.rollback()).pipe(Effect.catch(() => Effect.void))
              if (Exit.isFailure(result)) {
                yield* rollback
                return yield* result
              }
              yield* attempt("commit", () => transaction.commit()).pipe(
                Effect.catch((error) => rollback.pipe(Effect.andThen(Effect.fail(error)))),
              )
              return result.value
            })
          }),
        )
      return Object.assign(client, { withTransaction, transactionStatements: false as const })
    }),
  )
  return Layer.merge(native, client).pipe(Layer.provide(Reactivity.layer))
}
