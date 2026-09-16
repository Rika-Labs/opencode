export * as Rivet from "./provider.ts"

import { randomUUID } from "node:crypto"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Client } from "@rivetkit/effect"
import { Effect } from "effect"
import { ActorFilesystem } from "./actor-filesystem.ts"
import { ActorProcess } from "./actor-process.ts"
import { WorkspaceActor } from "./workspace-actor.ts"

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
  const actor = (workspaceID: WorkspaceV2.ID) => actors.getOrCreate(workspaceID)
  const filesystem = (workspaceID: WorkspaceV2.ID, generation: number, root: AbsolutePath) => {
    const remote = actor(workspaceID)
    const call = (request: Parameters<typeof remote.Filesystem>[0]["request"]) =>
      Effect.runPromise(remote.Filesystem({ generation, request })).catch((cause) => {
        if (typeof cause !== "object" || cause === null || !("filesystemCode" in cause) || typeof cause.filesystemCode !== "string") throw cause
        throw Object.assign(new Error("message" in cause ? String(cause.message) : "Filesystem operation failed"), { code: cause.filesystemCode })
      })
    return ActorFilesystem.make(
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
          return result.stat
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
          Effect.flatMap((environment) => {
            if (environment.lifecycle !== "running")
              return unsupported("bind", `Workspace ${workspaceID} is ${environment.lifecycle}`)
            const root = AbsolutePath.make(environment.root ?? "/workspace")
            return (options.binding
              ? options.binding({ workspaceID, root })
                  : Effect.succeed({
                  project: { id: Project.ID.make(workspaceID), directory: root },
                  process: process(workspaceID, environment.generation),
                })).pipe(
                  Effect.map((binding) => ({
                    root,
                    ...binding,
                    isolated: environment.backend !== "local",
                    filesystem: filesystem(workspaceID, environment.generation, root),
                  })),
                )
          }),
          mapError("bind"),
        )
    },
    create: (input) => {
      const target = input.environment
      const payload =
        target.type === "local"
          ? { provider: "local" as const, root: target.root }
          : target.provider === "e2b"
            ? { provider: "e2b" as const, root: undefined }
            : undefined
      if (!payload) {
        return unsupported("create", `Environment ${target.type}${"provider" in target ? `:${target.provider}` : ""} is not supported`)
      }
      const workspaceID = WorkspaceV2.ID.make(`wrk_${randomUUID()}`)
      return actor(workspaceID)
        .Initialize(payload)
        .pipe(
          Effect.map(() => ({
            id: workspaceID,
            location: { directory: AbsolutePath.make(payload.root ?? "/workspace"), workspaceID },
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
          Effect.flatMap((environment) => {
            const root = AbsolutePath.make(environment.root ?? "/workspace")
            return (options.binding
              ? options.binding({ workspaceID, root })
              : Effect.succeed({
                  project: { id: Project.ID.make(workspaceID), directory: root },
                  process: process(workspaceID, environment.generation),
                })).pipe(
              Effect.map((binding) => ({ environment, binding })),
            )
          }),
          Effect.map(({ environment, binding }) => ({
            backend: environment.backend === "local" ? ("local" as const) : ("sandbox" as const),
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
  }
  return provider
}

const actorCodes: Record<string, "not_found" | "invalid_path" | "unsupported" | "conflict" | "unavailable" | "failed"> = {
  stopped: "unsupported",
  unsupported: "unsupported",
  stale_generation: "conflict",
  command_conflict: "conflict",
  unknown_command: "not_found",
  storage_missing: "failed",
  environment_failed: "failed",
  capacity: "failed",
}
