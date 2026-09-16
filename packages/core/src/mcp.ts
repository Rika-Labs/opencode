export * as McpV2 from "./mcp"

import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ContentBlock,
  type Tool as McpToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { Context, Effect, Exit, JsonSchema, Layer, Schema, Scope, Semaphore } from "effect"
import { Mcp } from "@opencode-ai/schema/mcp"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { ConfigMCP } from "./config/mcp"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { InstallationVersion } from "./installation/version"
import { Location } from "./location"
import { McpCatalog } from "./mcp/catalog"
import { PermissionV2 } from "./permission"
import { State } from "./state"
import { Tool } from "./tool/tool"
import { ToolRegistry } from "./tool/registry"
import { Tools } from "./tool/tools"

export const ServerStatus = Mcp.ServerStatus
export type ServerStatus = Mcp.ServerStatus

export const ToolInfo = Mcp.ToolInfo
export type ToolInfo = Mcp.ToolInfo

export const ResourceInfo = Mcp.ResourceInfo
export type ResourceInfo = Mcp.ResourceInfo

export const ResourceContent = Mcp.ResourceContent
export type ResourceContent = Mcp.ResourceContent

export const ResourceContents = Mcp.ResourceContents
export type ResourceContents = Mcp.ResourceContents

export const CallContent = Mcp.CallContent
export type CallContent = Mcp.CallContent

export const CallResult = Mcp.CallResult
export type CallResult = Mcp.CallResult

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("McpV2.NotFoundError", {
  name: Schema.String,
}) {}

export class McpError extends Schema.TaggedErrorClass<McpError>()("McpV2.Error", {
  server: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Authority = "trusted-global" | "workspace"

type ServerRecord = {
  readonly name: string
  readonly config: ConfigMCP.ServerConfig
  readonly authority: Authority
}

export type Data = {
  servers: ServerRecord[]
}

export type Draft = {
  server: (name: string, config: ConfigMCP.ServerConfig, authority?: Authority) => void
  list: () => readonly { name: string; config: ConfigMCP.ServerConfig }[]
}

type InternalDraft = Draft & { readonly records: () => readonly ServerRecord[] }

export interface Interface extends State.Transformable<Draft> {
  readonly status: () => Effect.Effect<Record<string, Mcp.ServerStatus>>
  readonly tools: (server?: string) => Effect.Effect<ReadonlyArray<Mcp.ToolInfo>>
  readonly resources: (server?: string) => Effect.Effect<ReadonlyArray<Mcp.ResourceInfo>>
  readonly readResource: (
    server: string,
    uri: string,
  ) => Effect.Effect<Mcp.ResourceContents, NotFoundError | McpError>
  readonly callTool: (
    server: string,
    name: string,
    args: Schema.Json,
  ) => Effect.Effect<Mcp.CallResult, NotFoundError | McpError>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError | McpError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Mcp") {}

const MANAGED_LOCAL_REFUSAL = "Local MCP servers are not supported in managed workspaces"
const WORKSPACE_LOCAL_REFUSAL = "Local MCP servers from workspace configuration are not supported"
const MANAGED_WORKSPACE_REFUSAL = "Workspace-configured MCP servers are not supported in managed workspaces"

type Managed = {
  readonly record: ServerRecord
  readonly client: Client
  readonly scope: Scope.Closeable
  registrations: Scope.Closeable
  tools: Mcp.ToolInfo[]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)

    const managed = new Map<string, Managed>()
    const statuses = new Map<string, Mcp.ServerStatus>()
    const mutex = Semaphore.makeUnsafe(1)
    const sameConfig = Schema.toEquivalence(ConfigMCP.Server)

    function refusal(record: ServerRecord): { status: "disabled" } | { status: "failed"; error: string } | undefined {
      if (record.config.disabled) return { status: "disabled" }
      if (location.isolated === true) return undefined
      const managedWorkspace = location.workspaceID !== undefined
      const workspace = record.authority === "workspace"
      if (record.config.type === "local")
        return managedWorkspace
          ? { status: "failed", error: MANAGED_LOCAL_REFUSAL }
          : workspace
            ? { status: "failed", error: WORKSPACE_LOCAL_REFUSAL }
            : undefined
      return managedWorkspace && workspace ? { status: "failed", error: MANAGED_WORKSPACE_REFUSAL } : undefined
    }

    function createClient() {
      const client = new Client(
        { name: "opencode", version: InstallationVersion },
        { capabilities: { roots: {} } },
      )
      client.setRequestHandler(ListRootsRequestSchema, () =>
        Promise.resolve({ roots: [{ uri: pathToFileURL(location.directory).href }] }),
      )
      return client
    }

    function transports(config: ConfigMCP.ServerConfig) {
      if (config.type === "local") {
        const [command, ...args] = config.command
        return [
          new StdioClientTransport({
            command,
            args,
            cwd: config.cwd ? path.resolve(location.directory, config.cwd) : location.directory,
            env: { ...process.env, ...config.environment } as Record<string, string>,
            stderr: "pipe",
          }),
        ]
      }
      if (!URL.canParse(config.url)) return []
      const url = new URL(config.url)
      const options = config.headers ? { requestInit: { headers: config.headers } } : undefined
      return [new StreamableHTTPClientTransport(url, options), new SSEClientTransport(url, options)]
    }

    function toolInfo(server: string, def: McpToolDef): Mcp.ToolInfo {
      const uri = (def._meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri
      return {
        server,
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema as Schema.Json,
        outputSchema: def.outputSchema as Schema.Json | undefined,
        meta: def._meta as Schema.Json | undefined,
        ui: typeof uri === "string" ? { resourceUri: uri } : undefined,
      }
    }

    function resourceContent(item: {
      uri: string
      mimeType?: string
      text?: string
      blob?: string
      _meta?: Record<string, unknown>
    }): Mcp.ResourceContent {
      return {
        uri: item.uri,
        mimeType: item.mimeType,
        text: typeof item.text === "string" ? item.text : undefined,
        blob: typeof item.blob === "string" ? item.blob : undefined,
        meta: item._meta as Schema.Json | undefined,
      }
    }

    function callContent(item: ContentBlock): Mcp.CallContent {
      if (item.type === "text") return { type: "text", text: item.text }
      if (item.type === "image") return { type: "image", data: item.data, mimeType: item.mimeType }
      if (item.type === "resource") return { type: "resource", resource: resourceContent(item.resource) }
      return { type: "text", text: JSON.stringify(item) }
    }

    function callResult(result: CallToolResult): Mcp.CallResult {
      return {
        content: result.content.map(callContent),
        structuredContent: result.structuredContent as Schema.Json | undefined,
        isError: result.isError || undefined,
        meta: result._meta as Schema.Json | undefined,
      }
    }

    const register = Effect.fnUntraced(function* (entry: Managed, listed: McpToolDef[]) {
      const { client, record } = entry
      const request = record.config.timeout?.request ?? McpCatalog.DEFAULT_TIMEOUT
      const names = listed.map((def) => McpCatalog.toolName(record.name, def.name))
      if (new Set(names).size !== names.length) return `Duplicate tool names from "${record.name}"`
      const registrations = Object.fromEntries(
        listed.map((def, index) => [
          names[index],
          Tool.make({
            description: def.description ?? "",
            input: def.inputSchema as JsonSchema.JsonSchema,
            output: Schema.Unknown,
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                  action: "mcp",
                  resources: [`${record.name}:${def.name}`],
                  save: [`${record.name}:${def.name}`],
                })
                const result = yield* Effect.tryPromise({
                  try: () =>
                    client.callTool(
                      { name: def.name, arguments: (input ?? {}) as Record<string, unknown> },
                      CallToolResultSchema,
                      {
                        resetTimeoutOnProgress: true,
                        timeout: request,
                        onprogress: () => {},
                      },
                    ),
                  catch: (error) => error,
                })
                if (result.isError)
                  return yield* new Tool.Failure({
                    message:
                      result.content
                        .flatMap((item) => (item.type === "text" ? [item.text] : []))
                        .filter((text) => text.trim())
                        .join("\n\n") || "MCP tool returned an error",
                  })
                return callResult(result)
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof Tool.Failure
                    ? error
                    : new Tool.Failure({ message: error instanceof Error ? error.message : String(error), error }),
                ),
              ),
            toModelOutput: ({ output }) => {
              const result = output as Mcp.CallResult
              const parts: Tool.Content[] = result.content.flatMap((item): Tool.Content[] => {
                if (item.type === "image") return [{ type: "file", data: item.data, mime: item.mimeType }]
                if (item.type === "text") return [{ type: "text", text: item.text }]
                return [{ type: "text", text: JSON.stringify(item.resource) }]
              })
              if (parts.length === 0 && result.structuredContent !== undefined)
                return [{ type: "text", text: JSON.stringify(result.structuredContent) }]
              return parts
            },
          }),
        ]),
      )
      const failure = yield* tools.register(registrations).pipe(
        Effect.catchTag("Tool.RegistrationError", (error) => Effect.succeed(error.message)),
        Scope.provide(entry.registrations),
      )
      if (failure !== undefined) return failure
      entry.tools = listed.map((def) => toolInfo(record.name, def))
      return undefined
    })

    const teardown = (entry: Managed) =>
      Scope.close(entry.registrations, Exit.void).pipe(Effect.andThen(Scope.close(entry.scope, Exit.void)))

    const watch = (entry: Managed) => {
      const { client, record } = entry
      client.onclose = () => {
        runFork(
          mutex.withPermit(
            Effect.gen(function* () {
              if (managed.get(record.name) !== entry) return
              managed.delete(record.name)
              statuses.set(record.name, { status: "failed", error: "Connection closed" })
              yield* Effect.logWarning("MCP connection closed", { server: record.name })
              yield* teardown(entry)
              yield* events.publish(McpEvent.ToolsChanged, { server: record.name }).pipe(Effect.ignore)
            }).pipe(Effect.ignore),
          ),
        )
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        runFork(
          mutex.withPermit(
            Effect.gen(function* () {
              if (managed.get(record.name) !== entry) return
              const listed = yield* McpCatalog.listTools(
                client,
                record.config.timeout?.request ?? McpCatalog.DEFAULT_TIMEOUT,
              ).pipe(Effect.orElseSucceed(() => undefined))
              if (!listed || managed.get(record.name) !== entry) return
              yield* Scope.close(entry.registrations, Exit.void)
              entry.registrations = yield* Scope.make()
              const failure = yield* register(entry, listed)
              if (failure !== undefined) {
                if (managed.get(record.name) !== entry) return
                managed.delete(record.name)
                statuses.set(record.name, { status: "failed", error: failure })
                yield* teardown(entry)
                yield* Effect.logWarning("MCP server unavailable", { server: record.name, error: failure })
                return
              }
              yield* events.publish(McpEvent.ToolsChanged, { server: record.name }).pipe(Effect.ignore)
            }),
          ),
        )
      })
    }

    const connect = Effect.fnUntraced(function* (record: ServerRecord) {
      const startup = record.config.timeout?.startup ?? McpCatalog.DEFAULT_TIMEOUT
      const request = record.config.timeout?.request ?? McpCatalog.DEFAULT_TIMEOUT
      let client: Client | undefined
      let failure: string | undefined
      let closedEarly = false
      for (const transport of transports(record.config)) {
        closedEarly = false
        const attempt = createClient()
        attempt.onclose = () => {
          closedEarly = true
        }
        failure = yield* Effect.tryPromise({
          try: () => attempt.connect(transport),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.timeoutOrElse({
            duration: startup,
            orElse: () => Effect.fail(`MCP connection timed out after ${startup}ms`),
          }),
          Effect.match({ onFailure: (message) => message, onSuccess: () => undefined }),
        )
        if (failure === undefined) {
          client = attempt
          break
        }
        yield* Effect.tryPromise(() => transport.close()).pipe(Effect.ignore)
      }
      if (failure !== undefined || !client) {
        if (record.config.type === "remote" && !URL.canParse(record.config.url))
          failure = `Invalid MCP URL for "${record.name}"`
        statuses.set(record.name, { status: "failed", error: failure ?? "Unknown error" })
        yield* Effect.logWarning("MCP server unavailable", { server: record.name, error: failure })
        return failure ?? "Unknown error"
      }
      const scope = yield* Scope.make()
      const entry: Managed = { record, client, scope, registrations: yield* Scope.make(), tools: [] }
      managed.set(record.name, entry)
      yield* Scope.addFinalizer(scope, Effect.tryPromise(() => client.close()).pipe(Effect.ignore))
      watch(entry)
      if (closedEarly) entry.client.onclose?.()
      const listed = yield* (client.getServerCapabilities()?.tools
        ? McpCatalog.listTools(client, request).pipe(Effect.orElseSucceed(() => undefined))
        : Effect.succeed([]))
      const failed = listed === undefined ? "Failed to list tools" : yield* register(entry, listed)
      if (failed !== undefined) {
        managed.delete(record.name)
        statuses.set(record.name, { status: "failed", error: failed })
        yield* teardown(entry)
        yield* Effect.logWarning("MCP server unavailable", { server: record.name, error: failed })
        return failed
      }
      statuses.set(record.name, { status: "connected" })
      return undefined
    })

    const reconcile = (records: readonly ServerRecord[]) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const desired = new Map(records.map((record) => [record.name, record]))
          for (const [name, entry] of Array.from(managed)) {
            const next = desired.get(name)
            if (next && sameConfig(next.config, entry.record.config) && next.authority === entry.record.authority)
              continue
            managed.delete(name)
            yield* teardown(entry)
          }
          for (const name of Array.from(statuses.keys())) if (!desired.has(name)) statuses.delete(name)
          for (const record of desired.values()) {
            if (managed.has(record.name)) continue
            const refused = refusal(record)
            if (refused) {
              if (refused.status === "failed")
                yield* Effect.logWarning("Ignoring MCP server", { server: record.name, error: refused.error })
              statuses.set(record.name, refused)
              continue
            }
            yield* connect(record)
          }
        }),
      )

    const state = State.create<Data, InternalDraft>({
      initial: () => ({ servers: [] }),
      draft: (data) => ({
        server: (name, config, authority = "trusted-global") => {
          const index = data.servers.findIndex((record) => record.name === name)
          const record = { name, config, authority }
          if (index >= 0) data.servers[index] = record
          else data.servers.push(record)
        },
        list: () => data.servers.map((record) => ({ name: record.name, config: record.config })),
        records: () => data.servers,
      }),
      finalize: (draft) => reconcile(draft.records()),
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(managed.values()), teardown, { discard: true }).pipe(
        Effect.ensuring(Effect.sync(() => managed.clear())),
      ),
    )

    const record = (name: string) => state.get().servers.find((record) => record.name === name)

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      status: Effect.fn("McpV2.status")(function* () {
        return Object.fromEntries(statuses)
      }),
      tools: Effect.fn("McpV2.tools")(function* (server) {
        return Array.from(managed.values())
          .filter((entry) => server === undefined || entry.record.name === server)
          .flatMap((entry) => entry.tools)
      }),
      resources: Effect.fn("McpV2.resources")(function* (server) {
        const result: Mcp.ResourceInfo[] = []
        for (const entry of managed.values()) {
          if (server !== undefined && entry.record.name !== server) continue
          const listed = yield* McpCatalog.listResources(
            entry.client,
            entry.record.config.timeout?.request ?? McpCatalog.DEFAULT_TIMEOUT,
          ).pipe(Effect.orElseSucceed(() => []))
          for (const item of listed)
            result.push({
              server: entry.record.name,
              uri: item.uri,
              name: item.name,
              description: item.description,
              mimeType: item.mimeType,
              meta: item._meta as Schema.Json | undefined,
            })
        }
        return result
      }),
      readResource: Effect.fn("McpV2.readResource")(function* (server, uri) {
        const entry = managed.get(server)
        if (!entry) return yield* new NotFoundError({ name: server })
        const result = yield* Effect.tryPromise({
          try: () =>
            entry.client.readResource(
              { uri },
              { timeout: entry.record.config.timeout?.request ?? McpCatalog.DEFAULT_TIMEOUT },
            ),
          catch: (error) => new McpError({ server, operation: "resources/read", cause: error }),
        })
        return { contents: result.contents.map(resourceContent) }
      }),
      callTool: Effect.fn("McpV2.callTool")(function* (server, name, args) {
        const entry = managed.get(server)
        if (!entry) return yield* new NotFoundError({ name: server })
        const result = yield* Effect.tryPromise({
          try: () =>
            entry.client.callTool(
              { name, arguments: (args ?? {}) as Record<string, unknown> },
              CallToolResultSchema,
              {
                resetTimeoutOnProgress: true,
                timeout: entry.record.config.timeout?.request ?? McpCatalog.DEFAULT_TIMEOUT,
                onprogress: () => {},
              },
            ),
          catch: (error) => new McpError({ server, operation: "tools/call", cause: error }),
        })
        return callResult(result)
      }),
      connect: Effect.fn("McpV2.connect")(function* (name) {
        const target = record(name)
        if (!target) return yield* new NotFoundError({ name })
        yield* mutex.withPermit(
          Effect.gen(function* () {
            if (managed.has(name)) return
            const refused = refusal(target)
            if (refused) {
              statuses.set(name, refused)
              const message = refused.status === "disabled" ? `MCP server "${name}" is disabled` : refused.error
              return yield* new McpError({ server: name, operation: "connect", cause: new Error(message) })
            }
            const failed = yield* connect(target)
            if (failed !== undefined)
              return yield* new McpError({ server: name, operation: "connect", cause: new Error(failed) })
          }),
        )
      }),
      disconnect: Effect.fn("McpV2.disconnect")(function* (name) {
        const target = record(name)
        if (!target) return yield* new NotFoundError({ name })
        yield* mutex.withPermit(Effect.gen(function* () {
          const entry = managed.get(name)
          statuses.delete(name)
          if (!entry) return
          managed.delete(name)
          yield* teardown(entry)
        }))
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, ToolRegistry.toolsNode, PermissionV2.node, EventV2.node],
})
