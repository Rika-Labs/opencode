export * as OpenCodeRivet from "./host"

import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Database } from "@opencode/core/database/database"
import { EnvironmentUnavailable } from "@opencode/core/environment/unavailable"
import { FileSystem } from "@opencode/core/filesystem"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import type { ModelsDev } from "@opencode/core/models-dev"
import { Pty } from "@opencode/core/pty"
import { Snapshot } from "@opencode/core/snapshot"
import { Vcs } from "@opencode/core/vcs"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { OpenCode } from "@opencode/sdk/effect"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Config, Scope } from "effect"
import { db } from "rivetkit/db"
import type { DatabaseProvider, RawAccess, SqliteDatabase } from "rivetkit/db"
import type { PromiseSdk } from "../../sdk/src/promise"
import { RivetSqlite } from "./sqlite"

/**
 * Rivet runtime profile: one embedded OpenCode host per actor activation,
 * backed by actor-owned SQLite. Mirrors the workerd profile's replacement
 * strategy; the database replacement here is the Rivet SQLite adapter.
 *
 * Replacements install before startup recovery begins. The runtime fails
 * closed with no workspace provider: no host-local tool fallback.
 */
export interface Options {
  /** Actor-owned handle from `nativeDatabaseProvider.open(actorId)`. */
  readonly storage: SqliteDatabase
  readonly app?: OpenCode.CreateOptions["app"]
  readonly config?: { readonly content?: string }
  readonly models?: ModelsDev.Options
}

export interface CreateOptions<R = never> extends Options {
  readonly log?: OpenCode.CreateOptions["log"]
  readonly workspaceProviders?: OpenCode.CreateOptions["workspaceProviders"]
  readonly instances?: OpenCode.CreateOptions<R>["instances"]
}

export function serverOptions(options: Options) {
  return {
    app: options.app,
    fs: { filewatcher: false, fff: false },
    // Durable event history is how a turn orphaned by actor death is
    // recovered: boot-time resume replays it. Not exposed as an option.
    events: { persist: true },
    config: { content: options.config?.content },
    models: options.models,
  }
}

/** Local-service replacements; database replacement is actor SQLite. */
export function replacements(options: Options): LayerNode.Replacements {
  return [
    Database.node.replace(Database.configuredClient(RivetSqlite.sqliteLayer({ storage: options.storage }))),
    CrossSpawnSpawner.node.replace(EnvironmentUnavailable.layer),
    Snapshot.node.replace(Snapshot.noopLayer),
    Vcs.node.replace(vcsLayer),
    FileSystem.node.replace(fileSystemLayer),
    FileSystemSearch.node.replace(fileSystemSearchLayer),
    Pty.node.replace(ptyLayer),
    ConfigPluginSource.node.replace(ConfigPluginSource.empty),
  ]
}

export function make(options: Options) {
  return {
    options: serverOptions(options),
    replacements: replacements(options),
  }
}

export const create = <R = never>({ log, workspaceProviders, instances, ...options }: CreateOptions<R>) => {
  const profile = make(options)
  return OpenCode.create(
    { ...profile.options, log, workspaceProviders, instances },
    { overrides: profile.replacements },
  )
}

export const layer = <R = never>(
  options: CreateOptions<R>,
): Layer.Layer<OpenCode.Service, Config.ConfigError | Error, Exclude<R, Scope.Scope>> =>
  Layer.effect(OpenCode.Service, create(options))

export type Interface = OpenCode.Interface
export type Requirements = Scope.Scope

export interface ActorClient extends RawAccess {
  readonly storage: SqliteDatabase
  readonly opencode: PromiseSdk.Interface
}

export interface DatabaseOptions extends Omit<Options, "storage"> {
  readonly workspaceProviders?: Readonly<Record<string, WorkspaceDriver.Interface>>
}

/**
 * Native actor database provider, rebuilt by Rivet on each wake. Qualified on
 * NAPI sqlite: "local" with Core's `workerd` condition (pragma guards/stubs).
 * Default Bun Core enables WAL and Rivet 2.3.17 fails reopening after sleep
 * with SQLite code 14. This does not qualify the Cloudflare runtime.
 */
export function database(options: DatabaseOptions = {}): DatabaseProvider<ActorClient> {
  const { workspaceProviders, ...rest } = options
  const raw = db()
  return {
    async createClient(context) {
      if (!context.nativeDatabaseProvider)
        throw new Error("OpenCodeRivet requires the actor runtime's nativeDatabaseProvider")
      const storage = await context.nativeDatabaseProvider.open(context.actorId)
      const client = await raw.createClient(context)
      const { PromiseSdk } = await import("@opencode/sdk")
      const profile = make({ ...rest, storage })
      const opencode = await PromiseSdk.create(
        { ...profile.options, workspaceProviders },
        { overrides: profile.replacements },
      )
      return {
        ...client,
        storage,
        opencode,
        // Rivet owns native SQLite closure; disposing the SDK only releases its
        // fibers/layers. Closing RawAccess here would close the shared handle.
        close: () => opencode.close(),
      }
    },
    onMigrate() {},
  }
}

const unavailable = (what: string) => Effect.die(new Error(`${what} is unavailable in the Rivet profile`))

const vcsLayer = Layer.succeed(
  Vcs.Service,
  Vcs.Service.of({
    base: () => Effect.succeed(null),
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    info: () => Effect.succeed({ branch: {} }),
    branches: () => Effect.succeed([]),
    status: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
  }),
)

const fileSystemLayer = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({
    read: () => unavailable("FileSystem.read"),
    list: () => unavailable("FileSystem.list"),
    find: () => unavailable("FileSystem.find"),
  }),
)

const fileSystemSearchLayer = Layer.succeed(
  FileSystemSearch.Service,
  FileSystemSearch.Service.of({
    find: () => unavailable("FileSystemSearch.find"),
  }),
)

const ptyLayer = Layer.succeed(
  Pty.Service,
  Pty.Service.of({
    list: () => Effect.succeed([]),
    get: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    create: () => unavailable("Pty.create"),
    update: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    remove: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    write: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    attach: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
  }),
)
