export * as AppHost from "./app-host"

import path from "node:path"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { App } from "@opencode-ai/schema/app"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { AbsolutePath } from "./schema"

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
  readonly url: (release: App.Release) => Effect.Effect<URL>
  readonly retire: (release: App.Release) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AppHost") {}

export function local(): Interface {
  const retired = new Set<string>()
  return {
    publish: Effect.fn("AppHost.publish")(function* (app, build) {
      if (!app.manifest.web || !app.hasWeb)
        return yield* new Error({ operation: "publish", message: `app ${app.manifest.id} has no web build` })
      const resolved = path.resolve(build)
      if (resolved !== app.directory && !resolved.startsWith(app.directory + path.sep))
        return yield* new Error({ operation: "publish", message: `build ${build} escapes the app directory` })
      const release = App.Release.make({
        id: App.ReleaseID.make(`rel_${app.manifest.id}`),
        app: app.manifest.id,
        url: `/api/app/${app.manifest.id}/web/`,
        created_at: yield* DateTime.now,
      })
      retired.delete(release.id)
      return release
    }),
    url: (release) => Effect.sync(() => new URL(release.url, "http://localhost")),
    retire: (release) => Effect.sync(() => retired.add(release.id)).pipe(Effect.asVoid),
  }
}

const layer = Layer.sync(Service, local)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node],
})
