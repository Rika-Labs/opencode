import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { LayerNode } from "../src/effect/layer-node"
import { FileMutation } from "../src/file-mutation"
import { FileSystem } from "../src/filesystem"
import { Watcher } from "../src/filesystem/watcher"
import { FSUtil } from "../src/fs-util"
import { Git } from "../src/git"
import { Location } from "../src/location"
import { buildLocationServiceMap, LocationServiceMap } from "../src/location-services"
import { AppProcess } from "../src/process"
import { ProjectV2 } from "../src/project"
import { ProjectCopy } from "../src/project/copy"
import { Pty } from "../src/pty"
import { RelativePath } from "../src/schema"
import { SkillGuidance } from "../src/skill/guidance"
import { WorkspaceV2 } from "../src/workspace"
import { WorkspaceFileSystem } from "../src/workspace-capability"
import { WorkspaceProvider } from "../src/workspace-provider"
import { tmpdir } from "./fixture/tmpdir"

describe.serial("workspace provider location graph", () => {
  test("boots managed services through provider bindings without native workspace initialization", async () => {
    const dir = await tmpdir()
    const initialized = { watcher: 0, gitIndex: 0, pty: 0, copy: 0, refresh: 0 }
    const calls = { read: 0, write: 0 }
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const nativeFS = yield* FSUtil.Service
          const process = yield* AppProcess.Service
          const git = yield* Git.Service
          const filesystem = FSUtil.Service.of({
            ...nativeFS,
            readFile: (target) => nativeFS.readFile(target).pipe(Effect.tap(() => Effect.sync(() => calls.read++))),
            writeWithDirs: (target, content, mode) =>
              nativeFS.writeWithDirs(target, content, mode).pipe(Effect.tap(() => Effect.sync(() => calls.write++))),
          })
          const provider: WorkspaceProvider.Interface = {
            bind: () =>
              Effect.succeed({
                root: dir.path,
                project: { id: ProjectV2.ID.global, directory: AbsolutePath.make(dir.path) },
                filesystem,
                process,
              }),
            create: () => Effect.die("unused"),
            environment: () => Effect.die("unused"),
          }
          const replacements: LayerNode.Replacements = [
            [
              Watcher.node,
              Layer.effect(
                Watcher.Service,
                Effect.sync(() => (initialized.watcher++, Watcher.Service.of({}))),
              ),
            ],
            [
              Git.node,
              Layer.succeed(Git.Service, {
                ...git,
                index: {
                  ...git.index,
                  refresh: () =>
                    Effect.sync(() => initialized.gitIndex++).pipe(Effect.andThen(Effect.die("Native Git refresh"))),
                  ignored: () =>
                    Effect.sync(() => initialized.gitIndex++).pipe(
                      Effect.andThen(Effect.die("Native Git ignore lookup")),
                    ),
                },
              }),
            ],
            [
              Pty.node,
              Layer.effect(
                Pty.Service,
                Effect.sync(() => initialized.pty++).pipe(Effect.andThen(Effect.die("Native PTY initialized"))),
              ),
            ],
            [
              ProjectCopy.node,
              Layer.effect(
                ProjectCopy.Service,
                Effect.sync(() => initialized.copy++).pipe(
                  Effect.andThen(Effect.die("Native project copies initialized")),
                ),
              ),
            ],
            [ProjectCopy.refreshNode, Layer.effectDiscard(Effect.sync(() => initialized.refresh++))],
          ]
          const ref = Location.Ref.make({
            directory: AbsolutePath.make(dir.path),
            workspaceID: WorkspaceV2.ID.make("wrk_graph"),
          })
          yield* Effect.gen(function* () {
            const mutation = yield* FileMutation.Service
            const files = yield* FileSystem.Service
            const target = path.join(dir.path, "nested", "managed.txt")
            yield* mutation.write({ target: { canonical: target, resource: "nested/managed.txt" }, content: "managed" })
            const result = yield* files.read({ path: RelativePath.make("nested/managed.txt") })
            expect(new TextDecoder().decode(result.content)).toBe("managed")
          }).pipe(
            Effect.scoped,
            Effect.provide(LocationServiceMap.Service.get(ref)),
            Effect.provide(buildLocationServiceMap(replacements, provider)),
          )
          expect(calls.write).toBe(1)
          expect(calls.read).toBeGreaterThan(0)
          expect(initialized).toEqual({ watcher: 0, gitIndex: 0, pty: 0, copy: 0, refresh: 0 })
        }).pipe(Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node, Git.node])))),
      )
    } finally {
      await dir[Symbol.asyncDispose]()
    }
  })

  test("boots and operates a local location without a provider", async () => {
    const dir = await tmpdir()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ref = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.gen(function* () {
            const mutation = yield* FileMutation.Service
            const files = yield* FileSystem.Service
            const target = path.join(dir.path, "local.txt")
            yield* mutation.write({ target: { canonical: target, resource: "local.txt" }, content: "local" })
            const result = yield* files.read({ path: RelativePath.make("local.txt") })
            expect(new TextDecoder().decode(result.content)).toBe("local")
          }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.Service.get(ref)))
        }).pipe(Effect.provide(buildLocationServiceMap())),
      )
      expect(await fs.readFile(path.join(dir.path, "local.txt"), "utf8")).toBe("local")
    } finally {
      await dir[Symbol.asyncDispose]()
    }
  })

  test("invalidates every cached location for one workspace", async () => {
    const dirs = await Promise.all([tmpdir(), tmpdir(), tmpdir()])
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const filesystem = yield* FSUtil.Service
          const process = yield* AppProcess.Service
          const generations = new Map<WorkspaceV2.ID, number>()
          const boundGenerations = new WeakMap<FSUtil.Interface, number>()
          const provider: WorkspaceProvider.Interface = {
            bind: (ref) => {
              if (!ref.workspaceID) return Effect.die("missing workspace ID")
              const generation = (generations.get(ref.workspaceID) ?? 0) + 1
              generations.set(ref.workspaceID, generation)
              const boundFilesystem = { ...filesystem }
              boundGenerations.set(boundFilesystem, generation)
              return Effect.succeed({
                root: ref.directory,
                project: {
                  id: ProjectV2.ID.global,
                  directory: ref.directory,
                },
                filesystem: boundFilesystem,
                process,
              })
            },
            create: () => Effect.die("unused"),
            environment: () => Effect.die("unused"),
          }
          const target = WorkspaceV2.ID.make("wrk_target")
          const separate = WorkspaceV2.ID.make("wrk_separate")
          const refs = [
            Location.Ref.make({ directory: AbsolutePath.make(dirs[0].path), workspaceID: target }),
            Location.Ref.make({ directory: AbsolutePath.make(dirs[1].path), workspaceID: target }),
            Location.Ref.make({ directory: AbsolutePath.make(dirs[2].path), workspaceID: separate }),
          ]
          const locations = Context.get(
            yield* Layer.build(buildLocationServiceMap([], provider)),
            LocationServiceMap.Service,
          )
          const resolve = (ref: Location.Ref) =>
            Effect.scoped(
              locations
                .contextEffect(ref)
                .pipe(Effect.map((context) => Context.get(context, WorkspaceFileSystem.Service))),
            )
          const lookups = refs.map(resolve)

          const initial = yield* Effect.forEach(lookups, (lookup) => lookup)
          yield* locations.invalidateWorkspace(target)
          const rebuilt = yield* Effect.forEach(lookups, (lookup) => lookup)

          expect(boundGenerations.get(initial[0])).toBe(1)
          expect(boundGenerations.get(initial[1])).toBe(2)
          expect(boundGenerations.get(rebuilt[0])).toBe(3)
          expect(boundGenerations.get(rebuilt[1])).toBe(4)
          expect(rebuilt[2]).toBe(initial[2])
          expect(generations.get(target)).toBe(4)
          expect(generations.get(separate)).toBe(1)
        }).pipe(Effect.scoped, Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node])))),
      )
    } finally {
      await Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))
    }
  })

  test("retries locations left after workspace invalidation is interrupted", async () => {
    const dirs = await Promise.all([tmpdir(), tmpdir(), tmpdir()])
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const finalized: Array<string> = []
          const filesystem = yield* FSUtil.Service
          const process = yield* AppProcess.Service
          const target = WorkspaceV2.ID.make("wrk_interrupted")
          const separate = WorkspaceV2.ID.make("wrk_untouched")
          const refs = [
            Location.Ref.make({ directory: AbsolutePath.make(dirs[0].path), workspaceID: target }),
            Location.Ref.make({ directory: AbsolutePath.make(dirs[1].path), workspaceID: target }),
            Location.Ref.make({ directory: AbsolutePath.make(dirs[2].path), workspaceID: separate }),
          ]
          const guidance = Layer.effect(
            SkillGuidance.Service,
            Effect.acquireRelease(Effect.succeed(SkillGuidance.Service.of({ load: () => Effect.die("unused") })), () =>
              Effect.sync(() => finalized.push("released")).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    finalized.length === 1
                      ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                      : Effect.void,
                  ),
                ),
              ),
            ),
          )
          const provider: WorkspaceProvider.Interface = {
            bind: (ref) =>
              Effect.succeed({
                root: ref.directory,
                project: { id: ProjectV2.ID.global, directory: ref.directory },
                filesystem,
                process,
              }),
            create: () => Effect.die("unused"),
            environment: () => Effect.die("unused"),
          }
          const locations = Context.get(
            yield* Layer.build(buildLocationServiceMap([[SkillGuidance.node, guidance]], provider)),
            LocationServiceMap.Service,
          )
          yield* Effect.forEach(refs, (ref) => Effect.scoped(locations.contextEffect(ref)), { discard: true })

          const invalidation = yield* locations.invalidateWorkspace(target).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const interruption = yield* Fiber.interrupt(invalidation).pipe(Effect.forkChild)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interruption)
          expect(finalized).toHaveLength(1)

          yield* locations.invalidateWorkspace(target)
          expect(finalized).toHaveLength(2)
          yield* locations.invalidateWorkspace(separate)
          expect(finalized).toHaveLength(3)
        }).pipe(Effect.scoped, Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node])))),
      )
    } finally {
      await Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))
    }
  })
})
