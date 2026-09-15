import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { AgentOs } from "@rikalabs/agentos-core"
import { Effect, Exit, Fiber, Scope } from "effect"
import { AgentOS } from "../src/agentos.ts"

test("interruption waits for native creation and registered cleanup", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-acquisition-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  const originalCreate = AgentOs.create
  const nativeCreated = Promise.withResolvers<void>()
  const releaseCreate = Promise.withResolvers<void>()
  const disposed = Promise.withResolvers<void>()
  try {
    AgentOs.create = async (options) => {
      const vm = await originalCreate.call(AgentOs, options)
      const originalDispose = vm.dispose.bind(vm)
      vm.dispose = async () => {
        await originalDispose()
        disposed.resolve()
      }
      nativeCreated.resolve()
      await releaseCreate.promise
      return vm
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const fiber = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") }).pipe(
          Scope.provide(scope),
          Effect.forkChild,
        )
        yield* Effect.promise(() => nativeCreated.promise)
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        releaseCreate.resolve()
        yield* Fiber.join(interrupted)
        yield* Scope.close(scope, Exit.void)
        yield* Effect.promise(() => disposed.promise)
      }),
    )
  } finally {
    AgentOs.create = originalCreate
    releaseCreate.resolve()
    await rm(root, { recursive: true, force: true })
  }
})

test("dispose failure still terminates the sidecar", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-dispose-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  const originalCreate = AgentOs.create
  const termination = { count: 0 }
  try {
    AgentOs.create = async (options) => {
      const vm = await originalCreate.call(AgentOs, options)
      const sidecar = options?.sidecar?.kind === "explicit" ? options.sidecar.handle : undefined
      assert(sidecar)
      const originalTerminate = sidecar.terminate.bind(sidecar)
      sidecar.terminate = async () => {
        termination.count++
        return originalTerminate()
      }
      const originalDispose = vm.dispose.bind(vm)
      const disposal = { count: 0 }
      vm.dispose = async () => {
        disposal.count++
        if (disposal.count === 1) throw new Error("dispose failed")
        return originalDispose()
      }
      return vm
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const environment = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") })
          const stopped = yield* Effect.exit(environment.stop)
          assert(Exit.isFailure(stopped))
          assert.equal(termination.count, 1)
          yield* environment.stop
        }),
      ),
    )
  } finally {
    AgentOs.create = originalCreate
    await rm(root, { recursive: true, force: true })
  }
})

test("failed scope cleanup is reported and stop can retry", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-stop-retry-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  const originalCreate = AgentOs.create
  const termination = { count: 0 }
  try {
    AgentOs.create = async (options) => {
      const vm = await originalCreate.call(AgentOs, options)
      const sidecar = options?.sidecar?.kind === "explicit" ? options.sidecar.handle : undefined
      assert(sidecar)
      const originalTerminate = sidecar.terminate.bind(sidecar)
      sidecar.terminate = async () => {
        termination.count++
        if (termination.count === 1) throw new Error("termination failed")
        return originalTerminate()
      }
      return vm
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const environment = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") }).pipe(
          Scope.provide(scope),
        )
        const closed = yield* Effect.exit(Scope.close(scope, Exit.void))
        assert(Exit.isFailure(closed))
        const retried = yield* Effect.exit(environment.stop)
        assert(Exit.isSuccess(retried))
        assert.equal(termination.count, 2)
      }),
    )
  } finally {
    AgentOs.create = originalCreate
    await rm(root, { recursive: true, force: true })
  }
})
