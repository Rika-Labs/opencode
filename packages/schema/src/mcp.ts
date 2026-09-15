export * as Mcp from "./mcp"

import { Schema } from "effect"
import { optional } from "./schema"

export interface Connected extends Schema.Schema.Type<typeof Connected> {}
export const Connected = Schema.Struct({
  status: Schema.Literal("connected"),
}).annotate({ identifier: "Mcp.Connected" })

export interface Disabled extends Schema.Schema.Type<typeof Disabled> {}
export const Disabled = Schema.Struct({
  status: Schema.Literal("disabled"),
}).annotate({ identifier: "Mcp.Disabled" })

export interface Failed extends Schema.Schema.Type<typeof Failed> {}
export const Failed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.String,
}).annotate({ identifier: "Mcp.Failed" })

export type ServerStatus = Connected | Disabled | Failed
export const ServerStatus = Schema.Union([Connected, Disabled, Failed]).annotate({ identifier: "Mcp.ServerStatus" })

export interface ToolUI extends Schema.Schema.Type<typeof ToolUI> {}
export const ToolUI = Schema.Struct({
  resourceUri: Schema.String,
}).annotate({ identifier: "Mcp.ToolUI" })

export interface ToolInfo extends Schema.Schema.Type<typeof ToolInfo> {}
export const ToolInfo = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  title: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  inputSchema: Schema.Json,
  outputSchema: Schema.Json.pipe(optional),
  meta: Schema.Json.pipe(optional),
  ui: ToolUI.pipe(optional),
}).annotate({ identifier: "Mcp.ToolInfo" })

export interface ResourceInfo extends Schema.Schema.Type<typeof ResourceInfo> {}
export const ResourceInfo = Schema.Struct({
  server: Schema.String,
  uri: Schema.String,
  name: Schema.String,
  description: Schema.String.pipe(optional),
  mimeType: Schema.String.pipe(optional),
  meta: Schema.Json.pipe(optional),
}).annotate({ identifier: "Mcp.ResourceInfo" })

export interface ResourceContent extends Schema.Schema.Type<typeof ResourceContent> {}
export const ResourceContent = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.String.pipe(optional),
  text: Schema.String.pipe(optional),
  blob: Schema.String.pipe(optional),
  meta: Schema.Json.pipe(optional),
}).annotate({ identifier: "Mcp.ResourceContent" })

export interface ResourceContents extends Schema.Schema.Type<typeof ResourceContents> {}
export const ResourceContents = Schema.Struct({
  contents: Schema.Array(ResourceContent),
}).annotate({ identifier: "Mcp.ResourceContents" })

export interface TextContent extends Schema.Schema.Type<typeof TextContent> {}
export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Mcp.TextContent" })

export interface ImageContent extends Schema.Schema.Type<typeof ImageContent> {}
export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
}).annotate({ identifier: "Mcp.ImageContent" })

export interface EmbeddedResource extends Schema.Schema.Type<typeof EmbeddedResource> {}
export const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: ResourceContent,
}).annotate({ identifier: "Mcp.EmbeddedResource" })

export type CallContent = TextContent | ImageContent | EmbeddedResource
export const CallContent = Schema.Union([TextContent, ImageContent, EmbeddedResource]).annotate({
  identifier: "Mcp.CallContent",
})

export interface CallResult extends Schema.Schema.Type<typeof CallResult> {}
export const CallResult = Schema.Struct({
  content: Schema.Array(CallContent),
  structuredContent: Schema.Json.pipe(optional),
  isError: Schema.Boolean.pipe(optional),
  meta: Schema.Json.pipe(optional),
}).annotate({ identifier: "Mcp.CallResult" })
