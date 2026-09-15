import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigSkillPlugin } from "@opencode-ai/core/config/plugin/skill"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: SkillV2.Source[] = []
      const authorities: (SkillV2.Authority | undefined)[] = []
      const transform = Effect.fnUntraced(function* (update: (draft: SkillV2.Draft) => void | Effect.Effect<void>) {
        const result = update({
          source: (source, authority) => {
            sources.push(source)
            authorities.push(authority)
          },
          list: () => sources,
        })
        if (Effect.isEffect(result)) yield* result
        const dispose = Effect.sync(() => {
          sources.length = 0
          authorities.length = 0
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      })

      yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(
          SkillV2.Service,
          SkillV2.Service.of({
            transform,
            reload: () => Effect.void,
            sources: () => Effect.succeed(sources),
            list: () => Effect.succeed([]),
            resourceFiles: () => Effect.succeed([]),
          }),
        ),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/home/test" })),
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory, workspaceID: WorkspaceV2.ID.make("wrk_skill") })),
        ),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.opencode") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                  }),
                }),
                new Config.Document({
                  type: "document",
                  origin: "workspace",
                  info: decode({ skills: ["./guest-skills", "~/guest-home", "https://guest.test/skills/"] }),
                }),
              ]),
          }),
        ),
      )

      expect(sources).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        SkillV2.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(directory, "guest-skills")),
        }),
      ])
      expect(authorities).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, "workspace"])
    }),
  )
})
