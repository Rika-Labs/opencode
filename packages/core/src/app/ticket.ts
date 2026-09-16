export * as AppTicket from "./ticket.js"

import { App } from "@opencode/schema/app"
import { AppTicket } from "@opencode/schema/app-ticket"
import { Workspace } from "@opencode/schema/workspace"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Cache, Context, Duration, Effect, Layer, Option } from "effect"

const DEFAULT_TTL = Duration.seconds(60)
const SESSION_TTL = Duration.hours(12)
const CAPACITY = 10_000

export const Ticket = AppTicket.Ticket
export const Session = AppTicket.Session

export type Scope = {
  readonly appID: App.ID
  readonly directory: string
  readonly workspaceID?: Workspace.ID
}

export interface Interface {
  issue(input: Scope): Effect.Effect<typeof Ticket.Type>
  consume(ticket: string): Effect.Effect<Option.Option<Scope>>
  readonly session: {
    issue(input: Scope): Effect.Effect<typeof Session.Type>
    verify(token: string): Effect.Effect<Option.Option<Scope>>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AppTicket") {}

const noLookup = () => Effect.die("AppTicket cache must be used via set/invalidateWhen/getOption, never get")

const expiresIn = (ttl: Duration.Input) => Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))

export const make = (ttl: Duration.Input = DEFAULT_TTL, sessionTtl: Duration.Input = SESSION_TTL) =>
  Effect.gen(function* () {
    const tickets = yield* Cache.make<string, Scope>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    const sessions = yield* Cache.make<string, Scope>({
      capacity: CAPACITY,
      lookup: noLookup,
      timeToLive: sessionTtl,
    })
    const ticketExpiresIn = expiresIn(ttl)
    const sessionExpiresIn = expiresIn(sessionTtl)
    return Service.of({
      issue: Effect.fn("AppTicket.issue")(function* (input) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(tickets, ticket, input)
        return { ticket, expires_in: ticketExpiresIn }
      }),
      consume: Effect.fn("AppTicket.consume")(function* (ticket) {
        let stored: Scope | undefined
        yield* Cache.invalidateWhen(tickets, ticket, (scope) => {
          stored = scope
          return true
        })
        return Option.fromNullishOr(stored)
      }),
      session: {
        issue: Effect.fn("AppTicket.session.issue")(function* (input) {
          const token = crypto.randomUUID()
          yield* Cache.set(sessions, token, input)
          return { token, expires_in: sessionExpiresIn }
        }),
        verify: Effect.fn("AppTicket.session.verify")(function* (token) {
          return yield* Cache.getOption(sessions, token)
        }),
      },
    })
  })

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
