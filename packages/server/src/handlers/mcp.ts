import { McpV2 } from "@opencode-ai/core/mcp"
import { McpError, McpNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const notFound = (error: McpV2.NotFoundError) =>
  new McpNotFoundError({ server: error.name, message: `MCP server not found: ${error.name}` })

const failed = (error: McpV2.McpError) =>
  new McpError({
    server: error.server,
    operation: error.operation,
    message: error.cause instanceof Error ? error.cause.message : String(error.cause),
  })

const translate = <A, R>(effect: Effect.Effect<A, McpV2.NotFoundError | McpV2.McpError, R>) =>
  effect.pipe(Effect.catchTags({ "McpV2.NotFoundError": notFound, "McpV2.Error": failed }))

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  handlers
    .handle("mcp.status", () => response(McpV2.Service.use((mcp) => mcp.status())))
    .handle(
      "mcp.tool.list",
      Effect.fn(function* (ctx) {
        const mcp = yield* McpV2.Service
        return yield* response(mcp.tools(ctx.query.server))
      }),
    )
    .handle(
      "mcp.tool.call",
      Effect.fn(function* (ctx) {
        yield* Effect.logInfo("mcp tool call", { server: ctx.params.server, tool: ctx.params.name })
        const mcp = yield* McpV2.Service
        return yield* response(
          translate(mcp.callTool(ctx.params.server, ctx.params.name, ctx.payload.arguments ?? {})),
        )
      }),
    )
    .handle(
      "mcp.resource.list",
      Effect.fn(function* (ctx) {
        const mcp = yield* McpV2.Service
        return yield* response(mcp.resources(ctx.query.server))
      }),
    )
    .handle(
      "mcp.resource.read",
      Effect.fn(function* (ctx) {
        const mcp = yield* McpV2.Service
        return yield* response(translate(mcp.readResource(ctx.params.server, ctx.query.uri)))
      }),
    )
    .handle(
      "mcp.connect",
      Effect.fn(function* (ctx) {
        const mcp = yield* McpV2.Service
        return yield* translate(mcp.connect(ctx.params.server))
      }),
    )
    .handle(
      "mcp.disconnect",
      Effect.fn(function* (ctx) {
        const mcp = yield* McpV2.Service
        return yield* mcp.disconnect(ctx.params.server).pipe(Effect.catchTag("McpV2.NotFoundError", notFound))
      }),
    ),
)
