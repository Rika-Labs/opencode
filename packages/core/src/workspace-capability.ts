import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { AppProcess } from "./process"
import { WorkspaceProvider } from "./workspace-provider"

export namespace WorkspaceFileSystem {
  export class Service extends Context.Service<Service, FSUtil.Interface>()("@opencode/WorkspaceFileSystem") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of(yield* FSUtil.Service)
    }),
  )

  export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })
}

export namespace WorkspaceProcess {
  export class Service extends Context.Service<Service, AppProcess.Interface>()("@opencode/WorkspaceProcess") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of(yield* AppProcess.Service)
    }),
  )

  export const node = makeLocationNode({ service: Service, layer, deps: [AppProcess.node] })
}

export namespace WorkspaceSearch {
  export class Service extends Context.Service<Service, WorkspaceProvider.Search>()("@opencode/WorkspaceSearch") {}

  export const unsupported = Service.of({
    find: () => unavailable("find"),
    glob: () => unavailable("glob"),
    grep: () => unavailable("grep"),
  })

  export const node = makeLocationNode({
    service: Service,
    layer: Layer.succeed(Service, unsupported),
    deps: [],
  })
}

function unavailable(operation: string) {
  return Effect.fail(
    new WorkspaceProvider.Error({
      operation: `search.${operation}`,
      code: "unsupported",
      message: `Managed workspace search does not support ${operation}`,
    }),
  )
}
