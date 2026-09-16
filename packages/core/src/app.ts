export * as AppV2 from "./app"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { App } from "@opencode-ai/schema/app"
import { ConfigMCP } from "./config/mcp"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { McpV2 } from "./mcp"
import { AbsolutePath } from "./schema"
import { SkillV2 } from "./skill"
import { State } from "./state"
import { WorkspaceFileSystem } from "./workspace-capability"

export const ID = App.ID
export type ID = App.ID

export const Manifest = App.Manifest
export type Manifest = App.Manifest

export const Info = App.Info
export type Info = App.Info

export const Status = App.Status
export type Status = App.Status

export type Csp = App.Csp
export type Permissions = App.Permissions

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("AppV2.NotFoundError", {
  id: Schema.String,
}) {}

export class AssetError extends Schema.TaggedErrorClass<AssetError>()("AppV2.AssetError", {
  id: Schema.String,
  message: Schema.String,
}) {}

export type Authority = "trusted-global" | "workspace"

type SourceRecord = {
  readonly directory: AbsolutePath
  readonly authority: Authority
}

export type Data = {
  apps: SourceRecord[]
}

export type Draft = {
  app: (directory: AbsolutePath, authority?: Authority) => void
  list: () => readonly AbsolutePath[]
}

type InternalDraft = Draft & { readonly records: () => readonly SourceRecord[] }

export type Asset = {
  readonly path: AbsolutePath
  readonly mime: string
  readonly read: Effect.Effect<Uint8Array, AssetError>
}

export interface Interface extends State.Transformable<Draft> {
  readonly list: () => Effect.Effect<ReadonlyArray<App.Info>>
  readonly get: (id: App.ID) => Effect.Effect<App.Info, NotFoundError>
  readonly asset: (id: App.ID, requestPath: string) => Effect.Effect<Asset, NotFoundError | AssetError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/App") {}

type Loaded =
  | {
      readonly directory: AbsolutePath
      readonly authority: Authority
      readonly manifest: App.Manifest
      readonly skillDirs: AbsolutePath[]
      readonly webRoot?: AbsolutePath
    }
  | {
      readonly directory: AbsolutePath
      readonly authority: Authority
      readonly error: string
      readonly id?: App.ID
    }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const workspaceFs = yield* WorkspaceFileSystem.Service
    const mcp = yield* McpV2.Service
    const skill = yield* SkillV2.Service

    const fsFor = (authority: Authority) => (authority === "workspace" ? workspaceFs : fs)

    let loaded: Loaded[] = []

    const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(App.Manifest))
    const decodeID = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id: App.ID })))

    function toServerConfig(directory: AbsolutePath, server: App.McpServer): ConfigMCP.ServerConfig {
      if (server.type === "remote")
        return new ConfigMCP.Remote({
          type: "remote",
          url: server.url,
          headers: server.headers,
          timeout: server.timeout,
        })
      return new ConfigMCP.Local({
        type: "local",
        command: [...server.command],
        cwd: server.cwd ? path.resolve(directory, server.cwd) : directory,
        environment: server.environment,
        timeout: server.timeout,
      })
    }

    function fallbackManifest(item: Extract<Loaded, { error: string }>): App.Manifest {
      const name = path.basename(item.directory).toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "invalid"
      return Manifest.make({ id: item.id ?? App.ID.make(`app_${name}`), name, version: "0.0.0" })
    }

    const contained = Effect.fn("AppV2.contained")(function* (
      source: FSUtil.Interface,
      directory: AbsolutePath,
      entries: readonly string[],
    ) {
      const root = yield* source.resolve(directory)
      const result: AbsolutePath[] = []
      for (const entry of entries) {
        const resolved = path.resolve(directory, entry)
        if (!FSUtil.contains(root, yield* source.resolve(resolved))) {
          yield* Effect.logWarning("Ignoring skill directory outside the app directory", { directory, entry })
          continue
        }
        result.push(AbsolutePath.make(resolved))
      }
      return result
    })

    const load = Effect.fn("AppV2.load")(function* (record: SourceRecord) {
      const source = fsFor(record.authority)
      const content = yield* source
        .readFileStringSafe(path.join(record.directory, "app.json"))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content === undefined) return { ...record, error: "missing or unreadable app.json" } satisfies Loaded
      const manifest = decodeManifest(content).valueOrUndefined
      if (!manifest)
        return {
          ...record,
          error: "invalid app.json manifest",
          id: decodeID(content).valueOrUndefined?.id,
        } satisfies Loaded
      const real = yield* source.resolve(record.directory)
      const server = manifest.mcp
      if (
        server?.type === "local" &&
        server.cwd !== undefined &&
        !FSUtil.contains(real, yield* source.resolve(path.resolve(record.directory, server.cwd)))
      )
        return {
          ...record,
          error: `mcp.cwd escapes the app directory: ${server.cwd}`,
          id: manifest.id,
        } satisfies Loaded
      const skillDirs = yield* contained(source, record.directory, manifest.skills ?? [])
      if (!manifest.web) return { ...record, manifest, skillDirs } satisfies Loaded
      const webRoot = path.resolve(record.directory, manifest.web.root)
      if (!FSUtil.contains(real, yield* source.resolve(webRoot)))
        return {
          ...record,
          error: `web.root escapes the app directory: ${manifest.web.root}`,
          id: manifest.id,
        } satisfies Loaded
      return { ...record, manifest, skillDirs, webRoot: AbsolutePath.make(webRoot) } satisfies Loaded
    })

    function info(item: Loaded, mcpStatuses: Record<string, McpV2.ServerStatus>): App.Info {
      if (!("manifest" in item))
        return {
          manifest: fallbackManifest(item),
          directory: item.directory,
          hasWeb: false,
          status: { status: "failed", error: item.error },
        }
      const serverStatus = item.manifest.mcp ? mcpStatuses[item.manifest.id] : undefined
      return {
        manifest: item.manifest,
        directory: item.directory,
        mcpServer: item.manifest.mcp ? item.manifest.id : undefined,
        hasWeb: item.webRoot !== undefined,
        status:
          serverStatus?.status === "failed" ? { status: "failed", error: serverStatus.error } : { status: "active" },
      }
    }

    const state = State.create<Data, InternalDraft>({
      initial: () => ({ apps: [] }),
      draft: (data) => {
        const draft: InternalDraft = {
          app: (directory, authority = "trusted-global") => {
            if (data.apps.some((item) => item.directory === directory)) return
            data.apps.push({ directory, authority })
          },
          list: () => data.apps.map((item) => item.directory),
          records: () => data.apps,
        }
        return draft
      },
      finalize: Effect.fn("AppV2.finalize")(function* (draft) {
        const items = yield* Effect.forEach(draft.records(), load)
        const seen = new Set<string>()
        loaded = items.map((item) => {
          if (!("manifest" in item)) return item
          if (seen.has(item.manifest.id))
            return {
              directory: item.directory,
              authority: item.authority,
              error: "duplicate app id",
              id: item.manifest.id,
            }
          seen.add(item.manifest.id)
          return item
        })
        yield* mcp.reload()
        yield* skill.reload()
      }),
    })

    yield* mcp.transform((draft) => {
      for (const item of loaded)
        if ("manifest" in item && item.manifest.mcp)
          draft.server(item.manifest.id, toServerConfig(item.directory, item.manifest.mcp), item.authority)
    })
    yield* skill.transform((draft) => {
      for (const item of loaded)
        if ("manifest" in item)
          for (const directory of item.skillDirs)
            draft.source(
              SkillV2.DirectorySource.make({
                type: "directory",
                path: directory,
              }),
              item.authority,
            )
    })

    const infos = Effect.fn("AppV2.list")(function* () {
      const mcpStatuses = yield* mcp.status()
      return loaded.map((item) => info(item, mcpStatuses))
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      list: infos,
      get: Effect.fn("AppV2.get")(function* (id) {
        const item = (yield* infos()).find((entry) => entry.manifest.id === id)
        if (!item) return yield* new NotFoundError({ id })
        return item
      }),
      asset: Effect.fn("AppV2.asset")(function* (id, requestPath) {
        const item = loaded.find(
          (entry): entry is Extract<Loaded, { manifest: App.Manifest }> =>
            "manifest" in entry && entry.manifest.id === id,
        )
        if (!item || !item.manifest.web || !item.webRoot) return yield* new NotFoundError({ id })
        const decoded = yield* Effect.try({
          try: () => decodeURIComponent(requestPath),
          catch: () => new AssetError({ id, message: `invalid asset path: ${requestPath}` }),
        })
        const relative = decoded === "" || decoded === "/" ? item.manifest.web.entry : decoded
        if (relative.startsWith("/"))
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        const normalized = path.posix.normalize(relative)
        if (
          normalized.includes("\0") ||
          path.isAbsolute(normalized) ||
          normalized === ".." ||
          normalized.startsWith("../")
        )
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        const resolved = path.resolve(item.webRoot, normalized)
        if (!FSUtil.contains(item.webRoot, resolved))
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        const source = fsFor(item.authority)
        const realRoot = yield* source.resolve(item.webRoot)
        if (!FSUtil.contains(realRoot, yield* source.resolve(resolved)))
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        if (!(yield* source.isFile(resolved)))
          return yield* new AssetError({ id, message: `unable to read asset: ${normalized}` })
        return {
          path: AbsolutePath.make(resolved),
          mime: FSUtil.mimeType(resolved),
          read: fsFor(item.authority)
            .readFile(resolved)
            .pipe(Effect.mapError(() => new AssetError({ id, message: `unable to read asset: ${normalized}` }))),
        }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, WorkspaceFileSystem.node, McpV2.node, SkillV2.node],
})
