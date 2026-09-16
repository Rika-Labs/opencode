export * as ConfigAppPlugin from "./app.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import path from "path"
import { fileURLToPath } from "url"
import { Effect, Stream } from "effect"
import { AppV2 } from "../../mcp-app.js"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

type Source = {
  readonly directory: AbsolutePath
  readonly authority: AppV2.Authority
}

export const Plugin = define({
  id: "opencode.config.app",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    const app = yield* AppV2.Service
    const loaded = { sources: [] as Source[] }

    const discover = Effect.fn("ConfigAppPlugin.discover")(function* (entries: Entry[]) {
      const sources: Source[] = []
      const add = (directory: string, authority: AppV2.Authority = "trusted-global") => {
        const next = AbsolutePath.make(directory)
        if (sources.some((item) => item.directory === next)) return
        sources.push({ directory: next, authority })
      }
      for (const entry of entries) {
        if (entry.type === "directory") {
          const manifests = yield* fs
            .scan("{app,apps}/*/app.json", {
              cwd: entry.path,
              absolute: true,
              include: "file",
              dot: true,
              symlink: true,
            })
            .pipe(Effect.orElseSucceed(() => [] as string[]))
          for (const file of manifests.toSorted()) add(path.dirname(file))
          continue
        }
        const base = entry.path ? path.dirname(entry.path) : location.directory
        const managed = location.workspaceID !== undefined
        for (const item of entry.info.apps ?? []) {
          if (item.startsWith("file://")) {
            const file = yield* Effect.try({
              try: () => {
                const url = new URL(item)
                if (url.hostname !== "" && url.hostname !== "localhost") throw new Error("remote file URL host")
                return fileURLToPath(url)
              },
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined))
            if (file === undefined) {
              yield* Effect.logWarning("Ignoring invalid file URL app source", { path: item })
              continue
            }
            add(file)
            continue
          }
          if (item.startsWith("~/")) {
            if (managed) {
              yield* Effect.logWarning("Ignoring home-relative app source from managed workspace configuration", {
                path: item,
              })
              continue
            }
            add(path.join(global.home, item.slice(2)))
            continue
          }
          if (item.startsWith("./") || item.startsWith("../") || path.isAbsolute(item)) {
            add(path.resolve(base, item))
            continue
          }
          if (managed) {
            yield* Effect.logWarning("Ignoring npm app source from managed workspace configuration", {
              package: item,
            })
            continue
          }
          const installed = yield* npm.add(item).pipe(Effect.orElseSucceed(() => undefined))
          if (installed) add(installed.directory)
        }
      }
      loaded.sources = sources
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.flatMap(discover),
          Effect.andThen(app.reload()),
          Effect.catchCause((cause) => Effect.logError("failed to reload app config", { cause })),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* discover(yield* config.entries())
    yield* app.transform((editor) => {
      for (const source of loaded.sources) editor.app(source.directory, source.authority)
    })
  }),
})
