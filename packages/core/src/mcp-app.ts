export * as AppV2 from "./mcp-app.js"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { App } from "@opencode/schema/app"
import { Mcp as McpSchema } from "@opencode/schema/mcp"
import { FSUtil } from "@opencode/util/fs-util"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SkillFile } from "./config/plugin/skill-file.js"
import { Mcp } from "./mcp/index.js"
import { AbsolutePath } from "./schema.js"
import { Skill } from "./skill.js"
import { State } from "./state.js"

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

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("AppV2.NotFoundError", {
  id: Schema.String,
}) {}

export class AssetError extends Schema.TaggedError<AssetError>()("AppV2.AssetError", {
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

export type Editor = {
  app: (directory: AbsolutePath, authority?: Authority) => void
  list: () => readonly AbsolutePath[]
}

export type Asset = {
  readonly path: AbsolutePath
  readonly mime: string
  readonly read: Effect.Effect<Uint8Array, AssetError>
}

export interface Interface extends State.Transformable<Editor> {
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
      readonly skills: Skill.Info[]
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
    const mcp = yield* Mcp.Service
    const skill = yield* Skill.Service
    let loaded: Loaded[] = []

    const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(App.Manifest))
    const decodeID = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id: App.ID })))

    const toServerConfig = (directory: AbsolutePath, server: App.McpServer): McpSchema.ServerConfig => {
      const timeout = server.timeout
        ? new McpSchema.TimeoutConfig({
            startup: server.timeout.startup,
            execution: server.timeout.request,
          })
        : undefined
      if (server.type === "remote") {
        return new McpSchema.RemoteConfig({
          type: "remote",
          url: server.url,
          headers: server.headers,
          timeout,
        })
      }
      return new McpSchema.LocalConfig({
        type: "local",
        command: [...server.command],
        cwd: server.cwd ? path.resolve(directory, server.cwd) : directory,
        environment: server.environment,
        timeout,
      })
    }

    const fallbackManifest = (item: Extract<Loaded, { error: string }>): App.Manifest => {
      const name = path.basename(item.directory).toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "invalid"
      return Manifest.make({ id: item.id ?? App.ID.make(`app_${name}`), name, version: "0.0.0" })
    }

    const contained = Effect.fn("AppV2.contained")(function* (directory: AbsolutePath, entries: readonly string[]) {
      const root = yield* fs.resolve(directory)
      const result: AbsolutePath[] = []
      for (const entry of entries) {
        const resolved = path.resolve(directory, entry)
        if (!FSUtil.contains(root, yield* fs.resolve(resolved))) {
          yield* Effect.logWarning("Ignoring skill directory outside the app directory", { directory, entry })
          continue
        }
        result.push(AbsolutePath.make(resolved))
      }
      return result
    })

    const loadSkills = Effect.fn("AppV2.loadSkills")(function* (directories: readonly AbsolutePath[]) {
      const skills: Skill.Info[] = []
      for (const directory of directories) {
        const files = yield* fs
          .scan("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.orElseSucceed(() => [] as string[]))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
          if (!content) continue
          const parsed = SkillFile.parse(directory, filepath, content)
          if (parsed._tag === "Parsed") skills.push(parsed.skill)
        }
      }
      return skills
    })

    const load = Effect.fn("AppV2.load")(function* (record: SourceRecord) {
      const content = yield* fs
        .readFileStringSafe(path.join(record.directory, "app.json"))
        .pipe(Effect.orElseSucceed(() => undefined))
      if (content === undefined) return { ...record, error: "missing or unreadable app.json" } satisfies Loaded
      const manifest = decodeManifest(content).valueOrUndefined
      if (!manifest) {
        return {
          ...record,
          error: "invalid app.json manifest",
          id: decodeID(content).valueOrUndefined?.id,
        } satisfies Loaded
      }
      const real = yield* fs.resolve(record.directory)
      const server = manifest.mcp
      if (
        server?.type === "local" &&
        server.cwd !== undefined &&
        !FSUtil.contains(real, yield* fs.resolve(path.resolve(record.directory, server.cwd)))
      ) {
        return {
          ...record,
          error: `mcp.cwd escapes the app directory: ${server.cwd}`,
          id: manifest.id,
        } satisfies Loaded
      }
      const skillDirs = yield* contained(record.directory, manifest.skills ?? [])
      const skills = yield* loadSkills(skillDirs)
      if (!manifest.web) return { ...record, manifest, skills } satisfies Loaded
      const webRoot = path.resolve(record.directory, manifest.web.root)
      if (!FSUtil.contains(real, yield* fs.resolve(webRoot))) {
        return {
          ...record,
          error: `web.root escapes the app directory: ${manifest.web.root}`,
          id: manifest.id,
        } satisfies Loaded
      }
      return { ...record, manifest, skills, webRoot: AbsolutePath.make(webRoot) } satisfies Loaded
    })

    const info = (item: Loaded, mcpStatuses: Record<string, Mcp.Status>): App.Info => {
      if (!("manifest" in item)) {
        return {
          manifest: fallbackManifest(item),
          directory: item.directory,
          hasWeb: false,
          status: { status: "failed", error: item.error },
        }
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

    const refresh = Effect.fn("AppV2.refresh")(function* (records: readonly SourceRecord[]) {
      const items = yield* Effect.forEach(records, load)
      const seen = new Set<string>()
      loaded = items.map((item) => {
        if (!("manifest" in item)) return item
        if (seen.has(item.manifest.id)) {
          return {
            directory: item.directory,
            authority: item.authority,
            error: "duplicate app id",
            id: item.manifest.id,
          }
        }
        seen.add(item.manifest.id)
        return item
      })
    })

    const state = State.create<Data, Editor>({
      name: "mcp-app",
      initial: () => ({ apps: [] }),
      editor: (data) => ({
        app: (directory, authority = "trusted-global") => {
          if (data.apps.some((item) => item.directory === directory)) return
          data.apps.push({ directory, authority })
        },
        list: () => data.apps.map((item) => item.directory),
      }),
      notify: (data) => refresh(data.apps).pipe(Effect.andThen(mcp.reload()), Effect.andThen(skill.reload())),
    })

    yield* mcp.transform((editor) => {
      for (const item of loaded) {
        if ("manifest" in item && item.manifest.mcp) {
          editor.set(item.manifest.id, toServerConfig(item.directory, item.manifest.mcp))
        }
      }
    })
    yield* skill.transform((editor) => {
      for (const item of loaded) {
        if ("skills" in item) {
          for (const entry of item.skills) editor.add(entry)
        }
      }
    })

    const infos = Effect.fn("AppV2.list")(function* () {
      const servers = yield* mcp.servers()
      const mcpStatuses = Object.fromEntries(servers.map((server) => [server.name, server.status]))
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
        if (relative.startsWith("/")) return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        const normalized = path.posix.normalize(relative)
        if (
          normalized.includes("\0") ||
          path.isAbsolute(normalized) ||
          normalized === ".." ||
          normalized.startsWith("../")
        ) {
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        }
        const resolved = path.resolve(item.webRoot, normalized)
        if (!FSUtil.contains(item.webRoot, resolved)) {
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        }
        const realRoot = yield* fs.resolve(item.webRoot)
        if (!FSUtil.contains(realRoot, yield* fs.resolve(resolved))) {
          return yield* new AssetError({ id, message: `invalid asset path: ${requestPath}` })
        }
        if (!(yield* fs.isFile(resolved))) {
          return yield* new AssetError({ id, message: `unable to read asset: ${normalized}` })
        }
        return {
          path: AbsolutePath.make(resolved),
          mime: FSUtil.mimeType(resolved),
          read: fs
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
  deps: [FSUtil.node, Mcp.node, Skill.node],
})
