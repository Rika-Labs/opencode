import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppV2 } from "@opencode-ai/core/app"
import { Config } from "@opencode-ai/core/config"
import { ConfigAppPlugin } from "@opencode-ai/core/config/plugin/app"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { McpV2 } from "@opencode-ai/core/mcp"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkspaceFileSystem } from "@opencode-ai/core/workspace-capability"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const mcpFixture = path.join(import.meta.dir, "fixture/mcp-server.ts")

async function writeApp(directory: string, manifest?: Record<string, unknown>) {
  await fs.mkdir(path.join(directory, "skills/helper"), { recursive: true })
  await fs.mkdir(path.join(directory, "web"), { recursive: true })
  await fs.writeFile(
    path.join(directory, "skills/helper/SKILL.md"),
    "---\nname: helper\ndescription: app skill\n---\nhelp with things\n",
  )
  await fs.writeFile(path.join(directory, "web/index.html"), "<html>app</html>")
  await fs.writeFile(path.join(directory, "web/asset.0123456789ab.js"), "console.log(1)")
  await fs.writeFile(
    path.join(directory, "app.json"),
    JSON.stringify(
      manifest ?? {
        id: "app_calc",
        name: "Calculator",
        version: "1.0.0",
        mcp: { type: "local", command: [process.execPath, mcpFixture] },
        skills: ["skills"],
        web: { root: "web" },
        ui: { csp: { connectDomains: ["https://api.example.com"] } },
      },
    ),
  )
}

const events = Layer.succeed(
  EventV2.Service,
  EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(
        () =>
          ({ id: EventV2.ID.create(), type: definition.type, data }) as EventV2.Payload<typeof definition>,
      ),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  }),
)

const permissions = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

function appLayer(directory: string) {
  return AppNodeBuilder.build(
    LayerNode.group([AppV2.node, McpV2.node, SkillV2.node, ToolRegistry.node, FSUtil.node]),
    [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
      ),
    ],
    [PermissionV2.node, permissions],
    [EventV2.node, events],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
}

function managedLayer(directory: AbsolutePath, guestDir: string) {
  const remap = (file: string) => path.join(guestDir, path.relative(directory as string, file))
  return AppNodeBuilder.build(
    LayerNode.group([
      AppV2.node,
      McpV2.node,
      SkillV2.node,
      ToolRegistry.node,
      FSUtil.node,
      WorkspaceFileSystem.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory, workspaceID: WorkspaceID.create() })),
        ),
      ],
      [
        WorkspaceFileSystem.node,
        makeLocationNode({
          service: WorkspaceFileSystem.Service,
          layer: Layer.effect(
            WorkspaceFileSystem.Service,
            Effect.map(FSUtil.Service, (host) =>
              FSUtil.Service.of({
                ...host,
                glob: (pattern, options) =>
                  host
                    .glob(pattern, { ...options, cwd: guestDir })
                    .pipe(
                      Effect.map((files) =>
                        files.map((file) => path.join(directory as string, path.relative(guestDir, file))),
                      ),
                    ),
                readFile: (file) => host.readFile(remap(file)),
                readFileString: (file) => host.readFileString(remap(file)),
                readFileStringSafe: (file) => host.readFileStringSafe(remap(file)),
                readJson: (file) => host.readJson(remap(file)),
                existsSafe: (file) => host.existsSafe(remap(file)),
                isDir: (file) => host.isDir(remap(file)),
                isFile: (file) => host.isFile(remap(file)),
                stat: (file) => host.stat(remap(file)),
                realPath: (file) => host.realPath(remap(file)),
                readDirectoryEntries: (dir) => host.readDirectoryEntries(remap(dir)),
              }),
            ),
          ),
          deps: [FSUtil.node],
        }),
      ],
      [PermissionV2.node, permissions],
      [EventV2.node, events],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
}

const npm = Npm.Service.of({
  add: () => Effect.die("npm.add should not be called for path app sources"),
  install: () => Effect.die("unused"),
  which: () => Effect.die("unused"),
})

describe("AppV2", () => {
  it.live("loads an app, registers its mcp server and skills, and serves assets", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const appDir = path.join(tmp.path, "calc")
          yield* Effect.promise(() => writeApp(appDir))
          return yield* Effect.gen(function* () {
            const apps = yield* AppV2.Service
            const mcp = yield* McpV2.Service
            const skill = yield* SkillV2.Service

            yield* apps.transform((draft) => {
              draft.app(AbsolutePath.make(appDir))
            })

            const list = yield* apps.list()
            expect(list).toHaveLength(1)
            expect(list[0]).toMatchObject({
              directory: appDir,
              server: "app_calc",
              hasWeb: true,
              status: { status: "active" },
            })

            expect(yield* mcp.status()).toEqual({ app_calc: { status: "connected" } })
            expect((yield* mcp.tools()).map((tool) => tool.name).toSorted()).toEqual([
              "add_tool",
              "echo",
              "price",
            ])
            expect((yield* skill.list()).map((info) => info.name)).toContain("helper")

            const entry = yield* apps.asset("app_calc" as AppV2.ID, "")
            expect(entry.path as string).toBe(path.join(appDir, "web/index.html"))
            expect(entry.mime).toBe("text/html")
            expect(yield* entry.read.pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))).toBe(
              "<html>app</html>",
            )

            for (const bad of ["../app.json", "%2e%2e/app.json", "/etc/passwd", "..\\escape"]) {
              const exit = yield* apps.asset("app_calc" as AppV2.ID, bad).pipe(Effect.exit)
              expect(exit._tag).toBe("Failure")
            }

            const missing = yield* apps.asset("app_calc" as AppV2.ID, "nope.js").pipe(Effect.exit)
            expect(missing._tag).toBe("Failure")
          }).pipe(Effect.provide(appLayer(tmp.path)))
        }),
      ),
    ),
    30_000,
  )

  it.live("drops skill directories that escape the app directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const appDir = path.join(tmp.path, "calc")
          yield* Effect.promise(() => writeApp(appDir))
          const outside = path.join(tmp.path, "outside", "evil")
          yield* Effect.promise(() =>
            fs.mkdir(outside, { recursive: true }).then(() =>
              fs.writeFile(
                path.join(outside, "SKILL.md"),
                "---\nname: evil\ndescription: escaped skill\n---\ndo bad things\n",
              ),
            ),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(appDir, "app.json"),
              JSON.stringify({
                id: "app_calc",
                name: "Calculator",
                version: "1.0.0",
                skills: ["../outside", "skills"],
              }),
            ),
          )
          return yield* Effect.gen(function* () {
            const apps = yield* AppV2.Service
            const skill = yield* SkillV2.Service
            yield* apps.transform((draft) => {
              draft.app(AbsolutePath.make(appDir))
            })
            const names = (yield* skill.list()).map((info) => info.name)
            expect(names).toContain("helper")
            expect(names).not.toContain("evil")
          }).pipe(Effect.provide(appLayer(tmp.path)))
        }),
      ),
    ),
    30_000,
  )

  it.live("removing an app reverts its mcp and skill contributions", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const appDir = path.join(tmp.path, "calc")
          yield* Effect.promise(() => writeApp(appDir))
          return yield* Effect.gen(function* () {
            const apps = yield* AppV2.Service
            const mcp = yield* McpV2.Service
            const skill = yield* SkillV2.Service

            const registration = yield* apps.transform((draft) => {
              draft.app(AbsolutePath.make(appDir))
            })
            expect(yield* mcp.status()).toEqual({ app_calc: { status: "connected" } })
            expect((yield* skill.list()).map((info) => info.name)).toContain("helper")

            yield* registration.dispose
            expect(yield* mcp.status()).toEqual({})
            expect((yield* skill.list()).map((info) => info.name)).not.toContain("helper")
            expect(yield* apps.list()).toEqual([])
          }).pipe(Effect.provide(appLayer(tmp.path)))
        }),
      ),
    ),
    30_000,
  )

  it.live("ConfigAppPlugin discovers apps from config entries and directory globs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const appDir = path.join(tmp.path, "calc")
          const globbed = path.join(tmp.path, "apps", "glob")
          yield* Effect.promise(() => writeApp(appDir))
          yield* Effect.promise(() =>
            writeApp(globbed, {
              id: "app_glob",
              name: "Globbed",
              version: "1.0.0",
              web: { root: "web" },
            }),
          )
          const document = path.join(tmp.path, "opencode.json")
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  path: document,
                  origin: "global",
                  info: new Config.Info({ apps: ["./calc"] }),
                }),
                new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path), origin: "global" }),
              ]),
          })
          return yield* Effect.gen(function* () {
            const apps = yield* AppV2.Service
            const mcp = yield* McpV2.Service
            const skill = yield* SkillV2.Service
            const fsutil = yield* FSUtil.Service

            yield* ConfigAppPlugin.Plugin.effect({} as PluginContext).pipe(
              Effect.provideService(Config.Service, config),
              Effect.provideService(FSUtil.Service, fsutil),
              Effect.provideService(WorkspaceFileSystem.Service, fsutil),
              Effect.provideService(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
              Effect.provideService(Global.Service, Global.Service.of(Global.make({ home: tmp.path }))),
              Effect.provideService(Npm.Service, npm),
              Effect.provideService(AppV2.Service, apps),
            )

            const list = yield* apps.list()
            expect(list.map((item) => item.manifest.id as string).toSorted()).toEqual(["app_calc", "app_glob"])
            expect(yield* mcp.status()).toEqual({ app_calc: { status: "connected" } })
            expect((yield* skill.list()).map((info) => info.name)).toContain("helper")
          }).pipe(Effect.provide(appLayer(tmp.path)))
        }),
      ),
    ),
    30_000,
  )

  it.live("discovers workspace apps through the workspace filesystem and refuses workspace mcp in managed workspaces", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const logical = AbsolutePath.make(path.join(tmp.path, "logical"))
          const guestDir = path.join(tmp.path, "guest")
          yield* Effect.promise(() => fs.mkdir(logical as string, { recursive: true }))
          yield* Effect.promise(() => writeApp(path.join(guestDir, "apps", "calc")))
          yield* Effect.promise(() =>
            writeApp(path.join(guestDir, "apps", "remote"), {
              id: "app_remote",
              name: "Remote",
              version: "1.0.0",
              mcp: { type: "remote", url: "https://mcp.example.com/" },
              web: { root: "web" },
            }),
          )
          return yield* Effect.gen(function* () {
            const apps = yield* AppV2.Service
            const mcp = yield* McpV2.Service
            const skill = yield* SkillV2.Service
            const fsutil = yield* FSUtil.Service
            const workspaceFs = yield* WorkspaceFileSystem.Service

            yield* ConfigAppPlugin.Plugin.effect({} as PluginContext).pipe(
              Effect.provideService(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.succeed([
                      new Config.Directory({ type: "directory", path: logical, origin: "workspace" }),
                    ]),
                }),
              ),
              Effect.provideService(FSUtil.Service, fsutil),
              Effect.provideService(WorkspaceFileSystem.Service, workspaceFs),
              Effect.provideService(
                Location.Service,
                Location.Service.of(
                  location({ directory: logical, workspaceID: WorkspaceID.create() }),
                ),
              ),
              Effect.provideService(Global.Service, Global.Service.of(Global.make({ home: tmp.path }))),
              Effect.provideService(Npm.Service, npm),
              Effect.provideService(AppV2.Service, apps),
            )

            expect((yield* apps.list()).map((item) => item.manifest.id as string).toSorted()).toEqual([
              "app_calc",
              "app_remote",
            ])
            expect(yield* mcp.status()).toEqual({
              app_calc: {
                status: "failed",
                error: "Local MCP servers are not supported in managed workspaces",
              },
              app_remote: {
                status: "failed",
                error: "Workspace-configured MCP servers are not supported in managed workspaces",
              },
            })
            expect((yield* skill.list()).map((info) => info.name)).toContain("helper")

            const entry = yield* apps.asset("app_calc" as AppV2.ID, "")
            expect(yield* entry.read.pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))).toBe(
              "<html>app</html>",
            )
          }).pipe(Effect.provide(managedLayer(logical, guestDir)))
        }),
      ),
    ),
    30_000,
  )
})
