export * as RivetAppHost from "./app-host.ts"

import path from "node:path"
import { pathToFileURL } from "node:url"
import { DateTime, Effect, Layer } from "effect"
import { AppHost } from "@opencode-ai/core/app-host"
import { FSUtil } from "@opencode-ai/core/fs-util"

export interface DeployInput {
  readonly appId: string
  readonly source: URL
}

export interface DeployResult {
  readonly url?: string
}

export type Deploy = (input: DeployInput) => Promise<DeployResult>

export function make(deploy: Deploy): AppHost.Interface {
  return {
    publish: Effect.fn("RivetAppHost.publish")(function* (app, build) {
      if (!app.manifest.web || !app.hasWeb)
        return yield* new AppHost.Error({ operation: "publish", message: `app ${app.manifest.id} has no web build` })
      if (!FSUtil.contains(app.directory, path.resolve(build)))
        return yield* new AppHost.Error({ operation: "publish", message: `build ${build} escapes the app directory` })
      const deployment = yield* Effect.tryPromise({
        try: () =>
          deploy({ appId: app.manifest.id.replaceAll("-", "--").replaceAll("_", "-"), source: pathToFileURL(build + "/") }),
        catch: (cause) =>
          new AppHost.Error({ operation: "publish", message: `failed to deploy ${app.manifest.id}`, cause }),
      })
      if (!deployment.url)
        return yield* new AppHost.Error({
          operation: "publish",
          message: `deployment for ${app.manifest.id} returned no url`,
        })
      return AppHost.Release.make({
        id: AppHost.ReleaseID.create(),
        app: app.manifest.id,
        url: deployment.url,
        created: yield* DateTime.now,
      })
    }),
    url: (release) => Effect.sync(() => new URL(release.url, "http://localhost")),
    retire: () => Effect.void,
  }
}

export const layer = (deploy: Deploy) => Layer.succeed(AppHost.Service, make(deploy))
