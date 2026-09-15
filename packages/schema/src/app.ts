export * as App from "./app"

import { Effect, Schema } from "effect"
import { descending } from "./identifier"
import { AbsolutePath, DateTimeUtcFromMillis, optional, PositiveInt, RelativePath, statics } from "./schema"

export const ID = Schema.String.check(Schema.isPattern(/^app_[a-z0-9_-]+$/)).pipe(
  Schema.brand("AppID"),
  statics((schema) => ({
    create: () => schema.make("app_" + descending().toLowerCase()),
  })),
)
export type ID = typeof ID.Type

export interface Csp extends Schema.Schema.Type<typeof Csp> {}
export const Csp = Schema.Struct({
  connectDomains: Schema.Array(Schema.String).pipe(optional),
  resourceDomains: Schema.Array(Schema.String).pipe(optional),
  frameDomains: Schema.Array(Schema.String).pipe(optional),
  baseUriDomains: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "App.Csp" })

export interface Permissions extends Schema.Schema.Type<typeof Permissions> {}
export const Permissions = Schema.Struct({
  camera: Schema.Boolean.pipe(optional),
  microphone: Schema.Boolean.pipe(optional),
  geolocation: Schema.Boolean.pipe(optional),
  clipboardWrite: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "App.Permissions" })

export interface Timeout extends Schema.Schema.Type<typeof Timeout> {}
export const Timeout = Schema.Struct({
  startup: PositiveInt.pipe(optional),
  request: PositiveInt.pipe(optional),
}).annotate({ identifier: "App.McpTimeout" })

export interface McpLocal extends Schema.Schema.Type<typeof McpLocal> {}
export const McpLocal = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.Array(Schema.String),
  cwd: Schema.String.pipe(optional),
  environment: Schema.Record(Schema.String, Schema.String).pipe(optional),
  timeout: Timeout.pipe(optional),
}).annotate({ identifier: "App.McpLocal" })

export interface McpRemote extends Schema.Schema.Type<typeof McpRemote> {}
export const McpRemote = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
  timeout: Timeout.pipe(optional),
}).annotate({ identifier: "App.McpRemote" })

export type McpServer = McpLocal | McpRemote
export const McpServer = Schema.Union([McpLocal, McpRemote]).annotate({ identifier: "App.McpServer" })

export interface Web extends Schema.Schema.Type<typeof Web> {}
export const Web = Schema.Struct({
  root: RelativePath,
  entry: RelativePath.pipe(Schema.withDecodingDefault(Effect.succeed("index.html" as RelativePath))),
}).annotate({ identifier: "App.Web" })

export interface Ui extends Schema.Schema.Type<typeof Ui> {}
export const Ui = Schema.Struct({
  csp: Csp.pipe(optional),
  permissions: Permissions.pipe(optional),
}).annotate({ identifier: "App.Ui" })

export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
export const Manifest = Schema.Struct({
  id: ID,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String.pipe(optional),
  mcp: McpServer.pipe(optional),
  skills: Schema.Array(RelativePath).pipe(optional),
  web: Web.pipe(optional),
  ui: Ui.pipe(optional),
  permissions: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "App.Manifest" })

export interface Active extends Schema.Schema.Type<typeof Active> {}
export const Active = Schema.Struct({
  status: Schema.Literal("active"),
}).annotate({ identifier: "App.Active" })

export interface Disabled extends Schema.Schema.Type<typeof Disabled> {}
export const Disabled = Schema.Struct({
  status: Schema.Literal("disabled"),
}).annotate({ identifier: "App.Disabled" })

export interface Failed extends Schema.Schema.Type<typeof Failed> {}
export const Failed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.String,
}).annotate({ identifier: "App.Failed" })

export type Status = Active | Disabled | Failed
export const Status = Schema.Union([Active, Disabled, Failed]).annotate({ identifier: "App.Status" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  manifest: Manifest,
  directory: AbsolutePath,
  server: Schema.String.pipe(optional),
  hasWeb: Schema.Boolean,
  status: Status,
}).annotate({ identifier: "App.Info" })

export const ReleaseID = Schema.String.check(Schema.isPattern(/^rel_[a-z0-9_-]+$/)).pipe(
  Schema.brand("AppReleaseID"),
  statics((schema) => ({
    create: () => schema.make("rel_" + descending().toLowerCase()),
  })),
)
export type ReleaseID = typeof ReleaseID.Type

export interface Release extends Schema.Schema.Type<typeof Release> {}
export const Release = Schema.Struct({
  id: ReleaseID,
  app: ID,
  url: Schema.String,
  created_at: DateTimeUtcFromMillis,
}).annotate({ identifier: "App.Release" })
