import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const executable = {
  shell: "/bin/sh",
  permissions: [{ effect: "allow", action: "*", resource: "*" }],
  formatter: { unsafe: { command: ["formatter"] } },
  lsp: { unsafe: { command: ["language-server"] } },
  mcp: { servers: { unsafe: { type: "local", command: ["server"] } } },
  references: { unsafe: { path: "/host" } },
  plugins: ["unsafe-plugin"],
  providers: {
    unsafe: {
      api: { type: "native", settings: { baseURL: "https://workspace.invalid" } },
      request: { headers: { authorization: "workspace-secret" } },
    },
  },
}

describe("managed workspace config trust boundary", () => {
  it.live("retains global executable config and rejects workspace executable config", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const globalDirectory = path.join(tmp.path, "global")
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(globalDirectory),
              fs.mkdir(path.join(tmp.path, ".opencode")),
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ ...executable, model: "safe/model" })),
            ]).then(() => fs.writeFile(path.join(globalDirectory, "opencode.json"), JSON.stringify(executable))),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const global = entries.find(
              (entry): entry is Config.Document => entry.type === "document" && entry.origin === "global",
            )
            const workspace = entries.find(
              (entry): entry is Config.Document => entry.type === "document" && entry.origin === "workspace",
            )

            expect(global?.info.plugins).toEqual(["unsafe-plugin"])
            expect(global?.info.providers?.unsafe?.request?.headers?.authorization).toBe("workspace-secret")
            expect(workspace?.info.model).toBe("safe/model")
            for (const key of Object.keys(executable) as (keyof typeof executable)[]) {
              expect(workspace?.info[key]).toBeUndefined()
            }
            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.origin)).toEqual([
              "global",
              "workspace",
            ])
          }).pipe(Effect.provide(configLayer(tmp.path, globalDirectory, true)))
        })
      }),
    ),
  )

  it.live("leaves local workspace configuration unchanged", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify(executable)))
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const workspace = (yield* config.entries()).find(
              (entry): entry is Config.Document => entry.type === "document" && entry.origin === "workspace",
            )

            expect(workspace?.info.plugins).toEqual(["unsafe-plugin"])
            expect(workspace?.info.shell).toBe("/bin/sh")
            expect(workspace?.info.providers?.unsafe?.request?.headers?.authorization).toBe("workspace-secret")
          }).pipe(Effect.provide(configLayer(tmp.path, path.join(tmp.path, "global"), false)))
        }),
      ),
    ),
  )
})

function configLayer(directory: string, globalDirectory: string, managed: boolean) {
  const ref = {
    directory: AbsolutePath.make(directory),
    workspaceID: managed ? WorkspaceID.make("wrk_test") : undefined,
  }
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(location(ref, { projectDirectory: AbsolutePath.make(directory) })),
      ),
    ],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
}
