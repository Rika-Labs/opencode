export * as Actors from "./actors.ts"

import { Client } from "@rivetkit/effect"
import { Effect } from "effect"

export interface Options extends Client.Options {}

export const connect = Effect.fn("Rivet.Actors.connect")(function* (options: Options) {
  const client = yield* Client.make(options)
  return {
    actor: client.makeActorAccessor,
  }
})
