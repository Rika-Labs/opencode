export * as ConfigAppPlugin from "./app"

import { define } from "../../plugin/internal"
import path from "path"
import { fileURLToPath } from "url"
import { Effect } from "effect"
import { AppV2 } from "../../app"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"
import { Location } from "../../location"
import { Npm } from "../../npm"
import { AbsolutePath } from "../../schema"
import { WorkspaceFileSystem } from "../../workspace-capability"

export const Plugin = define({
  id: "config-app",
  effect: Effect.fn(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const workspaceFs = yield* WorkspaceFileSystem.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    const app = yield* AppV2.Service
    yield* app.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        for (const entry of entries) {
          const authority = entry.origin === "workspace" ? ("workspace" as const) : undefined
          if (entry.type === "directory") {
            const manifests = yield* (authority === "workspace" ? workspaceFs : fs)
              .glob("{app,apps}/*/app.json", {
                cwd: entry.path,
                absolute: true,
                include: "file",
                dot: true,
                symlink: true,
              })
              .pipe(Effect.orElseSucceed(() => [] as string[]))
            for (const file of manifests.sort())
              draft.app(AbsolutePath.make(path.dirname(file)), authority)
            continue
          }
          const base = entry.path ? path.dirname(entry.path) : location.directory
          for (const item of entry.info.apps ?? []) {
            const managed = authority === "workspace" && location.workspaceID !== undefined
            if (item.startsWith("file://")) {
              draft.app(AbsolutePath.make(fileURLToPath(item)), authority)
              continue
            }
            if (item.startsWith("~/")) {
              if (managed) {
                yield* Effect.logWarning("Ignoring home-relative app source from managed workspace configuration", {
                  path: item,
                })
                continue
              }
              draft.app(AbsolutePath.make(path.join(global.home, item.slice(2))), authority)
              continue
            }
            if (item.startsWith("./") || item.startsWith("../") || path.isAbsolute(item)) {
              draft.app(AbsolutePath.make(path.resolve(base, item)), authority)
              continue
            }
            if (managed) {
              yield* Effect.logWarning("Ignoring npm app source from managed workspace configuration", {
                package: item,
              })
              continue
            }
            const installed = yield* npm.add(item).pipe(Effect.orElseSucceed(() => undefined))
            if (installed) draft.app(AbsolutePath.make(installed.directory), authority)
          }
        }
      }),
    )
  }),
})
