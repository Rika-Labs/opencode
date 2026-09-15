export * as AppTicket from "./app-ticket"

import { Schema } from "effect"
import { PositiveInt } from "./schema"

export interface Ticket extends Schema.Schema.Type<typeof Ticket> {}
export const Ticket = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
}).annotate({ identifier: "AppTicket.Ticket" })

export interface Session extends Schema.Schema.Type<typeof Session> {}
export const Session = Schema.Struct({
  token: Schema.String,
  expires_in: PositiveInt,
}).annotate({ identifier: "AppTicket.Session" })
