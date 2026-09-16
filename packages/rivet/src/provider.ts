export * as Rivet from "./provider.ts"

import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { Client } from "@rivetkit/effect"
import { Effect } from "effect"
import { filesImpl } from "./actor-filesystem.ts"
import { makeSpawner } from "./actor-process.ts"
import { WorkspaceActor } from "./workspace-actor.ts"
import type { Backend } from "./workspace-schema.ts"

export interface Options extends Client.Options {}

export const create = Effect.fn("Rivet.create")(function* (options: Options) {
  const client = yield* Client.make(options)
  return providers(client)
})

export function providers(client: Client.Client): Readonly<Record<string, WorkspaceDriver.Interface>> {
  return {
    e2b: make(client, "e2b"),
    local: make(client, "local"),
  }
}

export function make(client: Client.Client, backend: Backend): WorkspaceDriver.Interface {
  const actors = client.makeActorAccessor(WorkspaceActor)
  const actor = (workspaceID: string) => actors.getOrCreate(workspaceID)
  const fail = (operation: string, cause: unknown) =>
    new WorkspaceDriver.Error({
      message: typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : `${operation} failed: ${String(cause)}`,
      cause,
    })

  const remoteFilesystem = (workspaceID: string, generation: number) => {
    const remote = actor(workspaceID)
    const call = (request: Parameters<typeof remote.Filesystem>[0]["request"]) =>
      Effect.runPromise(remote.Filesystem({ generation, request })).catch((cause) => {
        if (typeof cause !== "object" || cause === null || !("filesystemCode" in cause) || typeof cause.filesystemCode !== "string") {
          throw cause
        }
        throw Object.assign(new Error("message" in cause ? String(cause.message) : "Filesystem operation failed"), {
          code: cause.filesystemCode,
          filesystemCode: cause.filesystemCode,
        })
      })
    return {
      readFile: async (path: string) => {
        const result = await call({ type: "read", path })
        if (result.type !== "read") throw new Error(`Unexpected filesystem response ${result.type}`)
        return Buffer.from(result.data, "base64")
      },
      writeFile: (path: string, data: Uint8Array, options?: { readonly flag?: "w" | "wx"; readonly mode?: number }) =>
        call({ type: "write", path, data: Buffer.from(data).toString("base64"), ...options }),
      stat: async (path: string) => {
        const result = await call({ type: "stat", path })
        if (result.type !== "stat") throw new Error(`Unexpected filesystem response ${result.type}`)
        return result.stat
      },
      mkdir: (path: string, options?: { readonly recursive?: boolean }) => call({ type: "mkdir", path, ...options }),
      readdir: async (path: string) => {
        const result = await call({ type: "readdir", path, recursive: false, entries: false })
        if (result.type !== "names") throw new Error(`Unexpected filesystem response ${result.type}`)
        return [...result.names]
      },
      readdirEntries: async (path: string) => {
        const result = await call({ type: "readdir", path, recursive: false, entries: true })
        if (result.type !== "directoryEntries") throw new Error(`Unexpected filesystem response ${result.type}`)
        return result.entries
      },
      readdirRecursive: async (path: string) => {
        const result = await call({ type: "readdir", path, recursive: true, entries: true })
        if (result.type !== "recursiveEntries") throw new Error(`Unexpected filesystem response ${result.type}`)
        return result.entries
      },
      exists: async (path: string) => {
        const result = await call({ type: "exists", path })
        if (result.type !== "exists") throw new Error(`Unexpected filesystem response ${result.type}`)
        return result.value
      },
      remove: (path: string, options?: { readonly recursive?: boolean }) => call({ type: "remove", path, ...options }),
      move: (from: string, to: string) => call({ type: "move", from, to }),
      realpath: async (path: string) => {
        const result = await call({ type: "realpath", path })
        if (result.type !== "path") throw new Error(`Unexpected filesystem response ${result.type}`)
        return result.path
      },
    }
  }

  const remoteProcess = (workspaceID: string, generation: number) => {
    const remote = actor(workspaceID)
    return {
      CommandEpoch: () => remote.CommandEpoch({ generation }),
      StartCommand: remote.StartCommand,
      CommandStatus: remote.CommandStatus,
      CancelCommand: remote.CancelCommand,
    }
  }

  const bindingOf = (environment: { readonly generation: number; readonly backend: string; readonly root?: string }, sandboxID?: string) => {
    return {
      generation: environment.generation,
      backend: environment.backend,
      root: environment.root ?? "/workspace",
      ...(sandboxID ? { sandboxID } : {}),
    }
  }

  return WorkspaceDriver.make({
    create: ({ workspaceID }) =>
      actor(workspaceID)
        .Initialize({ provider: backend })
        .pipe(
          Effect.map((environment) => ({ binding: bindingOf(environment) })),
          Effect.mapError((cause) => fail("create", cause)),
        ),
    connect: ({ workspaceID, binding }) =>
      actor(workspaceID)
        .GetEnvironment()
        .pipe(
          Effect.map((environment) => {
            const generation =
              typeof binding.generation === "number" ? binding.generation : environment.generation
            return {
              spawner: makeSpawner(remoteProcess(workspaceID, generation)),
              overrides: filesImpl(remoteFilesystem(workspaceID, generation)),
            }
          }),
          Effect.mapError((cause) => fail("connect", cause)),
        ),
    suspendForIdle: () => Effect.void,
    destroy: ({ workspaceID }) =>
      actor(workspaceID)
        .Stop()
        .pipe(
          Effect.catch((cause) =>
            typeof cause === "object" && cause !== null && "reason" in cause && cause.reason === "not_initialized"
              ? Effect.void
              : Effect.fail(cause),
          ),
          Effect.asVoid,
          Effect.mapError((cause) => fail("destroy", cause)),
        ),
  })
}
