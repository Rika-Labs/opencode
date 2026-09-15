import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createEmbeddedRoutes, createRoutes } from "../src/routes"

const mcpFixture = path.join(import.meta.dir, "../../core/test/fixture/mcp-server.ts")

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-app-")))
const appDir = path.join(directory, "calc")
await fs.mkdir(path.join(appDir, "web"), { recursive: true })
await fs.writeFile(path.join(appDir, "web/index.html"), "<html>app</html>")
await fs.writeFile(path.join(appDir, "web/asset.0123456789ab.js"), "console.log(1)")
await fs.writeFile(
  path.join(appDir, "app.json"),
  JSON.stringify({
    id: "app_calc",
    name: "Calculator",
    version: "1.0.0",
    mcp: { type: "local", command: [process.execPath, mcpFixture] },
    web: { root: "web" },
  }),
)

const globalConfig = path.join(process.env.XDG_CONFIG_HOME!, "opencode")
await fs.mkdir(globalConfig, { recursive: true })
await fs.writeFile(path.join(globalConfig, "opencode.json"), JSON.stringify({ apps: [appDir] }))

const { handler, dispose } = HttpRouter.toWebHandler(
  createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
)
const { handler: authedHandler, dispose: disposeAuthed } = HttpRouter.toWebHandler(
  createRoutes("secret").pipe(Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
)

afterAll(async () => {
  await dispose()
  await disposeAuthed()
  await fs.rm(directory, { recursive: true, force: true })
})

function request(pathname: string, init?: RequestInit, target = handler) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return target(new Request(new URL(pathname, "http://localhost"), { ...init, headers }), Context.empty() as never)
}

const data = async (response: Response) => (await response.json().catch(() => ({})))?.data

const poll = async (pathname: string, predicate: (body: unknown) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const body = await data(await request(pathname))
    if (predicate(body)) return body
    await Bun.sleep(50)
  }
  return data(await request(pathname))
}

describe("server.app", () => {
  test("list, ticket exchange, cookie assets, traversal, cache headers", async () => {
    const list = await poll("/api/app", (body) => Array.isArray(body) && body.length === 1)
    expect(list).toEqual([
      expect.objectContaining({
        directory: appDir,
        server: "app_calc",
        hasWeb: true,
        status: { status: "active" },
      }),
    ])

    const ticketResponse = await request("/api/app/app_calc/ticket", { method: "POST" })
    expect(ticketResponse.status).toBe(200)
    const { ticket } = await data(ticketResponse)
    expect(typeof ticket).toBe("string")

    const exchange = await request(`/api/app/app_calc/web/?ticket=${ticket}`)
    expect(exchange.status).toBe(302)
    const cookie = exchange.headers.get("set-cookie")!
    expect(cookie).toContain("opencode_app_app_calc=")
    expect(cookie).toContain("Path=/api/app/app_calc/")
    expect(cookie.toLowerCase()).toContain("httponly")
    const pair = cookie.split(";")[0]

    const page = await request("/api/app/app_calc/web/", { headers: { cookie: pair } })
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    const csp = page.headers.get("content-security-policy")!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(page.headers.get("cache-control")).toBe("no-cache")
    expect(await page.text()).toBe("<html>app</html>")

    const hashed = await request("/api/app/app_calc/web/asset.0123456789ab.js", {
      headers: { cookie: pair },
    })
    expect(hashed.status).toBe(200)
    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

    const replay = await request(`/api/app/app_calc/web/?ticket=${ticket}`)
    expect(replay.status).toBe(401)

    const anonymous = await request("/api/app/app_calc/web/")
    expect(anonymous.status).toBe(401)

    const traversal = await request("/api/app/app_calc/web/%2e%2e/app.json", { headers: { cookie: pair } })
    expect(traversal.status).toBe(404)

    const denied = await request("/api/skill", { headers: { cookie: pair } }, authedHandler)
    expect(denied.status).toBe(401)
  }, 30_000)
})
