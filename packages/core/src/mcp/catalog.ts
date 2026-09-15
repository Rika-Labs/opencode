export * as McpCatalog from "./catalog"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"

export const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (server: string, name: string) => sanitize(server) + "_" + sanitize(name)

export function listTools(client: Client, timeout: number = DEFAULT_TIMEOUT) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export function listResources(client: Client, timeout: number = DEFAULT_TIMEOUT) {
  if (!client.getServerCapabilities()?.resources) return Effect.succeed([])
  return Effect.tryPromise({
    try: () =>
      paginate(
        (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
        (result) => result.resources,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}
