import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createEmbeddedRoutes } from "../src/routes"

const fixture = path.join(import.meta.dir, "../../core/test/fixture/mcp-server.ts")

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-mcp-")))
const globalConfig = path.join(process.env.XDG_CONFIG_HOME!, "opencode")
await fs.mkdir(globalConfig, { recursive: true })
await fs.writeFile(
  path.join(globalConfig, "opencode.json"),
  JSON.stringify({ mcp: { servers: { test: { type: "local", command: [process.execPath, fixture] } } } }),
)

const { handler, dispose } = HttpRouter.toWebHandler(
  createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
)

afterAll(async () => {
  await dispose()
  await fs.rm(directory, { recursive: true, force: true })
})

function request(pathname: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return handler(new Request(new URL(pathname, "http://localhost"), { ...init, headers }), Context.empty() as never)
}

const data = async (response: Response) => (await response.json().catch(() => ({})))?.data

describe("server.mcp", () => {
  test("status, tool list/call, resource read, connect/disconnect", async () => {
    let status = await data(await request("/api/mcp"))
    for (let i = 0; i < 100 && status.test?.status !== "connected"; i++) {
      await Bun.sleep(50)
      status = await data(await request("/api/mcp"))
    }
    expect(status).toEqual({ test: { status: "connected" } })

    const tools = await request("/api/mcp/tool")
    const toolList = await data(tools)
    const price = toolList.find((tool: { name: string }) => tool.name === "price")
    expect(price.ui).toEqual({ resourceUri: "ui://price/app.html" })
    expect(price.meta).toEqual({ ui: { resourceUri: "ui://price/app.html" } })

    const call = await request("/api/mcp/test/tool/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: { message: "hello" } }),
    })
    expect(call.status).toBe(200)
    expect(await data(call)).toMatchObject({ content: [{ type: "text", text: "hello" }] })

    const missing = await request("/api/mcp/missing/tool/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "McpNotFoundError", server: "missing" })

    const missingResource = await request(`/api/mcp/missing/resource?uri=${encodeURIComponent("ui://x")}`)
    expect(missingResource.status).toBe(404)
    expect(await missingResource.json()).toMatchObject({ _tag: "McpNotFoundError", server: "missing" })

    const missingConnect = await request("/api/mcp/missing/connect", { method: "POST" })
    expect(missingConnect.status).toBe(404)
    expect(await missingConnect.json()).toMatchObject({ _tag: "McpNotFoundError", server: "missing" })

    const resource = await request(`/api/mcp/test/resource?uri=${encodeURIComponent("ui://price/app.html")}`)
    expect(resource.status).toBe(200)
    expect(await data(resource)).toEqual({
      contents: [{ uri: "ui://price/app.html", mimeType: "text/html;profile=mcp-app", text: "<html>hi</html>" }],
    })

    const disconnect = await request("/api/mcp/test/disconnect", { method: "POST" })
    expect(disconnect.status).toBe(204)
    expect(await data(await request("/api/mcp"))).toEqual({})

    const afterDisconnect = await request("/api/mcp/test/tool/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(afterDisconnect.status).toBe(404)

    const reconnect = await request("/api/mcp/test/connect", { method: "POST" })
    expect(reconnect.status).toBe(204)
    expect(await data(await request("/api/mcp"))).toEqual({ test: { status: "connected" } })
  })
})
