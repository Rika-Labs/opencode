import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { WorkspaceFileSystem } from "@opencode-ai/core/workspace-capability"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)
const guestFiles = new Map<string, string>()
const guest = Layer.effect(
  WorkspaceFileSystem.Service,
  Effect.gen(function* () {
    const host = yield* FSUtil.Service
    return WorkspaceFileSystem.Service.of({
      ...host,
      glob: (pattern, options) =>
        Effect.succeed(
          Array.from(guestFiles.keys()).filter((file) => {
            if (!options?.cwd || !file.startsWith(`${options.cwd}${path.sep}`)) return false
            if (pattern === "**/*") return true
            return path.basename(file) === "SKILL.md" || (path.dirname(file) === options.cwd && file.endsWith(".md"))
          }),
        ),
      readFileStringSafe: (file) => Effect.succeed(guestFiles.get(file)),
    })
  }),
).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
const managedIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [
    [SkillDiscovery.node, discovery],
    [WorkspaceFileSystem.node, guest],
  ]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  managedIt.live("keeps workspace skill content and resources on the originating filesystem", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const shared = path.join(tmp.path, "shared")
          const guestSkill = path.join(shared, "guest", "SKILL.md")
          const guestResource = path.join(shared, "guest", "guest.txt")
          const global = path.join(tmp.path, "global")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(guestSkill), { recursive: true })
            await fs.mkdir(path.join(global, "trusted"), { recursive: true })
            await fs.writeFile(guestSkill, "---\nname: host\n---\n# host")
            await fs.writeFile(path.join(shared, "guest", "host.txt"), "host")
            await write(global, "trusted", "Trusted global")
          })
          guestFiles.clear()
          guestFiles.set(guestSkill, "---\nname: guest\ndescription: Guest\n---\n# guest")
          guestFiles.set(guestResource, "guest")

          const skill = yield* SkillV2.Service
          yield* skill.transform((draft) => {
            draft.source({ type: "directory", path: AbsolutePath.make(global) })
            draft.source({ type: "directory", path: AbsolutePath.make(shared) }, "workspace")
          })

          const loaded = yield* skill.list()
          expect(loaded.map((item) => item.name)).toEqual(["trusted", "guest"])
          const guestInfo = loaded.find((item) => item.name === "guest")
          if (!guestInfo) return yield* Effect.die("guest skill missing")
          expect(guestInfo.content).toBe("# guest")
          expect(yield* skill.resourceFiles(guestInfo)).toEqual([guestResource])
        }),
      ),
    ),
  )

  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )
})
