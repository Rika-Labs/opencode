export * as ConfigSkillPlugin from "./skill"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { Global } from "../../global"
import { Location } from "../../location"

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const skill = yield* SkillV2.Service
    yield* skill.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry] : []))
        const items = entries.flatMap((entry) =>
          entry.type === "document" ? (entry.info.skills ?? []).map((item) => ({ item, origin: entry.origin })) : [],
        )
        for (const directory of directories) {
          draft.source(
            SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory.path, "skill")) }),
            directory.origin === "workspace" ? "workspace" : undefined,
          )
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(directory.path, "skills")),
            }),
            directory.origin === "workspace" ? "workspace" : undefined,
          )
        }
        for (const entry of items) {
          const authority = entry.origin === "workspace" ? "workspace" : undefined
          if (URL.canParse(entry.item) && /^(https?:)$/.test(new URL(entry.item).protocol)) {
            if (authority === "workspace" && location.workspaceID) {
              yield* Effect.logWarning("Ignoring URL skill source from managed workspace configuration", {
                url: entry.item,
              })
              continue
            }
            draft.source(SkillV2.UrlSource.make({ type: "url", url: entry.item }), authority)
            continue
          }
          if (authority === "workspace" && location.workspaceID && entry.item.startsWith("~/")) {
            yield* Effect.logWarning("Ignoring home-relative skill source from managed workspace configuration", {
              path: entry.item,
            })
            continue
          }
          const expanded = entry.item.startsWith("~/") ? path.join(global.home, entry.item.slice(2)) : entry.item
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
            }),
            authority,
          )
        }
      }),
    )
  }),
})
