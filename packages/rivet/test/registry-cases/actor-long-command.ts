import assert from "node:assert/strict"
import { test } from "node:test"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { AppProcess } from "@opencode-ai/core/process"
import { WorkspaceFileSystem, WorkspaceProcess } from "@opencode-ai/core/workspace-capability"
import { Client } from "@rivetkit/effect"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Rivet } from "../../src/provider.ts"
import { registryRuntime } from "../registry-fixture.ts"

const withProvider = async (
  body: (provider: ReturnType<typeof Rivet.make>) => Effect.Effect<void, unknown, LocationServiceMap.Service>,
) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = Rivet.make(yield* Client.Client)
        yield* body(provider)
      }).pipe(
        Effect.provide(registryRuntime),
        Effect.provide(buildLocationServiceMap()),
        Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node]))),
      ),
    ),
  )
}

test("Rivet default process completes a command running longer than 60 seconds", { timeout: 100_000 }, async () => {
  await withProvider((provider) =>
    Effect.gen(function* () {
      const workspace = yield* provider.create({ name: "long-command", environment: { type: "agentos" } })
      const binding = yield* provider.bind(workspace.location)
      const result = yield* binding.process.run(
        ChildProcess.make("sh", ["-c", "sleep 65; printf long-command-finished"]),
        { combineOutput: true },
      )
      assert.equal(result.exitCode, 0)
      assert.equal(result.output?.toString(), "long-command-finished")
    }).pipe(Effect.timeout("90 seconds")),
  )
})

test("Core location graph uses the Rivet filesystem and process binding", { timeout: 30_000 }, async () => {
  await withProvider((provider) =>
    Effect.gen(function* () {
      const workspace = yield* provider.create({ name: "location-graph", environment: { type: "agentos" } })
      yield* Effect.gen(function* () {
        const files = yield* FileMutation.Service
        const filesystem = yield* WorkspaceFileSystem.Service
        const process = yield* WorkspaceProcess.Service
        const target = "/workspace/nested/created.txt"
        const created = yield* files.create({
          target: { canonical: target, resource: "nested/created.txt" },
          content: "created through graph",
        })
        assert.equal(created.existed, false)
        assert.equal(yield* filesystem.readFileString(target), "created through graph")
        const result = yield* process.run(
          ChildProcess.make("sh", ["-c", "cat nested/created.txt"], { cwd: "/workspace" }),
          {
            combineOutput: true,
          },
        )
        assert.equal(result.exitCode, 0)
        assert.equal(result.output?.toString(), "created through graph")
      }).pipe(Effect.provide(LocationServiceMap.Service.get(Location.Ref.make(workspace.location))))
    }).pipe(Effect.provide(buildLocationServiceMap([], provider)), Effect.timeout("20 seconds")),
  )
})
