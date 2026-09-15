import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { WorkspaceAdmission } from "@opencode-ai/core/workspace-admission"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Context, Deferred, Effect, Fiber, Layer, LayerMap, RcMap, Ref, Scope } from "effect"
import { makeWorkspaceClient } from "../src/workspace-client"

class Generation extends Context.Service<Generation, number>()("test/WorkspaceClientGeneration") {}

const first = WorkspaceV2.ID.make("wrk_first")
const second = WorkspaceV2.ID.make("wrk_second")
const target = { type: "sandbox", provider: "test" } as const
const input = { workspaceID: first, requestID: "request-1", target }

function run(effect: Effect.Effect<void, unknown, WorkspaceAdmission.Service | Scope.Scope>) {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(LayerNode.compile(WorkspaceAdmission.node))))
}

function fixture() {
  return Effect.gen(function* () {
    const admission = yield* WorkspaceAdmission.Service
    const provisioning = yield* Deferred.make<void>()
    const status = yield* Ref.make<WorkspaceProvider.Promotion["status"]>("provisioning")
    const promotes = yield* Ref.make(0)
    const provider = {
      bind: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      environment: () => Effect.die("unused"),
      promote: () =>
        Ref.updateAndGet(promotes, (value) => value + 1).pipe(
          Effect.andThen(Deferred.await(provisioning)),
          Effect.as({ id: "operation-1", status: "provisioning" as const }),
        ),
      promotion: () => Ref.get(status).pipe(Effect.map((value) => ({ id: "operation-1", status: value }))),
    } satisfies WorkspaceProvider.Interface
    const generations = yield* Ref.make(0)
    const map = yield* LayerMap.make(
      (_ref: Location.Ref) => Layer.effect(Generation, Ref.updateAndGet(generations, (value) => value + 1)),
      { idleTimeToLive: "1 minute" },
    )
    const locations = {
      invalidateWorkspace: (workspaceID: WorkspaceV2.ID) =>
        RcMap.keys(map.rcMap).pipe(
          Effect.flatMap((keys) =>
            Effect.forEach(
              Array.from(keys).filter((ref) => ref.workspaceID === workspaceID),
              (ref) => map.invalidate(ref),
              { discard: true },
            ),
          ),
        ),
    }
    const client = yield* makeWorkspaceClient(provider, admission, locations)
    return { admission, client, generations, map, promotes, provisioning, status }
  })
}

function generation(value: Effect.Success<ReturnType<typeof fixture>>, workspaceID = first) {
  return Effect.scoped(
    value.map.contextEffect(
      Location.Ref.make({ directory: AbsolutePath.make(`/tmp/${workspaceID}`), workspaceID }),
    ).pipe(Effect.map((context) => Context.get(context, Generation))),
  )
}

describe("workspace client promotion", () => {
  test("waits for an existing lease while another workspace proceeds", () =>
    run(
      Effect.gen(function* () {
        const value = yield* fixture()
        const release = yield* Deferred.make<void>()
        const held = yield* Effect.scoped(
          value.admission.lease(first).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild)
        const promotion = yield* value.client.promote(input).pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        expect(yield* Ref.get(value.promotes)).toBe(0)
        expect(yield* Effect.scoped(value.admission.lease(second))).toBeDefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(held)
        yield* Deferred.succeed(value.provisioning, undefined)
        yield* Ref.set(value.status, "failed")
        yield* Fiber.join(promotion)
      }),
    ),
  )

  test("invalidates cached locations before reopening admission", () =>
    run(
      Effect.gen(function* () {
        const value = yield* fixture()
        expect(yield* generation(value)).toBe(1)
        const promotion = yield* value.client.promote(input).pipe(Effect.forkChild)
        yield* Deferred.succeed(value.provisioning, undefined)
        yield* Ref.set(value.status, "completed")
        expect((yield* Fiber.join(promotion)).status).toBe("completed")
        expect(yield* generation(value)).toBe(2)
        expect(yield* Effect.scoped(value.admission.lease(first).pipe(Effect.flatMap((lease) => lease.canPromote)))).toBe(
          true,
        )
      }),
    ),
  )

  test("keeps admission closed after failure and resumes an interrupted exact retry", () =>
    run(
      Effect.gen(function* () {
        const value = yield* fixture()
        const firstRun = yield* value.client.promote(input).pipe(Effect.forkChild)
        yield* Deferred.succeed(value.provisioning, undefined)
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(firstRun)
        expect(yield* Ref.get(value.promotes)).toBe(1)
        expect(yield* value.admission.close(first).pipe(Effect.flip, Effect.map((error) => error._tag))).toBe(
          "WorkspaceAdmission.AlreadyClosedError",
        )
        yield* Ref.set(value.status, "failed")
        expect((yield* value.client.promote(input)).status).toBe("failed")
        expect(yield* Ref.get(value.promotes)).toBe(1)
        expect(yield* value.admission.close(first).pipe(Effect.flip, Effect.map((error) => error._tag))).toBe(
          "WorkspaceAdmission.AlreadyClosedError",
        )
      }),
    ),
  )

  test("joins concurrent identical requests and rejects conflicting requests", () =>
    run(
      Effect.gen(function* () {
        const value = yield* fixture()
        const owner = yield* value.client.promote(input).pipe(Effect.forkChild)
        const joined = yield* value.client.promote(input).pipe(Effect.forkChild)
        yield* Deferred.succeed(value.provisioning, undefined)
        yield* Ref.set(value.status, "failed")
        expect((yield* Fiber.join(owner)).id).toBe("operation-1")
        expect((yield* Fiber.join(joined)).id).toBe("operation-1")
        expect(yield* Ref.get(value.promotes)).toBe(1)
        const requestConflict = value.client.promote({ ...input, requestID: "request-2" }).pipe(Effect.flip)
        const targetConflict = value.client.promote({ ...input, target: { type: "agentos" } }).pipe(Effect.flip)
        expect((yield* requestConflict).code).toBe("conflict")
        expect((yield* targetConflict).code).toBe("conflict")
      }),
    ),
  )

  test("an immediate interruption cannot strand an unrecorded closed claim", () =>
    run(
      Effect.gen(function* () {
        const value = yield* fixture()
        const interrupted = yield* value.client.promote(input).pipe(Effect.forkChild)
        yield* Fiber.interrupt(interrupted)
        yield* Deferred.succeed(value.provisioning, undefined)
        yield* Ref.set(value.status, "failed")
        expect((yield* value.client.promote(input)).id).toBe("operation-1")
        expect(yield* Ref.get(value.promotes)).toBe(1)
      }),
    ),
  )
})
