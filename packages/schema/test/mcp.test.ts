import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Mcp } from "../src/mcp"

describe("Mcp contracts", () => {
  test("optional properties omit undefined while encoding", () => {
    const encode = Schema.encodeSync(Mcp.ToolInfo)
    expect(
      encode({
        server: "test",
        name: "echo",
        inputSchema: { type: "object" },
      }),
    ).toEqual({ server: "test", name: "echo", inputSchema: { type: "object" } })
  })

  test("decodes tool info with ui meta", () => {
    const decode = Schema.decodeUnknownSync(Mcp.ToolInfo)
    expect(
      decode({
        server: "test",
        name: "price",
        inputSchema: { type: "object" },
        meta: { ui: { resourceUri: "ui://price/app.html" } },
        ui: { resourceUri: "ui://price/app.html" },
      }),
    ).toEqual({
      server: "test",
      name: "price",
      inputSchema: { type: "object" },
      meta: { ui: { resourceUri: "ui://price/app.html" } },
      ui: { resourceUri: "ui://price/app.html" },
    })
  })

  test("server status is a tagged union on status", () => {
    const decode = Schema.decodeUnknownSync(Mcp.ServerStatus)
    expect(decode({ status: "connected" })).toEqual({ status: "connected" })
    expect(decode({ status: "failed", error: "boom" })).toEqual({ status: "failed", error: "boom" })
    expect(() => decode({ status: "unknown" })).toThrow()
  })

  test("public identifiers are stable and unique", () => {
    const identifiers = [
      Mcp.Connected,
      Mcp.Disabled,
      Mcp.Failed,
      Mcp.ServerStatus,
      Mcp.ToolUI,
      Mcp.ToolInfo,
      Mcp.ResourceInfo,
      Mcp.ResourceContent,
      Mcp.ResourceContents,
      Mcp.TextContent,
      Mcp.ImageContent,
      Mcp.EmbeddedResource,
      Mcp.CallContent,
      Mcp.CallResult,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })
})
