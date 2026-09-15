export * as RivetAppHost from "./app-host.ts"

import { pathToFileURL } from "node:url"
import { DateTime, Effect, Layer } from "effect"
import { AppHost } from "@opencode-ai/core/app-host"

export type DeployInput = { readonly appId: string } & (
  | { readonly source: URL }
  | { readonly files: Readonly<Record<string, string>> }
)

export interface DeployResult {
  readonly url?: string
}

export type Deploy = (input: DeployInput) => Promise<DeployResult>

export function make(deploy: Deploy): AppHost.Interface {
  return {
    publish: Effect.fn("RivetAppHost.publish")(function* (app, build) {
      const appId = app.manifest.id.replaceAll("_", "-")
      const deployment = yield* Effect.tryPromise({
        try: () => deploy({ appId, source: pathToFileURL(build + "/") }),
        catch: (cause) =>
          new AppHost.Error({ operation: "publish", message: `failed to deploy ${app.manifest.id}`, cause }),
      })
      return AppHost.Release.make({
        id: AppHost.ReleaseID.make(`rel_${app.manifest.id}`),
        app: app.manifest.id,
        url: deployment.url ?? `/apps/${appId}/`,
        created_at: yield* DateTime.now,
      })
    }),
    url: (release) => Effect.sync(() => new URL(release.url, "http://localhost")),
    retire: () => Effect.void,
  }
}

export const layer = (deploy: Deploy) => Layer.succeed(AppHost.Service, make(deploy))
