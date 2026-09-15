import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppTicket } from "@opencode-ai/core/app/ticket"
import { AppV2 } from "@opencode-ai/core/app"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppTicket.node))
const itExpiring = testEffect(
  LayerNode.compile(AppTicket.node, [[AppTicket.node, Layer.effect(AppTicket.Service, AppTicket.make(5, 5))]]),
)

describe("App tickets", () => {
  it.live("consumes tickets once and returns the issued scope", () =>
    Effect.gen(function* () {
      const tickets = yield* AppTicket.Service
      const scope = { appID: AppV2.ID.make("app_calc"), directory: "/tmp/a" }
      const issued = yield* tickets.issue(scope)

      const consumed = yield* tickets.consume(issued.ticket)
      expect(Option.isSome(consumed)).toBe(true)
      expect(Option.getOrNull(consumed)).toEqual(scope)
      expect(Option.isNone(yield* tickets.consume(issued.ticket))).toBe(true)
    }),
  )

  it.live("returns none for an unknown ticket", () =>
    Effect.gen(function* () {
      const tickets = yield* AppTicket.Service
      yield* tickets.issue({ appID: AppV2.ID.make("app_calc"), directory: "/tmp/a" })

      expect(Option.isNone(yield* tickets.consume("missing"))).toBe(true)
    }),
  )

  it.live("round-trips the workspace scope through a session", () =>
    Effect.gen(function* () {
      const tickets = yield* AppTicket.Service
      const scope = {
        appID: AppV2.ID.make("app_calc"),
        directory: "/tmp/a",
        workspaceID: WorkspaceV2.ID.ascending(),
      }
      const session = yield* tickets.session.issue(scope)

      const verified = yield* tickets.session.verify(session.token)
      expect(Option.isSome(verified)).toBe(true)
      expect(Option.getOrNull(verified)).toEqual(scope)
    }),
  )

  it.live("returns none for an unknown session token", () =>
    Effect.gen(function* () {
      const tickets = yield* AppTicket.Service
      yield* tickets.session.issue({ appID: AppV2.ID.make("app_calc"), directory: "/tmp/a" })

      expect(Option.isNone(yield* tickets.session.verify("missing"))).toBe(true)
    }),
  )

  itExpiring.live("rejects tickets after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* AppTicket.Service
      const issued = yield* tickets.issue({ appID: AppV2.ID.make("app_calc"), directory: "/tmp/a" })

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(Option.isNone(yield* tickets.consume(issued.ticket))).toBe(true)
    }),
  )

  itExpiring.live("rejects sessions after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* AppTicket.Service
      const session = yield* tickets.session.issue({ appID: AppV2.ID.make("app_calc"), directory: "/tmp/a" })

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(Option.isNone(yield* tickets.session.verify(session.token))).toBe(true)
    }),
  )
})
