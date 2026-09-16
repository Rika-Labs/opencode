export * as AppHost from "./app-host.js"

import path from "node:path"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { App } from "@opencode/schema/app"
import { FSUtil } from "@opencode/util/fs-util"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"

export const Release = App.Release
export type Release = App.Release

export const ReleaseID = App.ReleaseID
export type ReleaseID = App.ReleaseID

export class Error extends Schema.TaggedErrorClass<Error>()("AppHost.Error", {
  operation: Schema.Literals(["publish", "url", "retire"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly publish: (app: App.Info, build: AbsolutePath) => Effect.Effect<App.Release, Error>
  readonly url: (release: App.Release) => Effect.Effect<URL, Error>
  readonly retire: (release: App.Release) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AppHost") {}

export function local(fs: FSUtil.Interface): Interface {
  const retired = new Set<string>()
  return {
    publish: Effect.fn("AppHost.publish")(function* (app, build) {
      if (!app.manifest.web || !app.hasWeb) {
        return yield* new Error({ operation: "publish", message: `app ${app.manifest.id} has no web build` })
      }
      const resolved = path.resolve(build)
      if (!FSUtil.contains(app.directory, resolved)) {
        return yield* new Error({ operation: "publish", message: `build ${build} escapes the app directory` })
      }
      const real = yield* fs.resolve(app.directory)
      if (!FSUtil.contains(real, yield* fs.resolve(resolved))) {
        return yield* new Error({ operation: "publish", message: `build ${build} escapes the app directory` })
      }
      const release = App.Release.make({
        id: App.ReleaseID.create(),
        app: app.manifest.id,
        url: `/api/app/${app.manifest.id}/web/`,
        created: yield* DateTime.now,
      })
      retired.delete(release.id)
      return release
    }),
    url: Effect.fn("AppHost.url")(function* (release) {
      if (retired.has(release.id)) {
        return yield* new Error({ operation: "url", message: `release ${release.id} is retired` })
      }
      return new URL(release.url, "http://localhost")
    }),
    retire: (release) => Effect.sync(() => retired.add(release.id)).pipe(Effect.asVoid),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return local(fs)
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, FSUtil.node],
})
