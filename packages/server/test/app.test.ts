import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createEmbeddedRoutes, createRoutes } from "../src/routes"

const mcpFixture = path.join(import.meta.dir, "../../core/test/fixture/mcp-server.ts")

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-app-")))
const calcDir = path.join(directory, "calc")
await fs.mkdir(path.join(calcDir, "web"), { recursive: true })
await fs.writeFile(path.join(calcDir, "web/index.html"), "<html>app</html>")
await fs.writeFile(path.join(calcDir, "web/asset.0123456789ab.js"), "console.log(1)")
await fs.writeFile(
  path.join(calcDir, "app.json"),
  JSON.stringify({
    id: "app_calc",
    name: "Calculator",
    version: "1.0.0",
    mcp: { type: "local", command: [process.execPath, mcpFixture] },
    web: { root: "web" },
  }),
)

const betaDir = path.join(directory, "beta")
await fs.mkdir(path.join(betaDir, "web"), { recursive: true })
await fs.writeFile(path.join(betaDir, "web/index.html"), "<html>beta</html>")
await fs.writeFile(
  path.join(betaDir, "app.json"),
  JSON.stringify({ id: "app_beta", name: "Beta", version: "1.0.0", web: { root: "web" } }),
)

const globalConfig = path.join(process.env.XDG_CONFIG_HOME!, "opencode")
await fs.mkdir(globalConfig, { recursive: true })
await fs.writeFile(path.join(globalConfig, "opencode.json"), JSON.stringify({ apps: [calcDir, betaDir] }))

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

function bare(pathname: string, init?: RequestInit, target = handler) {
  return target(new Request(new URL(pathname, "http://localhost"), init), Context.empty() as never)
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

const basic = `Basic ${Buffer.from("opencode:secret").toString("base64")}`

describe("server.app", () => {
  test("list, ticket exchange, cookie assets, traversal, cache headers", async () => {
    const list = await poll("/api/app", (body) => Array.isArray(body) && body.length === 2)
    const calc = list.find((app: { manifest: { id: string } }) => app.manifest.id === "app_calc")
    expect(calc).toEqual(
      expect.objectContaining({
        directory: calcDir,
        mcpServer: "app_calc",
        hasWeb: true,
        status: { status: "active" },
      }),
    )
    expect(list.find((app: { manifest: { id: string } }) => app.manifest.id === "app_beta")).toEqual(
      expect.objectContaining({ directory: betaDir, hasWeb: true, status: { status: "active" } }),
    )

    const ticketResponse = await request("/api/app/app_calc/ticket", { method: "POST" })
    expect(ticketResponse.status).toBe(200)
    const { ticket } = await data(ticketResponse)
    expect(typeof ticket).toBe("string")

    const exchange = await bare(`/api/app/app_calc/web/?ticket=${ticket}`)
    expect(exchange.status).toBe(302)
    expect(exchange.headers.get("cache-control")).toBe("no-store")
    const cookie = exchange.headers.get("set-cookie")!
    expect(cookie).toContain("opencode_app_app_calc=")
    expect(cookie).toContain("Path=/api/app/app_calc/")
    expect(cookie.toLowerCase()).toContain("httponly")
    expect(cookie).toContain("SameSite=Lax")
    const pair = cookie.split(";")[0]

    const page = await bare("/api/app/app_calc/web/", { headers: { cookie: pair } })
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    const csp = page.headers.get("content-security-policy")!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(page.headers.get("cache-control")).toBe("no-cache")
    expect(await page.text()).toBe("<html>app</html>")

    const hashed = await bare("/api/app/app_calc/web/asset.0123456789ab.js", {
      headers: { cookie: pair },
    })
    expect(hashed.status).toBe(200)
    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

    const replay = await bare(`/api/app/app_calc/web/?ticket=${ticket}`)
    expect(replay.status).toBe(401)

    const staleWithCookie = await bare(`/api/app/app_calc/web/?ticket=${ticket}`, {
      headers: { cookie: pair },
    })
    expect(staleWithCookie.status).toBe(200)

    const anonymous = await bare("/api/app/app_calc/web/")
    expect(anonymous.status).toBe(401)

    const traversal = await bare("/api/app/app_calc/web/%2e%2e/app.json", { headers: { cookie: pair } })
    expect(traversal.status).toBe(404)

    const denied = await request("/api/skill", { headers: { cookie: pair } }, authedHandler)
    expect(denied.status).toBe(401)
  }, 30_000)

  test("ticket exchange binds scope to the issuing app", async () => {
    const betaTicket = await data(await request("/api/app/app_beta/ticket", { method: "POST" }))
    const wrongApp = await bare(`/api/app/app_calc/web/?ticket=${betaTicket.ticket}`)
    expect(wrongApp.status).toBe(401)

    const exchange = await bare(
      `/api/app/app_beta/web/?ticket=${(await data(await request("/api/app/app_beta/ticket", { method: "POST" }))).ticket}`,
    )
    expect(exchange.status).toBe(302)
    const pair = exchange.headers.get("set-cookie")!.split(";")[0]
    expect(pair).toContain("opencode_app_app_beta=")

    const betaPage = await bare("/api/app/app_beta/web/", { headers: { cookie: pair } })
    expect(betaPage.status).toBe(200)
    expect(await betaPage.text()).toBe("<html>beta</html>")

    const foreign = await bare("/api/app/app_calc/web/", { headers: { cookie: pair } })
    expect(foreign.status).toBe(401)
  }, 30_000)

  test("app.ticket rejects unknown apps and cross-origin requests", async () => {
    const missing = await request("/api/app/app_missing/ticket", { method: "POST" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "AppNotFoundError", id: "app_missing" })

    const forged = await request("/api/app/app_calc/ticket", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    })
    expect(forged.status).toBe(403)
    expect(await forged.json()).toMatchObject({ _tag: "ForbiddenError" })
  }, 30_000)

  test("asset requests honor server auth credentials without ticket or cookie", async () => {
    const denied = await bare("/api/app/app_calc/web/", {}, authedHandler)
    expect(denied.status).toBe(401)

    const authed = await bare(
      "/api/app/app_calc/web/",
      { headers: { authorization: basic } },
      authedHandler,
    )
    expect(authed.status).toBe(200)
    expect(await authed.text()).toBe("<html>app</html>")

    let ticket: string | undefined
    for (let i = 0; i < 100; i++) {
      const minted = await data(
        await bare(
          "/api/app/app_calc/ticket",
          { method: "POST", headers: { authorization: basic, "x-opencode-directory": directory } },
          authedHandler,
        ),
      )
      if (minted?.ticket) {
        ticket = minted.ticket
        break
      }
      await Bun.sleep(50)
    }
    expect(typeof ticket).toBe("string")
    const exchange = await bare(`/api/app/app_calc/web/?ticket=${ticket}`, {}, authedHandler)
    expect(exchange.status).toBe(302)

    const forged = await bare(`/api/app/app_calc/web/?ticket=not-a-ticket`, {}, authedHandler)
    expect(forged.status).toBe(401)
  }, 30_000)
})
