import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { WorkspaceAdmission } from "@opencode-ai/core/workspace-admission"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"
import { Deferred, Effect, Ref, Semaphore } from "effect"

type PromoteInput = Parameters<WorkspaceProvider.Interface["promote"]>[0]
type PromotionInput = Parameters<WorkspaceProvider.Interface["promotion"]>[0]

type Pending = {
  readonly input: PromoteInput
  readonly closed: WorkspaceAdmission.Closed
  readonly operationID?: string
  readonly running?: Deferred.Deferred<WorkspaceProvider.Promotion, WorkspaceProvider.Error>
}

export function makeWorkspaceClient(
  provider: WorkspaceProvider.Interface,
  admission: WorkspaceAdmission.Interface,
  locations: Pick<LocationServiceMap.Interface, "invalidateWorkspace">,
) {
  return Effect.gen(function* () {
    const pending = yield* Ref.make(new Map<PromoteInput["workspaceID"], Pending>())
    const lock = Semaphore.makeUnsafe(1)

    const replace = (workspaceID: PromoteInput["workspaceID"], update: (value: Pending) => Pending) =>
      Ref.update(pending, (current) => {
        const value = current.get(workspaceID)
        if (!value) return current
        return new Map(current).set(workspaceID, update(value))
      })

    const conflict = (input: PromoteInput) =>
      new WorkspaceProvider.Error({
        operation: "promote",
        code: "conflict",
        message: `Workspace ${input.workspaceID} already has a different promotion request`,
      })

    const awaitTerminal = (
      workspaceID: PromoteInput["workspaceID"],
      current: WorkspaceProvider.Promotion,
    ): Effect.Effect<WorkspaceProvider.Promotion, WorkspaceProvider.Error> => {
      if (current.status === "completed" || current.status === "failed") return Effect.succeed(current)
      return Effect.sleep("250 millis").pipe(
        Effect.andThen(provider.promotion({ workspaceID, operationID: current.id })),
        Effect.flatMap((next) => awaitTerminal(workspaceID, next)),
      )
    }

    const run = Effect.fn("OpenCode.workspaces.promote.run")(function* (state: Pending) {
      yield* state.closed.awaitIdle
      const accepted = state.operationID
        ? yield* provider.promotion({ workspaceID: state.input.workspaceID, operationID: state.operationID })
        : yield* provider.promote(state.input).pipe(
            Effect.tap((promotion) =>
              lock.withPermit(
                replace(state.input.workspaceID, (current) => ({
                  ...current,
                  operationID: promotion.id,
                })),
              ),
            ),
          )
      const terminal = yield* awaitTerminal(state.input.workspaceID, accepted)
      if (terminal.status !== "completed") return terminal
      yield* Effect.uninterruptibleMask((restore) =>
        restore(locations.invalidateWorkspace(state.input.workspaceID)).pipe(
          Effect.andThen(state.closed.reopen),
          Effect.andThen(
            lock.withPermit(
              Ref.update(pending, (current) => {
                const value = current.get(state.input.workspaceID)
                if (value?.input.requestID !== state.input.requestID) return current
                const next = new Map(current)
                next.delete(state.input.workspaceID)
                return next
              }),
            ),
          ),
        ),
      )
      return terminal
    })

    const promote = Effect.fn("OpenCode.workspaces.promote")((input: PromoteInput) =>
      Effect.uninterruptibleMask((restore) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = (yield* Ref.get(pending)).get(input.workspaceID)
            if (
              current &&
              (current.input.requestID !== input.requestID ||
                JSON.stringify(current.input.target) !== JSON.stringify(input.target))
            )
              return yield* conflict(input)
            if (current?.running) return { state: current, running: current.running, owner: false as const }
            const state = current ?? {
              input,
              closed: yield* admission.close(input.workspaceID).pipe(Effect.mapError(() => conflict(input))),
            }
            const running = yield* Deferred.make<WorkspaceProvider.Promotion, WorkspaceProvider.Error>()
            yield* Ref.update(pending, (values) => new Map(values).set(input.workspaceID, { ...state, running }))
            return { state, running, owner: true as const }
          }),
        ).pipe(
          Effect.flatMap((claim) => {
            if (!claim.owner) return restore(Deferred.await(claim.running))
            return restore(run(claim.state)).pipe(
              Effect.onExit((exit) =>
                Deferred.done(claim.running, exit).pipe(
                  Effect.andThen(
                    lock.withPermit(replace(input.workspaceID, (current) => ({ ...current, running: undefined }))),
                  ),
                ),
              ),
            )
          }),
        ),
      ),
    )

    const promotion = Effect.fn("OpenCode.workspaces.promotion")(function* (input: PromotionInput) {
      const local = (yield* Ref.get(pending)).get(input.workspaceID)
      if (!local || (input.operationID !== local.input.requestID && input.operationID !== local.operationID)) {
        return yield* provider.promotion(input)
      }
      if (!local.operationID) {
        return { id: input.operationID, status: "waiting_for_idle" as const }
      }
      return yield* provider.promotion({ workspaceID: input.workspaceID, operationID: local.operationID })
    })

    return {
      create: provider.create,
      environment: provider.environment,
      promote,
      promotion,
    } satisfies Pick<WorkspaceProvider.Interface, "create" | "environment" | "promote" | "promotion">
  })
}
