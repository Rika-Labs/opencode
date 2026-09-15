import { Effect, Schema } from "effect"
import { WorkspaceV2 } from "./workspace"
import { Location } from "./location"
import { FSUtil } from "./fs-util"
import { AppProcess } from "./process"
import { FileSystem } from "./filesystem"

export namespace WorkspaceProvider {
  export type EnvironmentTarget =
    | { readonly type: "agentos" }
    | { readonly type: "sandbox"; readonly provider: string }

  export interface Capabilities {
    readonly filesystem: boolean
    readonly process: boolean
    readonly search: boolean
    readonly git: boolean
    readonly snapshot: boolean
    readonly pty: boolean
  }

  export interface Environment {
    readonly backend: EnvironmentTarget["type"]
    readonly generation: number
    readonly capabilities: Capabilities
  }

  export interface Workspace {
    readonly id: WorkspaceV2.ID
    readonly location: Location.Ref
  }

  export interface Promotion {
    readonly id: string
    readonly status: "waiting_for_idle" | "provisioning" | "copying" | "verifying" | "completed" | "failed"
    readonly message?: string
  }

  export class Error extends Schema.TaggedErrorClass<Error>()("WorkspaceProviderError", {
    operation: Schema.String,
    code: Schema.Literals(["not_found", "invalid_path", "unsupported", "conflict", "unavailable", "failed"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

  export interface Binding {
    readonly root: string
    readonly project: Location.Interface["project"]
    readonly vcs?: Location.Interface["vcs"]
    readonly filesystem: FSUtil.Interface
    readonly process: AppProcess.Interface
    readonly search?: Search
  }

  export interface Search {
    readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[], Error>
    readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[], Error>
    readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[], Error>
  }

  export interface Interface {
    readonly bind: (location: Location.Ref) => Effect.Effect<Binding, Error>
    readonly create: (input: {
      readonly name: string
      readonly environment: EnvironmentTarget
    }) => Effect.Effect<Workspace, Error>
    readonly environment: (input: { readonly workspaceID: WorkspaceV2.ID }) => Effect.Effect<Environment, Error>
    readonly promote: (input: {
      readonly workspaceID: WorkspaceV2.ID
      readonly requestID: string
      readonly target: EnvironmentTarget
    }) => Effect.Effect<Promotion, Error>
    readonly promotion: (input: {
      readonly workspaceID: WorkspaceV2.ID
      readonly operationID: string
    }) => Effect.Effect<Promotion, Error>
  }

  export function binding(
    provider: Interface | undefined,
    location: Location.Ref,
  ): Effect.Effect<Binding | undefined, Error> {
    if (!location.workspaceID) return Effect.succeed(undefined)
    if (!provider)
      return Effect.fail(
        new Error({
          operation: "bind",
          code: "not_found",
          message: `Managed workspace ${location.workspaceID} is not configured`,
        }),
      )
    return provider.bind(location).pipe(
      Effect.flatMap((value) => {
        if (!FSUtil.contains(value.root, location.directory))
          return Effect.fail(
            new Error({
              operation: "bind",
              code: "invalid_path",
              message: `Location ${location.directory} is outside workspace root ${value.root}`,
            }),
          )
        if (value.project.directory !== value.root)
          return Effect.fail(
            new Error({
              operation: "bind",
              code: "conflict",
              message: `Managed workspace project directory ${value.project.directory} does not match root ${value.root}`,
            }),
          )
        return Effect.succeed(value)
      }),
    )
  }
}
