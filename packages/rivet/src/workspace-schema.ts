import { Schema } from "effect"

export const Backend = Schema.Literals(["agentos", "e2b"])
export const Lifecycle = Schema.Literals(["running", "stopped", "promoting", "blocked"])

export const Environment = Schema.Struct({
  backend: Backend,
  generation: Schema.Number,
  lifecycle: Lifecycle,
})

export const Promotion = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({
    status: Schema.Literal("running"),
    requestID: Schema.String,
    target: Backend,
    source: Backend,
    sourceGeneration: Schema.Number,
    sandboxID: Schema.optional(Schema.String),
    boundaryToken: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestID: Schema.String,
    target: Backend,
    source: Backend,
    sourceGeneration: Schema.Number,
    message: Schema.String,
    sandboxID: Schema.optional(Schema.String),
    boundaryToken: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("completed"),
    requestID: Schema.String,
    target: Backend,
    source: Backend,
    sourceGeneration: Schema.Number,
    generation: Schema.Number,
    cleanup: Schema.Literals(["pending", "complete", "failed"]),
    cleanupMessage: Schema.optional(Schema.String),
    sandboxID: Schema.optional(Schema.String),
    boundaryToken: Schema.optional(Schema.String),
    cleanupSandboxID: Schema.optional(Schema.String),
    cleanupBoundaryToken: Schema.optional(Schema.String),
  }),
])

export const PromotionRecord = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("failed"),
    requestID: Schema.String,
    target: Backend,
    source: Backend,
    sourceGeneration: Schema.Number,
    message: Schema.String,
    sandboxID: Schema.optional(Schema.String),
    boundaryToken: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("completed"),
    requestID: Schema.String,
    target: Backend,
    source: Backend,
    sourceGeneration: Schema.Number,
    generation: Schema.Number,
    cleanup: Schema.Literals(["pending", "complete", "failed"]),
    cleanupMessage: Schema.optional(Schema.String),
    sandboxID: Schema.optional(Schema.String),
    boundaryToken: Schema.optional(Schema.String),
    cleanupSandboxID: Schema.optional(Schema.String),
    cleanupBoundaryToken: Schema.optional(Schema.String),
  }),
])

export const StateSchema = Schema.Struct({
  initialized: Schema.Boolean,
  backend: Backend,
  generation: Schema.Number,
  lifecycle: Lifecycle,
  storageIdentity: Schema.String,
  directory: Schema.optional(Schema.String),
  sandboxID: Schema.optional(Schema.String),
  boundaryToken: Schema.optional(Schema.String),
  promotion: Promotion,
  promotionHistory: Schema.optional(Schema.Array(PromotionRecord)),
})

export type Backend = typeof Backend.Type
export type State = typeof StateSchema.Type
export type Promotion = typeof Promotion.Type
