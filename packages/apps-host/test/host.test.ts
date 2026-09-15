import { describe, expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import type { McpCallToolInput, McpCallToolOutput, McpReadResourceInput, McpReadResourceOutput } from "@opencode-ai/client"
import { AppHost, contentSecurityPolicy, proxyHtml } from "../src/index"
import type { Client } from "../src/index"

function generatedClient(): Client {
  return OpenCode.make({ baseUrl: "http://localhost" })
}

test("generated client type-checks against the AppHost sdk contract", () => {
  expect(typeof generatedClient().mcp.callTool).toBe("function")
})

const PROTOCOL_VERSION = "2026-01-26"

interface Posted {
  message: { jsonrpc?: string; id?: number | string; method?: string; result?: unknown; params?: Record<string, unknown> }
  origin: string
}

function fakeWindow() {
  const posted: Posted[] = []
  return {
    posted,
    postMessage(message: Posted["message"], targetOrigin: string) {
      posted.push({ message, origin: targetOrigin })
    },
  }
}

type FakeWindow = ReturnType<typeof fakeWindow>

function fakeIframe(win: FakeWindow) {
  const attributes = new Map<string, string>()
  const iframe = {
    contentWindow: win,
    src: "",
    srcdoc: "",
    setAttribute(name: string, value: string) {
      attributes.set(name, value)
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null
    },
    attributes,
  }
  return iframe as unknown as HTMLIFrameElement
}

function emit(events: EventTarget, source: object, origin: string, data: unknown) {
  const event = new MessageEvent("message", { data, origin })
  Object.defineProperty(event, "source", { value: source })
  events.dispatchEvent(event)
}

function initialize(events: EventTarget, win: FakeWindow, origin: string, id = 1) {
  emit(events, win, origin, {
    jsonrpc: "2.0",
    id,
    method: "ui/initialize",
    params: {
      appInfo: { name: "test-view", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    },
  })
  emit(events, win, origin, { jsonrpc: "2.0", method: "ui/notifications/initialized" })
}

function lastRequest(posted: Posted[], method: string) {
  return posted.findLast((item) => item.message.method === method && item.message.id !== undefined)
}

function respondTeardown(events: EventTarget, win: FakeWindow, origin: string) {
  const teardown = lastRequest(win.posted, "ui/resource-teardown")
  if (teardown?.message.id !== undefined) {
    emit(events, win, origin, { jsonrpc: "2.0", id: teardown.message.id, result: {} })
  }
}

const locationOut = { directory: "/repo", project: { id: "proj_1", directory: "/repo" } }

function sdk(input?: {
  callTool?: (args: McpCallToolInput) => Promise<McpCallToolOutput>
  readResource?: (args: McpReadResourceInput) => Promise<McpReadResourceOutput>
}) {
  const calls: McpCallToolInput[] = []
  const reads: McpReadResourceInput[] = []
  const client: Client = {
    mcp: {
      callTool: async (args) => {
        calls.push(args)
        return (await input?.callTool?.(args)) ?? {
          location: locationOut,
          data: {
            content: [{ type: "text", text: "42" }],
            structuredContent: { value: 42 },
            isError: false,
            meta: { trace: "abc" },
          },
        }
      },
      listResources: async () => ({ location: locationOut, data: [] }),
      readResource: async (args) => {
        reads.push(args)
        return (await input?.readResource?.(args)) ?? {
          location: locationOut,
          data: {
            contents: [
              {
                uri: args.uri,
                mimeType: "text/html;profile=mcp-app",
                text: "<html><body>widget</body></html>",
                meta: { ui: { csp: { connectDomains: ["https://api.example.com"] }, permissions: { clipboardWrite: {} } } },
              },
            ],
          },
        }
      },
    },
    apps: {
      get: async () => ({
        location: locationOut,
        data: {
          manifest: { id: "app_calc", name: "Calculator", version: "1.0.0" },
          directory: "/apps/calc",
          mcpServer: "app_calc",
          hasWeb: true,
          status: { status: "active" },
        },
      }),
      createTicket: async () => ({ location: locationOut, data: { ticket: "ticket-1", expires_in: 60 } }),
    },
  }
  return { client, calls, reads }
}

describe("AppHost.portal", () => {
  test("sets iframe src to the ticketed portal URL", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.portal({ iframe, sdk: client, id: "app_calc", baseUrl: "https://oc.example.com", events })
    expect(iframe.src).toBe("https://oc.example.com/api/app/app_calc/web/?ticket=ticket-1")
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("advertises serverTools, serverResources and logging capabilities without openLinks", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.portal({ iframe, sdk: client, id: "app_calc", baseUrl: "https://oc.example.com", events })
    emit(events, win, "null", {
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        appInfo: { name: "test-view", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = win.posted.find((item) => item.message.id === 1)
    const result = response?.message.result as {
      protocolVersion: string
      hostInfo: { name: string }
      hostCapabilities: Record<string, unknown>
      hostContext: Record<string, unknown>
    }
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(result.hostInfo.name).toBe("opencode-apps-host")
    expect(result.hostCapabilities).toHaveProperty("serverTools")
    expect(result.hostCapabilities).toHaveProperty("serverResources")
    expect(result.hostCapabilities).toHaveProperty("logging")
    expect(result.hostCapabilities).not.toHaveProperty("openLinks")
    expect(result.hostContext.displayMode).toBe("inline")
    emit(events, win, "null", { jsonrpc: "2.0", method: "ui/notifications/initialized" })
    await view.ready
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("advertises openLinks, message and updateModelContext when hooks are provided and routes ui/open-link", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const links: string[] = []
    const view = await AppHost.portal({
      iframe,
      sdk: client,
      id: "app_calc",
      baseUrl: "https://oc.example.com",
      events,
      hooks: {
        onOpenLink: (params) => {
          links.push(params.url)
          return {}
        },
        onMessage: () => ({}),
        onUpdateModelContext: () => ({}),
      },
    })
    emit(events, win, "null", {
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        appInfo: { name: "test-view", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = win.posted.find((item) => item.message.id === 1)
    const result = response?.message.result as { hostCapabilities: Record<string, unknown> }
    expect(result.hostCapabilities).toHaveProperty("openLinks")
    expect(result.hostCapabilities).toHaveProperty("message")
    expect(result.hostCapabilities).toHaveProperty("updateModelContext")
    emit(events, win, "null", { jsonrpc: "2.0", method: "ui/notifications/initialized" })
    await view.ready
    emit(events, win, "null", {
      jsonrpc: "2.0",
      id: 3,
      method: "ui/open-link",
      params: { url: "https://example.com/docs" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(links).toEqual(["https://example.com/docs"])
    const answer = win.posted.find((item) => item.message.id === 3)
    expect(answer?.message.result).toEqual({})
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("forwards tools/call to sdk.mcp.callTool and returns content, structuredContent, isError and _meta", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, calls } = sdk()
    const location = { directory: "/repo" }
    const view = await AppHost.portal({
      iframe,
      sdk: client,
      id: "app_calc",
      baseUrl: "https://oc.example.com",
      location,
      events,
    })
    initialize(events, win, "null")
    await view.ready
    emit(events, win, "null", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "calc_eval", arguments: { expr: "6*7" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([{ server: "app_calc", name: "calc_eval", arguments: { expr: "6*7" }, location }])
    const response = win.posted.find((item) => item.message.id === 7)
    expect(response?.origin).toBe("*")
    expect(response?.message.result).toEqual({
      content: [{ type: "text", text: "42" }],
      structuredContent: { value: 42 },
      isError: false,
      _meta: { trace: "abc" },
    })
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("forwards resources/read to sdk.mcp.readResource preserving uri and meta", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, reads } = sdk()
    const location = { directory: "/repo" }
    const view = await AppHost.portal({
      iframe,
      sdk: client,
      id: "app_calc",
      baseUrl: "https://oc.example.com",
      location,
      events,
    })
    initialize(events, win, "null")
    await view.ready
    emit(events, win, "null", {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/read",
      params: { uri: "ui://app_calc/view.html" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toEqual([{ server: "app_calc", uri: "ui://app_calc/view.html", location }])
    const response = win.posted.find((item) => item.message.id === 9)
    expect(response?.message.result).toEqual({
      contents: [
        {
          uri: "ui://app_calc/view.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<html><body>widget</body></html>",
          _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] }, permissions: { clipboardWrite: {} } } },
        },
      ],
    })
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("ignores messages from a different window source", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const other = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, calls } = sdk()
    const view = await AppHost.portal({ iframe, sdk: client, id: "app_calc", baseUrl: "https://oc.example.com", events })
    initialize(events, win, "null")
    await view.ready
    emit(events, other, "null", {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "calc_eval", arguments: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(0)
    expect(win.posted.find((item) => item.message.id === 11)).toBeUndefined()
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("ignores messages from an unexpected origin", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, calls } = sdk()
    const view = await AppHost.portal({ iframe, sdk: client, id: "app_calc", baseUrl: "https://oc.example.com", events })
    initialize(events, win, "null")
    await view.ready
    emit(events, win, "https://evil.example.com", {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "calc_eval", arguments: {} },
    })
    emit(events, win, "https://oc.example.com", {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "calc_eval", arguments: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(0)
    expect(win.posted.find((item) => item.message.id === 13)).toBeUndefined()
    expect(win.posted.find((item) => item.message.id === 14)).toBeUndefined()
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("rejects view.ready when the view never initializes", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.portal({
      iframe,
      sdk: client,
      id: "app_calc",
      baseUrl: "https://oc.example.com",
      readyTimeout: 20,
      events,
    })
    await expect(view.ready).rejects.toThrow("did not initialize")
    await view.close()
  })

  test("close stops forwarding view requests", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, calls } = sdk()
    const view = await AppHost.portal({ iframe, sdk: client, id: "app_calc", baseUrl: "https://oc.example.com", events })
    initialize(events, win, "null")
    await view.ready
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
    emit(events, win, "null", {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "calc_eval", arguments: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(0)
    expect(win.posted.find((item) => item.message.id === 15)).toBeUndefined()
  })

  test("sendHostContext forwards a host-context-changed notification", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.portal({ iframe, sdk: client, id: "app_calc", baseUrl: "https://oc.example.com", events })
    initialize(events, win, "null")
    await view.ready
    view.sendHostContext({ theme: "dark" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const notification = win.posted.findLast((item) => item.message.method === "ui/notifications/host-context-changed")
    expect(notification?.message.params).toEqual({ theme: "dark" })
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })
})

describe("AppHost.inline", () => {
  test("reads the ui resource, sandboxes the iframe and answers sandbox-resource-ready with the html and ui meta", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, reads } = sdk()
    const view = await AppHost.inline({ iframe, sdk: client, server: "srv", resourceUri: "ui://srv/view.html", events })
    expect(reads).toEqual([{ server: "srv", uri: "ui://srv/view.html", location: undefined }])
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.srcdoc).toContain("ui/notifications/sandbox-proxy-ready")
    emit(events, win, "null", { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ready = win.posted.find((item) => item.message.method === "ui/notifications/sandbox-resource-ready")
    expect(ready?.origin).toBe("*")
    expect(ready?.message.params).toEqual({
      html: "<html><body>widget</body></html>",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { clipboardWrite: {} },
    })
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("sends tool input and tool result after the view initializes", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.inline({
      iframe,
      sdk: client,
      server: "srv",
      resourceUri: "ui://srv/view.html",
      tool: {
        arguments: { expr: "1+1" },
        result: { content: [{ type: "text", text: "2" }], structuredContent: { value: 2 }, meta: { t: 1 } },
      },
      events,
    })
    initialize(events, win, "null")
    await view.ready
    await new Promise((resolve) => setTimeout(resolve, 0))
    const toolInput = win.posted.find((item) => item.message.method === "ui/notifications/tool-input")
    expect(toolInput?.message.params).toEqual({ arguments: { expr: "1+1" } })
    const toolResult = win.posted.find((item) => item.message.method === "ui/notifications/tool-result")
    expect(toolResult?.message.params).toEqual({
      content: [{ type: "text", text: "2" }],
      structuredContent: { value: 2 },
      _meta: { t: 1 },
    })
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("sends an empty tool input before a tool result without arguments", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.inline({
      iframe,
      sdk: client,
      server: "srv",
      resourceUri: "ui://srv/view.html",
      tool: { result: { content: [{ type: "text", text: "2" }] } },
      events,
    })
    initialize(events, win, "null")
    await view.ready
    await new Promise((resolve) => setTimeout(resolve, 0))
    const toolInput = win.posted.find((item) => item.message.method === "ui/notifications/tool-input")
    expect(toolInput?.message.params).toEqual({ arguments: {} })
    expect(
      win.posted.find((item) => item.message.method === "ui/notifications/tool-result")?.message.params,
    ).toMatchObject({ content: [{ type: "text", text: "2" }] })
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("rejects inline resources without text content", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk({
      readResource: async () => ({ location: locationOut, data: { contents: [{ uri: "ui://srv/blob", blob: "AAAA" }] } }),
    })
    await expect(AppHost.inline({ iframe, sdk: client, server: "srv", resourceUri: "ui://srv/blob", events })).rejects.toThrow(
      "has no text content",
    )
  })

  test("ignores messages that do not arrive from the sandbox proxy origin", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client, calls } = sdk()
    const view = await AppHost.inline({ iframe, sdk: client, server: "srv", resourceUri: "ui://srv/view.html", events })
    initialize(events, win, "https://oc.example.com")
    emit(events, win, "https://oc.example.com", {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "x", arguments: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(0)
    expect(win.posted.find((item) => item.message.id === 21)).toBeUndefined()
    const closing = view.close()
    respondTeardown(events, win, "null")
    await closing
  })

  test("rejects a same-origin proxy url", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://oc.example.com" },
      configurable: true,
      writable: true,
    })
    try {
      await expect(
        AppHost.inline({
          iframe,
          sdk: client,
          server: "srv",
          resourceUri: "ui://srv/view.html",
          proxy: { url: "https://oc.example.com/proxy" },
          events,
        }),
      ).rejects.toThrow("cross-origin")
    } finally {
      if (previous) Object.defineProperty(globalThis, "location", previous)
      else Reflect.deleteProperty(globalThis, "location")
    }
  })

  test("points the outer iframe at a cross-origin proxy url with the host param", async () => {
    const events = new EventTarget()
    const win = fakeWindow()
    const iframe = fakeIframe(win)
    const { client } = sdk()
    const view = await AppHost.inline({
      iframe,
      sdk: client,
      server: "srv",
      resourceUri: "ui://srv/view.html",
      proxy: { url: "https://proxy.example/sandbox" },
      events,
    })
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin")
    expect(iframe.src).toBe("https://proxy.example/sandbox?host=")
    emit(events, win, "https://proxy.example", {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
      params: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ready = win.posted.find((item) => item.message.method === "ui/notifications/sandbox-resource-ready")
    expect(ready?.origin).toBe("https://proxy.example")
    const closing = view.close()
    respondTeardown(events, win, "https://proxy.example")
    await closing
  })
})

describe("contentSecurityPolicy", () => {
  test("emits restrictive defaults when csp is undefined", () => {
    const value = contentSecurityPolicy(undefined)
    expect(value).toContain("default-src 'none'")
    expect(value).toContain("connect-src 'none'")
    expect(value).toContain("font-src 'none'")
    expect(value).toContain("media-src 'none'")
    expect(value).toContain("frame-src 'none'")
    expect(value).toContain("form-action 'none'")
  })

  test("merges declared domains and strips control characters", () => {
    const value = contentSecurityPolicy({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://evil.example.com';script-src *"],
    })
    expect(value).toContain("connect-src https://api.example.com")
    expect(value).toContain("img-src data: blob: https://cdn.example.com")
    expect(value).toContain("frame-src https://evil.example.comscript-src*")
    expect(value).toContain("form-action 'none'")
  })
})

function proxyHarness(input?: { hostOrigin?: string; href?: string }) {
  const parentPosted: Posted[] = []
  const innerPosted: { data: unknown; origin: string }[] = []
  const listeners: ((event: { source: unknown; origin: string; data: unknown }) => void)[] = []
  const parent = {
    postMessage(data: Posted["message"], origin: string) {
      parentPosted.push({ message: data, origin })
    },
  }
  const inner = {
    attrs: new Map<string, string>(),
    srcdoc: "",
    contentDocument: undefined,
    contentWindow: {
      document: undefined,
      postMessage(data: unknown, origin: string) {
        innerPosted.push({ data, origin })
      },
    },
    setAttribute(name: string, value: string) {
      inner.attrs.set(name, value)
    },
  }
  const windowObject = {
    self: {},
    top: {},
    parent,
    location: { href: input?.href ?? "https://proxy.example/" },
    addEventListener(_type: string, listener: (event: { source: unknown; origin: string; data: unknown }) => void) {
      listeners.push(listener)
    },
  }
  const documentObject = {
    createElement: () => inner,
    body: { appendChild: () => {} },
  }
  const script = proxyHtml(input?.hostOrigin).match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ""
  new Function("window", "document", script)(windowObject, documentObject)
  return {
    parentPosted,
    innerPosted,
    inner,
    parent,
    emit(source: unknown, origin: string, data: unknown) {
      for (const listener of listeners) listener({ source, origin, data })
    },
  }
}

describe("proxyHtml", () => {
  test("does not relay forged sandbox notifications from the inner window to the parent", () => {
    const harness = proxyHarness({ href: "https://proxy.example/?host=https://oc.example.com" })
    expect(harness.parentPosted).toEqual([
      { message: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, origin: "https://oc.example.com" },
    ])
    harness.emit(harness.inner.contentWindow, "https://proxy.example", {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-proxy-ready",
      params: {},
    })
    expect(harness.parentPosted).toHaveLength(1)
    harness.emit(harness.inner.contentWindow, "https://proxy.example", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "x", arguments: {} },
    })
    expect(harness.parentPosted).toHaveLength(2)
    expect(harness.parentPosted[1]?.origin).toBe("https://oc.example.com")
  })

  test("drops messages from the parent whose origin does not match the baked host origin", () => {
    const harness = proxyHarness({ hostOrigin: "https://oc.example.com" })
    harness.emit(harness.parent, "https://evil.example.com", {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>x</p>" },
    })
    expect(harness.inner.srcdoc).toBe("")
    harness.emit(harness.parent, "https://oc.example.com", {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>x</p>", permissions: { clipboardWrite: false, camera: {} } },
    })
    expect(harness.inner.srcdoc).toContain("default-src 'none'")
    expect(harness.inner.srcdoc).toContain("connect-src 'none'")
    expect(harness.inner.srcdoc).toContain("form-action 'none'")
    expect(harness.inner.srcdoc).toContain("<p>x</p>")
    expect(harness.inner.attrs.get("allow")).toBe("camera")
  })

  test("drops parent messages when no host origin is established", () => {
    const harness = proxyHarness({ hostOrigin: "", href: "https://proxy.example/" })
    harness.emit(harness.parent, "https://oc.example.com", {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>x</p>" },
    })
    expect(harness.inner.srcdoc).toBe("")
    expect(harness.innerPosted).toHaveLength(0)
  })

  test("does not grant allow tokens for false or missing permissions", () => {
    const harness = proxyHarness({ hostOrigin: "https://oc.example.com" })
    harness.emit(harness.parent, "https://oc.example.com", {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<p>x</p>", permissions: { clipboardWrite: false } },
    })
    expect(harness.inner.attrs.get("allow")).toBeUndefined()
  })
})
