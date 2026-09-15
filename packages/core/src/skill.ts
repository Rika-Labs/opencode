export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"
import { WorkspaceFileSystem } from "./workspace-capability"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: SourceRecord[]
}

export type Authority = "trusted-global" | "workspace"
type SourceRecord = { source: Source; authority: Authority }

export type Draft = {
  source: (source: Source, authority?: Authority) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly resourceFiles: (skill: Info) => Effect.Effect<string[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const workspaceFs = yield* WorkspaceFileSystem.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source, authority = "trusted-global") => {
          if (draft.sources.some((item) => Source.equals(item.source, source))) return
          draft.sources.push({ source, authority })
        },
        list: () => draft.sources.map((item) => item.source),
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (record: SourceRecord) {
      const skills: Info[] = []
      const source = record.source
      if (source.type === "embedded") return [source.skill]
      if (source.type === "url" && record.authority === "workspace") {
        yield* Effect.logWarning("Ignoring URL skill source from workspace configuration", { url: source.url })
        return skills
      }
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      const sourceFs = record.authority === "workspace" ? workspaceFs : fs
      for (const directory of directories) {
        const files = yield* sourceFs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* sourceFs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const resolve = Effect.fn("SkillV2.resolve")(function* () {
      const skills = new Map<string, { info: Info; authority: Authority }>()
      for (const record of state.get().sources) {
        const key = `${record.authority}:${Source.key(record.source)}`
        const loaded = cache.get(key) ?? (yield* load(record))
        cache.set(key, loaded)
        for (const info of loaded) skills.set(info.name, { info, authority: record.authority })
      }
      return skills
    })
    const list = Effect.fn("SkillV2.list")(function* () {
      return Array.from((yield* resolve()).values(), (item) => item.info)
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources.map((item) => item.source)
      }),
      list,
      resourceFiles: Effect.fn("SkillV2.resourceFiles")(function* (skill) {
        if (path.basename(skill.location) !== "SKILL.md") return []
        const loaded = (yield* resolve()).get(skill.name)
        if (!loaded) return []
        const sourceFs = loaded.authority === "workspace" ? workspaceFs : fs
        return (yield* sourceFs.glob("**/*", {
          cwd: path.dirname(skill.location),
          absolute: true,
          include: "file",
          dot: true,
        }))
          .filter((file) => path.basename(file) !== "SKILL.md")
          .toSorted()
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillDiscovery.node, FSUtil.node, WorkspaceFileSystem.node],
})
