import { describe, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Location } from "@opencode-ai/core/location"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer } from "effect"
import { FSUtil } from "../src/fs-util"
import { FileSystem } from "../src/filesystem"
import { FileSystemSearch } from "../src/filesystem/search"
import { AppProcess } from "../src/process"
import { ProjectV2 } from "../src/project"
import { RelativePath } from "../src/schema"
import { WorkspaceSearch } from "../src/workspace-capability"

const location = Location.Ref.make({
  directory: AbsolutePath.make("/workspace/project"),
  workspaceID: WorkspaceV2.ID.make("wrk_managed"),
})

describe("WorkspaceProvider.binding", () => {
  test("leaves local locations unchanged", async () => {
    const result = await Effect.runPromise(
      WorkspaceProvider.binding(undefined, Location.Ref.make({ directory: AbsolutePath.make("/tmp/project") })),
    )
    expect(result).toBeUndefined()
  })

  test("rejects an unknown managed workspace", async () => {
    const error = await Effect.runPromise(Effect.flip(WorkspaceProvider.binding(undefined, location)))
    expect(error.code).toBe("not_found")
  })

  test("accepts injected bindings contained by their logical root", async () => {
    const provider = providerWithRoot("/workspace")
    const result = await Effect.runPromise(WorkspaceProvider.binding(provider, location))
    expect(result?.root).toBe("/workspace")
  })

  test("rejects bindings outside their logical root", async () => {
    const error = await Effect.runPromise(Effect.flip(WorkspaceProvider.binding(providerWithRoot("/other"), location)))
    expect(error.code).toBe("invalid_path")
  })

  test("rejects a project identity for another root", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        WorkspaceProvider.binding(
          providerWithRoot("/workspace", { id: ProjectV2.ID.global, directory: AbsolutePath.make("/other") }),
          location,
        ),
      ),
    )
    expect(error.code).toBe("conflict")
  })
})

describe("managed workspace search", () => {
  test("forwards search operations without native search services", async () => {
    const calls: string[] = []
    const entry = FileSystem.Entry.make({ path: RelativePath.make("src/index.ts"), type: "file" })
    const search: WorkspaceProvider.Search = {
      find: () => Effect.sync(() => (calls.push("find"), [entry])),
      glob: () => Effect.sync(() => (calls.push("glob"), [entry])),
      grep: () => Effect.sync(() => (calls.push("grep"), [])),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* FileSystemSearch.Service
        return yield* Effect.all([
          service.find({ query: "index" }),
          service.glob(new FileSystem.GlobInput({ pattern: "*.ts" })),
          service.grep(new FileSystem.GrepInput({ pattern: "test" })),
        ])
      }).pipe(
        Effect.provide(FileSystemSearch.managedLayer),
        Effect.provide(Layer.succeed(WorkspaceSearch.Service, WorkspaceSearch.Service.of(search))),
      ),
    )
    expect(calls).toEqual(["find", "glob", "grep"])
    expect(result[0]).toEqual([entry])
    expect(result[1]).toEqual([entry])
  })

  test("fails explicitly when backend search is unavailable", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* FileSystemSearch.Service).glob(new FileSystem.GlobInput({ pattern: "*.ts" }))
        }).pipe(
          Effect.provide(FileSystemSearch.managedLayer),
          Effect.provide(Layer.succeed(WorkspaceSearch.Service, WorkspaceSearch.unsupported)),
        ),
      ),
    )
    expect(error.code).toBe("unsupported")
    expect(error.operation).toBe("search.glob")
  })
})

function providerWithRoot(
  root: string,
  project = { id: ProjectV2.ID.global, directory: AbsolutePath.make(root) },
): WorkspaceProvider.Interface {
  const unsupported = (operation: string) =>
    Effect.fail(new WorkspaceProvider.Error({ operation, code: "unsupported", message: "unsupported" }))
  return {
    bind: () =>
      Effect.succeed({
        root,
        project,
        filesystem: undefined as unknown as FSUtil.Interface,
        process: undefined as unknown as AppProcess.Interface,
      }),
    create: () => unsupported("create"),
    environment: () => unsupported("environment"),
  }
}
