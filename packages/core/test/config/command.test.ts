import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { ConfigCommandPlugin } from "@opencode-ai/core/config/plugin/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"
import { WorkspaceFileSystem } from "@opencode-ai/core/workspace-capability"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CommandV2.node, FSUtil.node, WorkspaceFileSystem.node])))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model: anthropic/claude
variant: high
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            CommandV2.Info.make({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: "reviewer",
              model: {
                providerID: ProviderV2.ID.make("anthropic"),
                id: ModelV2.ID.make("claude"),
                variant: ModelV2.VariantID.make("high"),
              },
              subtask: true,
            }),
            CommandV2.Info.make({ name: "empty", template: "" }),
            CommandV2.Info.make({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )

  it.live("loads workspace commands only through the workspace filesystem", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([hostDir, guestDir]) =>
        Effect.gen(function* () {
          const logical = AbsolutePath.make(path.join(hostDir.path, "workspace"))
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(logical, "commands"), { recursive: true })
            await fs.mkdir(path.join(guestDir.path, "commands"), { recursive: true })
            await fs.writeFile(path.join(logical, "commands", "review.md"), "Host command")
            await fs.writeFile(path.join(guestDir.path, "commands", "review.md"), "Guest command")
          })
          const hostFs = yield* FSUtil.Service
          const probes: string[] = []
          const guardedHost = FSUtil.Service.of({
            ...hostFs,
            glob: (pattern, options) => {
              probes.push(options?.cwd ?? "")
              return hostFs.glob(pattern, options)
            },
          })
          const guestFs = FSUtil.Service.of({
            ...hostFs,
            glob: (pattern, options) =>
              hostFs.glob(pattern, { ...options, cwd: guestDir.path }).pipe(
                Effect.map((files) => files.map((file) => path.join(logical, path.relative(guestDir.path, file)))),
              ),
            readFileStringSafe: (file) => hostFs.readFileStringSafe(path.join(guestDir.path, path.relative(logical, file))),
          })
          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([new Config.Directory({ type: "directory", path: logical, origin: "workspace" })]),
              }),
            ),
            Effect.provideService(FSUtil.Service, guardedHost),
            Effect.provideService(WorkspaceFileSystem.Service, guestFs),
          )
          expect((yield* command.list()).find((item) => item.name === "review")?.template).toBe("Guest command")
          expect(probes).toEqual([])
        }),
      ),
    ),
  )
})
