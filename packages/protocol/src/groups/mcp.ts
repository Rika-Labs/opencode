import { Location } from "@opencode-ai/schema/location"
import { Mcp } from "@opencode-ai/schema/mcp"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { McpError, McpNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ServerQuery = Schema.Struct({
  ...LocationQuery.fields,
  server: Schema.String.pipe(Schema.optional),
})

const ReadQuery = Schema.Struct({
  ...LocationQuery.fields,
  uri: Schema.String,
})

export const McpGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.status", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, Mcp.ServerStatus)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.status",
          summary: "MCP server status",
          description: "Get the connection status of configured MCP servers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("mcp.tool.list", "/api/mcp/tool", {
      query: ServerQuery,
      success: Location.response(Schema.Array(Mcp.ToolInfo)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.tool.list",
          summary: "List MCP tools",
          description: "List tools exposed by connected MCP servers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.tool.call", "/api/mcp/:server/tool/:name", {
      params: { server: Schema.String, name: Schema.String },
      query: LocationQuery,
      payload: Schema.Struct({ arguments: Schema.Json.pipe(Schema.optional) }),
      success: Location.response(Mcp.CallResult),
      error: [McpNotFoundError, McpError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.tool.call",
          summary: "Call MCP tool",
          description:
            "Invoke an MCP tool. Direct authenticated proxy. The permission ruleset is not evaluated; any authenticated caller may invoke any connected tool.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("mcp.resource.list", "/api/mcp/resource", {
      query: ServerQuery,
      success: Location.response(Schema.Array(Mcp.ResourceInfo)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.resource.list",
          summary: "List MCP resources",
          description: "List resources exposed by connected MCP servers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("mcp.resource.read", "/api/mcp/:server/resource", {
      params: { server: Schema.String },
      query: ReadQuery,
      success: Location.response(Mcp.ResourceContents),
      error: [McpNotFoundError, McpError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.resource.read",
          summary: "Read MCP resource",
          description: "Read one MCP resource by URI from a connected server.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:server/connect", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: [McpNotFoundError, McpError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.connect",
          summary: "Connect MCP server",
          description: "Connect a configured MCP server.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:server/disconnect", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: McpNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.mcp.disconnect",
          summary: "Disconnect MCP server",
          description: "Disconnect a configured MCP server.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "mcp",
      description: "Experimental MCP routes.",
    }),
  )
