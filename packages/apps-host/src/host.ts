import { AppBridge, McpUiResourceMetaSchema } from "@modelcontextprotocol/ext-apps/app-bridge"
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiMessageRequest,
  McpUiMessageResult,
  McpUiOpenLinkRequest,
  McpUiOpenLinkResult,
  McpUiResourceMeta,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import type { CallToolResult, EmptyResult, Implementation, LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js"
import { IframeTransport } from "./transport"
import type { MessageEvents } from "./transport"
import { proxyHtml } from "./proxy"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type Location = {
  readonly directory?: string
  readonly workspaceID?: string
}

export type McpCallToolInput = {
  readonly server: string
  readonly name: string
  readonly arguments?: Record<string, unknown>
  readonly location?: Location
}

export type ResourceContent = {
  readonly uri: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
  readonly meta?: unknown
}

export type ResourceInfo = {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly mimeType?: string
  readonly meta?: unknown
}

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resource"
      readonly resource: ResourceContent
    }

export type ToolResult = {
  readonly content: ReadonlyArray<ToolContent>
  readonly structuredContent?: unknown
  readonly isError?: boolean
  readonly meta?: unknown
}

export type McpCallToolOutput = {
  readonly data?: ToolResult
}

export type McpListResourcesOutput = {
  readonly data?: ReadonlyArray<ResourceInfo>
}

export type McpReadResourceOutput = {
  readonly data?: {
    readonly contents: ReadonlyArray<ResourceContent>
  }
}

export type AppsGetOutput = {
  readonly data?: {
    readonly manifest: { readonly id: string; readonly web?: { readonly entry?: string } }
    readonly hasWeb?: boolean
    readonly mcpServer?: string
  }
}

export interface Client {
  mcp: {
    callTool(input: McpCallToolInput): Promise<McpCallToolOutput>
    listResources(input?: { server?: string; location?: Location }): Promise<McpListResourcesOutput>
    readResource(input: { server: string; uri: string; location?: Location }): Promise<McpReadResourceOutput>
  }
  apps?: {
    get(input: { id: string; location?: Location }): Promise<AppsGetOutput>
    createTicket(input: { id: string; location?: Location }): Promise<{
      data: { ticket: string; expires_in: number }
    }>
  }
}

export interface HostHooks {
  onLog?: (params: LoggingMessageNotification["params"]) => void
  onMessage?: (params: McpUiMessageRequest["params"]) => Promise<McpUiMessageResult> | McpUiMessageResult
  onOpenLink?: (params: McpUiOpenLinkRequest["params"]) => Promise<McpUiOpenLinkResult> | McpUiOpenLinkResult
  onUpdateModelContext?: (params: McpUiUpdateModelContextRequest["params"]) => Promise<EmptyResult> | EmptyResult
  onResize?: (params: { width?: number; height?: number }) => void
  onInitialized?: () => void
  onTeardownRequest?: () => void
}

interface HostOptions {
  sdk: Client
  location?: Location
  hostInfo?: Implementation
  hostContext?: McpUiHostContext
  hooks?: HostHooks
  events?: MessageEvents
  readyTimeout?: number
}

export interface AppView {
  readonly iframe: HTMLIFrameElement
  readonly ready: Promise<void>
  readonly appInfo: () => Implementation | undefined
  readonly sendToolInput: (args: Record<string, unknown>) => Promise<void>
  readonly sendToolResult: (result: ToolResult) => Promise<void>
  readonly sendHostContext: (context: McpUiHostContext) => void
  readonly close: () => Promise<void>
}

export interface PortalInput extends HostOptions {
  iframe: HTMLIFrameElement
  id: string
  baseUrl?: string
  server?: string
  sandbox?: string
}

export interface InlineInput extends HostOptions {
  iframe: HTMLIFrameElement
  server: string
  resourceUri: string
  tool?: {
    arguments?: Record<string, unknown>
    result?: ToolResult
  }
  proxy?: {
    url?: string
    sandbox?: string
  }
}

export async function portal(input: PortalInput): Promise<AppView> {
  const apps = input.sdk.apps
  if (!apps) throw new Error("sdk.apps is required for AppHost.portal")
  const [info, ticket] = await Promise.all([
    apps.get({ id: input.id, location: input.location }),
    apps.createTicket({ id: input.id, location: input.location }),
  ])
  const base = input.baseUrl ?? globalThis.location?.origin
  if (!base) throw new Error("baseUrl is required when window.location is unavailable")
  const url = new URL(`/api/app/${encodeURIComponent(input.id)}/web/?ticket=${encodeURIComponent(ticket.data.ticket)}`, base)
  const view = attach(input.iframe, input, hostBridge(input, input.server ?? info.data?.mcpServer ?? input.id), "null")
  input.iframe.setAttribute("sandbox", input.sandbox ?? "allow-scripts allow-forms")
  input.iframe.src = url.toString()
  return view
}

export async function inline(input: InlineInput): Promise<AppView> {
  const resource = (
    await input.sdk.mcp.readResource({ server: input.server, uri: input.resourceUri, location: input.location })
  ).data
  const content = resource?.contents.find((item) => typeof item.text === "string")
  if (!content?.text) throw new Error(`resource ${input.resourceUri} has no text content`)
  const html = content.text
  const meta = uiMeta(content.meta)
  const proxy = input.proxy?.url
    ? new URL(input.proxy.url, globalThis.location?.origin ?? undefined)
    : undefined
  if (proxy && proxy.origin === globalThis.location?.origin) throw new Error("proxy url must be cross-origin")
  const bridge = hostBridge(input, input.server)
  bridge.addEventListener("sandboxready", () => {
    void bridge.sendSandboxResourceReady({
      html,
      sandbox: input.proxy?.sandbox,
      csp: meta?.csp,
      permissions: meta?.permissions,
    })
  })
  const tool = input.tool
  if (tool) {
    bridge.addEventListener("initialized", () => {
      void bridge.sendToolInput({ arguments: tool.arguments ?? {} })
      if (tool.result) void bridge.sendToolResult(callResult(tool.result))
    })
  }
  const view = attach(input.iframe, input, bridge, proxy ? proxy.origin : "null")
  if (proxy) {
    proxy.searchParams.set("host", globalThis.location?.origin ?? "")
    input.iframe.setAttribute("sandbox", "allow-scripts allow-same-origin")
    input.iframe.src = proxy.toString()
    return view
  }
  input.iframe.setAttribute("sandbox", "allow-scripts")
  input.iframe.srcdoc = proxyHtml(globalThis.location?.origin)
  return view
}

function attach(iframe: HTMLIFrameElement, options: HostOptions, bridge: AppBridge, origin: string): AppView {
  const source = iframe.contentWindow
  if (!source) throw new Error("iframe.contentWindow is unavailable")
  const transport = new IframeTransport({
    target: source,
    source,
    origin,
    events: options.events,
  })
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timeout = options.readyTimeout ?? 30_000
  const timer = setTimeout(() => rejectReady(new Error(`app view did not initialize within ${timeout}ms`)), timeout)
  if (typeof timer === "object") timer.unref()
  bridge.addEventListener("initialized", () => {
    clearTimeout(timer)
    options.hooks?.onInitialized?.()
    resolveReady()
  })
  let closed = false
  const view: AppView = {
    iframe,
    ready,
    appInfo: () => bridge.getAppVersion(),
    sendToolInput: (args) => bridge.sendToolInput({ arguments: args }),
    sendToolResult: (result) => bridge.sendToolResult(callResult(result)),
    sendHostContext: (context) => bridge.setHostContext(context),
    close: async () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      try {
        await bridge.teardownResource({}, { timeout: 1000 })
      } catch {}
      await bridge.close()
    },
  }
  void bridge.connect(transport).catch(rejectReady)
  return view
}

function hostBridge(options: HostOptions, server: string): AppBridge {
  const hooks = options.hooks
  const capabilities: McpUiHostCapabilities = {
    serverTools: {},
    serverResources: {},
    logging: {},
  }
  if (hooks?.onOpenLink) capabilities.openLinks = {}
  if (hooks?.onMessage)
    capabilities.message = { text: {}, image: {}, audio: {}, resource: {}, resourceLink: {}, structuredContent: {} }
  if (hooks?.onUpdateModelContext)
    capabilities.updateModelContext = { text: {}, image: {}, audio: {}, resource: {}, resourceLink: {}, structuredContent: {} }
  const bridge = new AppBridge(null, options.hostInfo ?? { name: "opencode-apps-host", version: "0.0.0" }, capabilities, {
    hostContext: { displayMode: "inline", ...options.hostContext },
  })
  bridge.oncalltool = async (params) =>
    callResult(
      (
        await options.sdk.mcp.callTool({
          server,
          name: params.name,
          arguments: record(params.arguments),
          location: options.location,
        })
      ).data,
    )
  bridge.onreadresource = async (params) => ({
    contents: ((await options.sdk.mcp.readResource({ server, uri: params.uri, location: options.location })).data?.contents ?? []).map(
      resourceContent,
    ),
  })
  bridge.onlistresources = async () => ({
    resources: ((await options.sdk.mcp.listResources({ server, location: options.location })).data ?? []).map((item) => ({
      uri: item.uri,
      name: item.name ?? item.uri,
      description: item.description,
      mimeType: item.mimeType,
      _meta: record(item.meta),
    })),
  })
  bridge.onlistresourcetemplates = async () => ({ resourceTemplates: [] })
  bridge.onlistprompts = async () => ({ prompts: [] })
  const onOpenLink = hooks?.onOpenLink
  bridge.onopenlink = onOpenLink ? (params) => Promise.resolve(onOpenLink(params)) : async () => ({ isError: true })
  const onMessage = hooks?.onMessage
  bridge.onmessage = onMessage ? (params) => Promise.resolve(onMessage(params)) : async () => ({ isError: true })
  const onUpdateModelContext = hooks?.onUpdateModelContext
  bridge.onupdatemodelcontext = onUpdateModelContext
    ? (params) => Promise.resolve(onUpdateModelContext(params))
    : async () => ({})
  bridge.addEventListener("loggingmessage", (params) => hooks?.onLog?.(params))
  bridge.addEventListener("sizechange", (params) => hooks?.onResize?.(params))
  bridge.addEventListener("requestteardown", () => hooks?.onTeardownRequest?.())
  return bridge
}

function uiMeta(meta: unknown): McpUiResourceMeta | undefined {
  const ui = record(meta)?.["ui"]
  if (ui === undefined) return undefined
  const parsed = McpUiResourceMetaSchema.safeParse(ui)
  return parsed.success ? parsed.data : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

function resourceContent(item: ResourceContent) {
  const base = { uri: item.uri, mimeType: item.mimeType, _meta: record(item.meta) }
  if (item.text !== undefined) return { ...base, text: item.text }
  return { ...base, blob: item.blob ?? "" }
}

function callResult(result: ToolResult | undefined): CallToolResult {
  return {
    content: (result?.content ?? []).map((item) => {
      if (item.type === "resource") {
        const resource = {
          uri: item.resource.uri,
          mimeType: item.resource.mimeType,
          _meta: record(item.resource.meta),
        }
        return {
          type: "resource" as const,
          resource:
            item.resource.text !== undefined
              ? { ...resource, text: item.resource.text }
              : { ...resource, blob: item.resource.blob ?? "" },
        }
      }
      return item
    }),
    structuredContent: record(result?.structuredContent),
    isError: result?.isError,
    _meta: record(result?.meta),
  }
}
