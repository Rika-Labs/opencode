import { OpenCode } from "@opencode-ai/client/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { WorkspaceAdmission } from "@opencode-ai/core/workspace-admission"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"

export interface CreateOptions {
  readonly workspaces?: WorkspaceProvider.Interface
}

export const create = Effect.fn("OpenCode.create")(function* (options: CreateOptions = {}) {
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const context = yield* Layer.buildWithMemoMap(
    AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, PermissionSaved.node])),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const workspaceContext = options.workspaces
    ? yield* Layer.buildWithMemoMap(
        Layer.mergeAll(buildLocationServiceMap([], options.workspaces), LayerNode.compile(WorkspaceAdmission.node)),
        memoMap,
        scope,
      )
    : undefined
  const locations = workspaceContext ? Context.get(workspaceContext, LocationServiceMap.Service) : undefined
  const admission = workspaceContext ? Context.get(workspaceContext, WorkspaceAdmission.Service) : undefined
  const workspaces = options.workspaces
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        createEmbeddedRoutes(
          options.workspaces,
          locations && admission
            ? [
                [LocationServiceMap.node, Layer.succeed(LocationServiceMap.Service, locations)],
                [WorkspaceAdmission.node, Layer.succeed(WorkspaceAdmission.Service, admission)],
              ]
            : [],
        ).pipe(
          HttpRouter.provideRequest(Layer.succeed(PermissionSaved.Service, permissions)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(input, init)), {
    preconnect: () => undefined,
  }) satisfies typeof globalThis.fetch
  const client = yield* OpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
    workspaces,
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/sdk-next/OpenCode") {}

export const layer = Layer.effect(Service, create())
