import { Schema } from "effect"

export const Backend = Schema.Literals(["local", "e2b"])
export const Lifecycle = Schema.Literals(["running", "stopped"])

export const Environment = Schema.Struct({
  backend: Backend,
  generation: Schema.Number,
  lifecycle: Lifecycle,
  root: Schema.optional(Schema.String),
})

export const StateSchema = Schema.Struct({
  initialized: Schema.Boolean,
  backend: Backend,
  generation: Schema.Number,
  lifecycle: Lifecycle,
  storageIdentity: Schema.String,
  sandboxID: Schema.optional(Schema.String),
  boundaryToken: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
})

export type Backend = typeof Backend.Type
export type State = typeof StateSchema.Type
