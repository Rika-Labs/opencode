export * as AppTicket from "./ticket"

import { WorkspaceV2 } from "../workspace"
import { AppTicket } from "@opencode-ai/schema/app-ticket"
import { App } from "@opencode-ai/schema/app"
import { Cache, Context, Duration, Effect, Layer, Option } from "effect"
import { makeGlobalNode } from "../effect/app-node"

const DEFAULT_TTL = Duration.seconds(60)
const SESSION_TTL = Duration.hours(12)
const CAPACITY = 10_000

export const Ticket = AppTicket.Ticket
export const Session = AppTicket.Session

export type Scope = {
  readonly appID: App.ID
  readonly directory?: string
  readonly workspaceID?: WorkspaceV2.ID
}

export interface Interface {
  issue(input: Scope): Effect.Effect<typeof Ticket.Type>
  consume(input: Scope & { readonly ticket: string }): Effect.Effect<boolean>
  readonly session: {
    issue(input: Scope): Effect.Effect<typeof Session.Type>
    verify(input: Scope & { readonly token: string }): Effect.Effect<boolean>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AppTicket") {}

function matches(record: Scope, input: Scope) {
  return (
    record.appID === input.appID && record.directory === input.directory && record.workspaceID === input.workspaceID
  )
}

const noLookup = () => Effect.succeed(Option.none<Scope>())

const expiresIn = (ttl: Duration.Input) => Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))

export const make = (ttl: Duration.Input = DEFAULT_TTL, sessionTtl: Duration.Input = SESSION_TTL) =>
  Effect.gen(function* () {
    const tickets = yield* Cache.make<string, Option.Option<Scope>>({
      capacity: CAPACITY,
      lookup: noLookup,
      timeToLive: ttl,
    })
    const sessions = yield* Cache.make<string, Option.Option<Scope>>({
      capacity: CAPACITY,
      lookup: noLookup,
      timeToLive: sessionTtl,
    })
    return Service.of({
      issue: Effect.fn("AppTicket.issue")(function* (input) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(tickets, ticket, Option.some(input))
        return { ticket, expires_in: expiresIn(ttl) }
      }),
      consume: Effect.fn("AppTicket.consume")(function* (input) {
        return yield* Cache.invalidateWhen(tickets, input.ticket, (stored) =>
          Option.isSome(stored) && matches(stored.value, input),
        )
      }),
      session: {
        issue: Effect.fn("AppTicket.session.issue")(function* (input) {
          const token = crypto.randomUUID()
          yield* Cache.set(sessions, token, Option.some(input))
          return { token, expires_in: expiresIn(sessionTtl) }
        }),
        verify: Effect.fn("AppTicket.session.verify")(function* (input) {
          const stored = yield* Cache.getOption(sessions, input.token)
          return Option.isSome(stored) && Option.isSome(stored.value) && matches(stored.value.value, input)
        }),
      },
    })
  })

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })
