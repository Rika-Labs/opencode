export * as WorkspaceAdmission from "./workspace-admission"

import { Context, Data, Deferred, Effect, Layer, Scope, SynchronizedRef } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { WorkspaceV2 } from "./workspace"

export class AlreadyClosedError extends Data.TaggedError("WorkspaceAdmission.AlreadyClosedError")<{
  readonly workspaceID: WorkspaceV2.ID
}> {}

export type Lease = {
  readonly canPromote: Effect.Effect<boolean>
}

export type Closed = {
  readonly awaitIdle: Effect.Effect<void>
  readonly reopen: Effect.Effect<void>
}

export interface Interface {
  readonly lease: (workspaceID: WorkspaceV2.ID) => Effect.Effect<Lease, never, Scope.Scope>
  readonly close: (workspaceID: WorkspaceV2.ID) => Effect.Effect<Closed, AlreadyClosedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkspaceAdmission") {}

type Open = { readonly status: "open"; readonly active: number }
type ClosedState = {
  readonly status: "closed"
  readonly active: number
  readonly token: object
  readonly idle: Deferred.Deferred<void>
  readonly reopened: Deferred.Deferred<void>
}
type State = Open | ClosedState
type AcquireResult = { readonly wait: Deferred.Deferred<void> } | { readonly acquired: true }
type CloseResult =
  | { readonly error: AlreadyClosedError }
  | {
      readonly closed: ClosedState
    }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const states = SynchronizedRef.makeUnsafe(new Map<WorkspaceV2.ID, State>())

    const acquire = (workspaceID: WorkspaceV2.ID): Effect.Effect<void> =>
      SynchronizedRef.modify(states, (current): readonly [AcquireResult, Map<WorkspaceV2.ID, State>] => {
        const state = current.get(workspaceID) ?? { status: "open", active: 0 }
        if (state.status === "closed") return [{ wait: state.reopened }, current]
        return [
          { acquired: true },
          new Map(current).set(workspaceID, { status: "open", active: state.active + 1 }),
        ]
      }).pipe(
        Effect.flatMap((result) =>
          "wait" in result
            ? Deferred.await(result.wait).pipe(Effect.interruptible, Effect.andThen(acquire(workspaceID)))
            : Effect.void,
        ),
      )

    const release = (workspaceID: WorkspaceV2.ID) =>
      SynchronizedRef.modify(states, (current) => {
        const state = current.get(workspaceID)
        if (!state) return [undefined, current]
        const active = state.active - 1
        const next = new Map(current).set(workspaceID, { ...state, active })
        return [state.status === "closed" && active === 0 ? state.idle : undefined, next]
      }).pipe(Effect.flatMap((idle) => (idle ? Deferred.succeed(idle, undefined) : Effect.void)), Effect.asVoid)

    const lease = (workspaceID: WorkspaceV2.ID) =>
      Effect.acquireRelease(acquire(workspaceID), () => release(workspaceID)).pipe(
        Effect.map(() => ({
          canPromote: SynchronizedRef.get(states).pipe(
            Effect.map((current) => {
              const state = current.get(workspaceID)
              return state?.status === "open"
            }),
          ),
        })),
      )

    const close = (workspaceID: WorkspaceV2.ID) =>
      SynchronizedRef.modify(states, (current): readonly [CloseResult, Map<WorkspaceV2.ID, State>] => {
        const state = current.get(workspaceID) ?? { status: "open", active: 0 }
        if (state.status === "closed") return [{ error: new AlreadyClosedError({ workspaceID }) }, current]
        const token = {}
        const idle = Deferred.makeUnsafe<void>()
        const reopened = Deferred.makeUnsafe<void>()
        return [
          { closed: { status: "closed", token, idle, reopened, active: state.active } },
          new Map(current).set(workspaceID, { status: "closed", active: state.active, token, idle, reopened }),
        ]
      }).pipe(
        Effect.flatMap((result) => {
          if ("error" in result) return Effect.fail(result.error)
          const closed = result.closed
          const awaitIdle = Deferred.await(closed.idle)
          const reopen = awaitIdle.pipe(
            Effect.andThen(
              SynchronizedRef.modify(states, (current) => {
                const state = current.get(workspaceID)
                if (state?.status !== "closed" || state.token !== closed.token) return [undefined, current]
                return [state.reopened, new Map(current).set(workspaceID, { status: "open", active: 0 })]
              }).pipe(
                Effect.flatMap((reopened) => (reopened ? Deferred.succeed(reopened, undefined) : Effect.void)),
                Effect.asVoid,
                Effect.uninterruptible,
              ),
            ),
          )
          return (closed.active === 0 ? Deferred.succeed(closed.idle, undefined) : Effect.void).pipe(
            Effect.as({ awaitIdle, reopen }),
          )
        }),
        Effect.uninterruptible,
      )

    return Service.of({ lease, close })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
