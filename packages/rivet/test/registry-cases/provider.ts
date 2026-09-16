import assert from "node:assert/strict"
import { test } from "node:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Client } from "@rivetkit/effect"
import { Effect, Layer, Sink } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Rivet } from "../../src/provider.ts"
import { WorkspaceActor } from "../../src/workspace-actor.ts"
import { live, providerTarget, registryRuntime } from "../registry-fixture.ts"

test("sandbox actor composition implements workspace lifecycle and binding", {
  timeout: 300_000,
}, async () => {
  const runtime = Layer.mergeAll(
    registryRuntime,
    Layer.mock(FSUtil.Service, {
      "~effect/platform/FileSystem": "~effect/platform/FileSystem",
      sink: () => Sink.die("Filesystem is unsupported in this provider test"),
      globMatch: () => false,
    }),
    Layer.mock(AppProcess.Service, {}),
  )
  const { target, directory } = await providerTarget()
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = Rivet.make(yield* Client.Client)
      const workspace = yield* provider.create({ name: "test", environment: target })
      assert.equal(workspace.location.directory, directory)
      assert.deepEqual(yield* provider.environment({ workspaceID: workspace.id }), {
        backend: live ? "sandbox" : "local",
        generation: 1,
        capabilities: {
          filesystem: true,
          process: true,
          search: false,
          git: false,
          snapshot: false,
          pty: false,
        },
      })
      const binding = yield* provider.bind(workspace.location)
      assert.equal(binding.root, workspace.location.directory)
      assert.equal(binding.project.directory, workspace.location.directory)
      assert.equal(binding.project.id, workspace.id)
      yield* binding.filesystem.writeFileString("remote.txt", "actor filesystem")
      assert.equal(yield* binding.filesystem.readFileString("remote.txt"), "actor filesystem")
      assert.equal(yield* binding.filesystem.readFileStringSafe("missing.txt"), undefined)
      const existing = yield* binding.filesystem
        .writeFileString("remote.txt", "replacement", { flag: "wx" })
        .pipe(Effect.flip)
      assert.equal(existing.reason._tag, "AlreadyExists")
      assert.equal(yield* binding.filesystem.readFileString("remote.txt"), "actor filesystem")
      // Path-returning operations must round-trip through the mount and guest path spaces.
      yield* binding.filesystem.writeWithDirs("nested/deep/file.txt", "nested content")
      assert.deepEqual((yield* binding.filesystem.readDirectory("nested/deep")).sort(), ["file.txt"])
      assert.deepEqual((yield* binding.filesystem.readDirectoryEntries("nested/deep")).map((entry) => entry.name).sort(), ["file.txt"])
      assert.deepEqual((yield* binding.filesystem.readDirectory(".", { recursive: true })).sort(), ["nested", "nested/deep", "nested/deep/file.txt", "remote.txt"])
      assert.deepEqual(yield* binding.filesystem.glob("deep/*.txt", { cwd: "nested" }), ["deep/file.txt"])
      assert.deepEqual(yield* binding.filesystem.glob("deep/*.txt", { cwd: "nested", absolute: true }), [`${directory}/nested/deep/file.txt`])
      assert.equal(yield* binding.filesystem.resolve("nested/deep"), `${directory}/nested/deep`)
      assert.deepEqual(yield* binding.filesystem.findUp("file.txt", "nested/deep"), [`${directory}/nested/deep/file.txt`])
      assert.equal(yield* binding.filesystem.readFileString("nested/deep/file.txt"), "nested content")
      const shell = yield* binding.process.run(
        ChildProcess.make("printf out; printf err >&2; exit 7", [], { shell: "/bin/sh" }),
        { combineOutput: true },
      )
      assert.equal(shell.exitCode, 7)
      // Cross-stream interleaving is scheduler-dependent; the merge must contain both streams in full.
      assert.deepEqual([...(shell.output?.toString() ?? "")].sort(), [..."outerr"].sort())
      const controller = new AbortController()
      yield* Effect.sleep("200 millis").pipe(
        Effect.andThen(Effect.sync(() => controller.abort(new Error("cancel requested")))),
        Effect.forkChild,
      )
      const aborted = yield* binding.process
        .run(ChildProcess.make("sh", ["-c", "sleep 3; printf leaked > aborted"]), { signal: controller.signal })
        .pipe(Effect.flip)
      assert.match(aborted.message, /cancel requested/)
      yield* Effect.sleep("3 seconds")
      assert.equal(yield* binding.filesystem.exists("aborted"), false)
      const missing = yield* provider.bind({ directory: AbsolutePath.make("/workspace") }).pipe(Effect.flip)
      assert.equal(missing.code, "unsupported")
      const unknown = yield* provider
        .bind({ directory: AbsolutePath.make("/workspace"), workspaceID: WorkspaceV2.ID.make("wrk_missing") })
        .pipe(Effect.flip)
      assert.equal(unknown.code, "unavailable")
      const actor = (yield* Client.Client).makeActorAccessor(WorkspaceActor).getOrCreate(workspace.id)
      yield* actor.Stop()
      const stopped = yield* provider.bind(workspace.location).pipe(Effect.flip)
      assert.equal(stopped.code, "unsupported")
    }).pipe(Effect.provide(runtime), Effect.timeout("120 seconds")),
  )
})
