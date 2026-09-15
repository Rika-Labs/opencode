export * as Rivet from "./provider.ts"

import { randomUUID } from "node:crypto"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Client } from "@rivetkit/effect"
import { Effect } from "effect"
import { AgentOSFilesystem } from "./agentos-filesystem.ts"
import { ActorProcess } from "./actor-process.ts"
import { WorkspaceActor } from "./workspace-actor.ts"
import { Promotion } from "./workspace-schema.ts"

export interface Options extends Client.Options {
  readonly binding?: (input: {
    readonly workspaceID: WorkspaceV2.ID
    readonly root: AbsolutePath
  }) => Effect.Effect<Omit<WorkspaceProvider.Binding, "root" | "filesystem">, WorkspaceProvider.Error>
}

export const create = Effect.fn("Rivet.create")(function* (options: Options) {
  const client = yield* Client.make(options)
  return make(client, options)
})

export function make(client: Client.Client, options: Pick<Options, "binding"> = {}) {
  const actors = client.makeActorAccessor(WorkspaceActor)
  const root = AbsolutePath.make("/workspace")
  const actor = (workspaceID: WorkspaceV2.ID) => actors.getOrCreate(workspaceID)
  const filesystem = (workspaceID: WorkspaceV2.ID, generation: number) => {
    const remote = actor(workspaceID)
    const call = (request: Parameters<typeof remote.Filesystem>[0]["request"]) =>
      Effect.runPromise(remote.Filesystem({ generation, request })).catch((cause) => {
        if (typeof cause !== "object" || cause === null || !("filesystemCode" in cause) || typeof cause.filesystemCode !== "string") throw cause
        throw Object.assign(new Error("message" in cause ? String(cause.message) : "Filesystem operation failed"), { code: cause.filesystemCode })
      })
    return AgentOSFilesystem.make(
      {
        readFile: async (path) => {
          const result = await call({ type: "read", path })
          if (result.type !== "read") throw new Error(`Unexpected filesystem response ${result.type}`)
          return Buffer.from(result.data, "base64")
        },
        writeFile: (path, data, options) => call({ type: "write", path, data: Buffer.from(data).toString("base64"), ...options }),
        stat: async (path) => {
          const result = await call({ type: "stat", path })
          if (result.type !== "stat") throw new Error(`Unexpected filesystem response ${result.type}`)
          return { ...result.stat, sizeExact: result.stat.sizeExact === undefined ? undefined : BigInt(result.stat.sizeExact) }
        },
        mkdir: (path, options) => call({ type: "mkdir", path, ...options }),
        readdir: async (path) => {
          const result = await call({ type: "readdir", path, recursive: false, entries: false })
          if (result.type !== "names") throw new Error(`Unexpected filesystem response ${result.type}`)
          return [...result.names]
        },
        readdirEntries: async (path) => {
          const result = await call({ type: "readdir", path, recursive: false, entries: true })
          if (result.type !== "directoryEntries") throw new Error(`Unexpected filesystem response ${result.type}`)
          return result.entries
        },
        readdirRecursive: async (path) => {
          const result = await call({ type: "readdir", path, recursive: true, entries: true })
          if (result.type !== "recursiveEntries") throw new Error(`Unexpected filesystem response ${result.type}`)
          return result.entries
        },
        exists: async (path) => {
          const result = await call({ type: "exists", path })
          if (result.type !== "exists") throw new Error(`Unexpected filesystem response ${result.type}`)
          return result.value
        },
        remove: (path, options) => call({ type: "remove", path, ...options }),
        move: (from, to) => call({ type: "move", from, to }),
        realpath: async (path) => {
          const result = await call({ type: "realpath", path })
          if (result.type !== "path") throw new Error(`Unexpected filesystem response ${result.type}`)
          return result.path
        },
      },
      root,
    )
  }
  const process = (workspaceID: WorkspaceV2.ID, generation: number) => {
    const remote = actor(workspaceID)
    return ActorProcess.make({
      CommandEpoch: () => remote.CommandEpoch({ generation }),
      StartCommand: remote.StartCommand,
      CommandStatus: remote.CommandStatus,
      CancelCommand: remote.CancelCommand,
    })
  }
  const unsupported = (operation: string, message: string) =>
    Effect.fail(new WorkspaceProvider.Error({ operation, code: "unsupported", message }))
  const mapError = (operation: string) =>
    Effect.mapError((cause: unknown) => {
      if (cause instanceof WorkspaceProvider.Error) return cause
      const reason =
        typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Rivet.WorkspaceActorError" && "reason" in cause
          ? String(cause.reason)
          : undefined
      const message = typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : String(cause)
      return new WorkspaceProvider.Error({ operation, code: actorCodes[reason ?? ""] ?? "unavailable", message, cause })
    })

  const provider: WorkspaceProvider.Interface = {
    bind: (location) => {
      const workspaceID = location.workspaceID
      if (!workspaceID) return unsupported("bind", "A managed workspace ID is required")
      return actor(workspaceID)
        .GetEnvironment()
        .pipe(
          Effect.flatMap((environment) =>
            environment.lifecycle !== "running"
              ? unsupported("bind", `Workspace ${workspaceID} is ${environment.lifecycle}`)
              : (options.binding
                ? options.binding({ workspaceID, root })
                : Effect.succeed({
                    project: { id: Project.ID.make(workspaceID), directory: root },
                    process: process(workspaceID, environment.generation),
                  })).pipe(
                    Effect.map((binding) => ({ root, ...binding, filesystem: filesystem(workspaceID, environment.generation) })),
                  ),
          ),
          mapError("bind"),
        )
    },
    create: (input) => {
      if (input.environment.type !== "agentos") {
        return unsupported("create", `Environment ${input.environment.type} is not implemented`)
      }
      const workspaceID = WorkspaceV2.ID.make(`wrk_${randomUUID()}`)
      return actor(workspaceID)
        .Initialize()
        .pipe(
          Effect.map(() => ({
            id: workspaceID,
            location: { directory: root, workspaceID },
          })),
          mapError("create"),
        )
    },
    environment: (input) => {
      const workspaceID = input.workspaceID
      if (!workspaceID) return unsupported("environment", "A managed workspace ID is required")
      return actor(workspaceID)
        .GetEnvironment()
        .pipe(
          Effect.flatMap((environment) =>
            (options.binding
              ? options.binding({ workspaceID, root })
              : Effect.succeed({
                  project: { id: Project.ID.make(workspaceID), directory: root },
                  process: process(workspaceID, environment.generation),
                })).pipe(
              Effect.map((binding) => ({ environment, binding })),
            ),
          ),
          Effect.map(({ environment, binding }) => ({
            backend: environment.backend === "agentos" ? "agentos" as const : "sandbox" as const,
            generation: environment.generation,
            capabilities: {
              filesystem: true,
              process: true,
              search: binding.search !== undefined,
              git: false,
              snapshot: false,
              pty: false,
            },
          })),
          mapError("environment"),
        )
    },
    promote: (input) => {
      if (input.target.type === "sandbox" && input.target.provider !== "e2b") {
        return unsupported("promote", `Sandbox provider ${input.target.provider} has no verified workspace shutdown boundary`)
      }
      return actor(input.workspaceID).BeginPromotion({
        requestID: input.requestID,
        target: input.target.type === "agentos" ? "agentos" : "e2b",
      }).pipe(
        Effect.map((result) => promotionResult(input.requestID, result)),
        mapError("promote"),
      )
    },
    promotion: (input) => actor(input.workspaceID).PromotionStatus({ requestID: input.operationID }).pipe(
      Effect.map((result) => promotionResult(input.operationID, result)),
      mapError("promotion"),
    ),
  }
  return provider
}

const actorCodes: Record<string, "not_found" | "invalid_path" | "unsupported" | "conflict" | "unavailable" | "failed"> = {
  stopped: "unsupported",
  unsupported: "unsupported",
  stale_generation: "conflict",
  command_conflict: "conflict",
  promotion_conflict: "conflict",
  unknown_command: "not_found",
  storage_missing: "failed",
  environment_failed: "failed",
  capacity: "failed",
}

function promotionResult(id: string, result: Promotion): WorkspaceProvider.Promotion {
  if (result.status === "running") return { id, status: "provisioning" }
  if (result.status === "failed") return { id, status: "failed", message: result.message }
  if (result.status === "idle") return { id, status: "failed", message: "Promotion has not been admitted" }
  if (result.cleanup === "pending") return { id, status: "verifying" }
  if (result.cleanup === "failed") return { id, status: "failed", message: result.cleanupMessage }
  return { id, status: "completed" }
}
