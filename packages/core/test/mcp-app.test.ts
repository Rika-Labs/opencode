import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppV2 } from "@opencode/core/mcp-app"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

async function writeApp(directory: string) {
  await fs.mkdir(path.join(directory, "web"), { recursive: true })
  await fs.writeFile(path.join(directory, "web/index.html"), "<html>app</html>")
  await fs.writeFile(
    path.join(directory, "app.json"),
    JSON.stringify({
      id: "app_calc",
      name: "Calculator",
      version: "1.0.0",
      web: { root: "web" },
    }),
  )
}

function mcpStub() {
  return Layer.succeed(
    Mcp.Service,
    Mcp.Service.of({
      transform: () =>
        Effect.succeed({
          dispose: Effect.void,
        }),
      reload: () => Effect.void,
      servers: () => Effect.succeed([]),
      add: () => Effect.void,
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      remove: () => Effect.void,
      tools: () => Effect.succeed([]),
      callTool: () => Effect.die("unused"),
      instructions: () => Effect.succeed([]),
      prompts: () => Effect.succeed([]),
      prompt: () => Effect.succeed(undefined),
      resourceCatalog: () => Effect.die("unused"),
      readResource: () => Effect.succeed(undefined),
    }),
  )
}

function skillStub() {
  return Layer.succeed(
    Skill.Service,
    Skill.Service.of({
      transform: () =>
        Effect.succeed({
          dispose: Effect.void,
        }),
      reload: () => Effect.void,
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
    }),
  )
}

function appLayer(directory: AbsolutePath) {
  return AppNodeBuilder.build(LayerNode.group([AppV2.node]), [
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory })))),
    Mcp.node.replace(mcpStub()),
    Skill.node.replace(skillStub()),
  ])
}

describe("AppV2", () => {
  it.effect("lists a discovered app and serves its web asset", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          yield* Effect.promise(() => writeApp(tmp.path))
          const apps = yield* AppV2.Service
          yield* apps.transform((editor) => {
            editor.app(directory)
          })
          const listed = yield* apps.list()
          expect(listed).toEqual([
            expect.objectContaining({
              directory,
              hasWeb: true,
              status: { status: "active" },
            }),
          ])
          expect(listed[0]?.manifest.id as string).toBe("app_calc")
          const asset = yield* apps.asset(AppV2.ID.make("app_calc"), "index.html")
          expect(yield* asset.read).toEqual(new TextEncoder().encode("<html>app</html>"))
        }).pipe(Effect.provide(appLayer(AbsolutePath.make(tmp.path)))),
      ),
    ),
  )
})
