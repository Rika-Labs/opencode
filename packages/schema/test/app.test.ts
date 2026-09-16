import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { App } from "../src/app"

describe("App contracts", () => {
  test("decodes a manifest with defaults and omitted optionals", () => {
    const decode = Schema.decodeUnknownSync(App.Manifest)
    const manifest = decode({
      id: "app_calc",
      name: "Calculator",
      version: "1.0.0",
      web: { root: "dist" },
      mcp: { type: "local", command: ["node", "server.js"] },
    })
    expect(manifest.web?.entry as string).toBe("index.html")
    expect(manifest.description).toBeUndefined()
    const encode = Schema.encodeSync(App.Manifest)
    const encoded = encode(manifest)
    expect("description" in encoded).toBe(false)
    expect(encoded.web).toEqual({ root: "dist", entry: "index.html" })
  })

  test("id must carry the app_ prefix and lowercase charset", () => {
    const decode = Schema.decodeUnknownSync(App.ID)
    expect(decode("app_calc") as string).toBe("app_calc")
    expect(decode("app_my-app_2") as string).toBe("app_my-app_2")
    expect(() => decode("calc")).toThrow()
    expect(() => decode("app_Calc")).toThrow()
    expect(App.ID.create()).toMatch(/^app_[a-z0-9_-]+$/)
  })

  test("manifest rejects unknown mcp server shapes", () => {
    const decode = Schema.decodeUnknownSync(App.Manifest)
    expect(() =>
      decode({ id: "app_x", name: "x", version: "1", mcp: { type: "local", url: "http://x" } }),
    ).toThrow()
    expect(
      decode({ id: "app_x", name: "x", version: "1", mcp: { type: "remote", url: "http://x" } }).mcp,
    ).toEqual({ type: "remote", url: "http://x" })
  })

  test("csp domains reject directive-breaking characters", () => {
    const decode = Schema.decodeUnknownSync(App.Manifest)
    const manifest = (csp: unknown) => ({ id: "app_x", name: "x", version: "1", ui: { csp } })
    expect(decode(manifest({ connectDomains: ["https://api.example.com", "wss://socket.example.com"] })).ui?.csp)
      .toEqual({ connectDomains: ["https://api.example.com", "wss://socket.example.com"] })
    expect(() => decode(manifest({ connectDomains: ["example.com; script-src *"] }))).toThrow()
    expect(() => decode(manifest({ resourceDomains: ['example.com"'] }))).toThrow()
    expect(() => decode(manifest({ frameDomains: ["'unsafe-inline'"] }))).toThrow()
    expect(() => decode(manifest({ baseUriDomains: ["a b"] }))).toThrow()
  })

  test("public identifiers are stable and unique", () => {
    const identifiers = [
      App.Csp,
      App.Permissions,
      App.McpTimeout,
      App.McpLocal,
      App.McpRemote,
      App.McpServer,
      App.Web,
      App.Ui,
      App.Manifest,
      App.Active,
      App.Failed,
      App.Status,
      App.Info,
      App.Release,
    ].map((schema) => schema.ast.annotations?.identifier)
    expect(new Set(identifiers).size).toBe(identifiers.length)
    for (const identifier of identifiers) expect(identifier).toMatch(/^App\./)
  })
})
