export * as ConfigMcpPlugin from "./mcp"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { Config } from "../../config"
import { ConfigMCP } from "../../config/mcp"
import { McpV2 } from "../../mcp"

export const Plugin = define({
  id: "config-mcp",
  effect: Effect.fn(function* () {
    const config = yield* Config.Service
    const mcp = yield* McpV2.Service
    yield* mcp.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const servers = new Map<string, { server: ConfigMCP.ServerConfig; origin?: "global" | "workspace" }>()
        for (const entry of entries) {
          if (entry.type !== "document") continue
          for (const [name, server] of Object.entries(entry.info.mcp?.servers ?? {}))
            servers.set(name, { server, origin: entry.origin })
        }
        for (const [name, { server, origin }] of servers)
          draft.server(name, server, origin === "workspace" ? "workspace" : undefined)
      }),
    )
  }),
})
