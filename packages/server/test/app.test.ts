import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

async function writeApp(directory: string, id: string, html: string) {
  await fs.mkdir(path.join(directory, "web"), { recursive: true })
  await fs.writeFile(path.join(directory, "web/index.html"), html)
  await fs.writeFile(
    path.join(directory, "app.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", web: { root: "web" } }),
  )
}

it.live("lists apps and issues portal tickets", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-server-app-")))
    const calcDir = path.join(tmp.path, "apps", "calc")
    const betaDir = path.join(tmp.path, "apps", "beta")
    yield* Effect.promise(() => writeApp(calcDir, "app_calc", "<html>app</html>"))
    yield* Effect.promise(() => writeApp(betaDir, "app_beta", "<html>beta</html>"))
    const server = yield* startServer(tmp.path)
    const headers = server.headers
    const locate = (pathname: string) => {
      const url = new URL(pathname, server.base)
      url.searchParams.set("location[directory]", tmp.path)
      return url
    }
    const request = (pathname: string, init?: RequestInit) =>
      Effect.promise(() => fetch(locate(pathname), { ...init, headers: { ...headers, ...init?.headers } }))
    const body = (response: Response) =>
      Effect.promise(async () => (await response.json().catch(() => ({} as Record<string, never>)))?.data)

    let list: Array<{ manifest: { id: string }; directory: string; hasWeb: boolean }> = []
    for (let i = 0; i < 100; i++) {
      list = (yield* body(yield* request("/api/app"))) ?? []
      if (Array.isArray(list) && list.length === 2) break
      yield* Effect.sleep("50 millis")
    }
    expect(list.find((app) => app.manifest.id === "app_calc")).toEqual(
      expect.objectContaining({ directory: calcDir, hasWeb: true, status: { status: "active" } }),
    )
    expect(list.find((app) => app.manifest.id === "app_beta")).toEqual(
      expect.objectContaining({ directory: betaDir, hasWeb: true, status: { status: "active" } }),
    )

    const got = yield* request("/api/app/app_calc")
    expect(got.status).toBe(200)
    expect((yield* body(got)).manifest.id).toBe("app_calc")

    const ticketResponse = yield* request("/api/app/app_calc/ticket", { method: "POST" })
    expect(ticketResponse.status).toBe(200)
    expect(typeof (yield* body(ticketResponse)).ticket).toBe("string")

    const missing = yield* request("/api/app/app_missing/ticket", { method: "POST" })
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({ _tag: "AppNotFoundError", id: "app_missing" })

    const forged = yield* request("/api/app/app_calc/ticket", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    })
    expect(forged.status).toBe(403)
  }),
)
