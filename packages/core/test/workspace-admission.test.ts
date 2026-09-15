import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { WorkspaceAdmission } from "@opencode-ai/core/workspace-admission"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(WorkspaceAdmission.node))
const first = WorkspaceV2.ID.make("wrk_first")
const second = WorkspaceV2.ID.make("wrk_second")

describe("WorkspaceAdmission", () => {
  it.effect("closes one workspace after its existing leases drain", () =>
    Effect.gen(function* () {
      const admission = yield* WorkspaceAdmission.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const existing = yield* Effect.scoped(
        admission.lease(first).pipe(
          Effect.flatMap((lease) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(lease.canPromote),
            ),
          ),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const closed = yield* admission.close(first)
      const acquired = yield* Deferred.make<void>()
      const blocked = yield* Effect.scoped(
        admission.lease(first).pipe(Effect.andThen(Deferred.succeed(acquired, undefined))),
      ).pipe(Effect.forkChild)
      expect(yield* Effect.scoped(admission.lease(second).pipe(Effect.flatMap((lease) => lease.canPromote)))).toBe(true)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(existing)).toBe(false)
      yield* closed.awaitIdle
      expect(yield* Deferred.isDone(acquired)).toBe(false)

      yield* closed.reopen
      yield* Fiber.join(blocked)
      expect(yield* Deferred.isDone(acquired)).toBe(true)
    }),
  )

  it.effect("rejects a second close owner and recovers after an interrupted idle wait", () =>
    Effect.gen(function* () {
      const admission = yield* WorkspaceAdmission.Service
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const lease = yield* Effect.scoped(
        admission.lease(first).pipe(
          Effect.tap(() => Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const closed = yield* admission.close(first)
      expect((yield* admission.close(first).pipe(Effect.flip))._tag).toBe("WorkspaceAdmission.AlreadyClosedError")

      const waiting = yield* closed.awaitIdle.pipe(Effect.forkChild)
      yield* Fiber.interrupt(waiting)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(lease)
      yield* closed.reopen
      expect(yield* Effect.scoped(admission.lease(first).pipe(Effect.flatMap((owned) => owned.canPromote)))).toBe(true)
    }),
  )

  it.effect("interrupts a lease blocked by a closed workspace without reopening it", () =>
    Effect.gen(function* () {
      const admission = yield* WorkspaceAdmission.Service
      yield* admission.close(first)
      const blocked = yield* Effect.scoped(admission.lease(first)).pipe(Effect.forkChild)
      yield* Fiber.interrupt(blocked).pipe(Effect.timeout("1 second"))
    }),
  )
})
