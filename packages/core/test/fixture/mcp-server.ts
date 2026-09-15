import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult

const tools = new Map<
  string,
  { description?: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown>; run: ToolHandler }
>()

const server = new Server(
  { name: "mcp-v2-fixture", version: "1.0.0" },
  {
    capabilities: process.env.FIXTURE_NO_TOOLS
      ? { resources: {} }
      : { tools: { listChanged: true }, resources: {} },
  },
)
const withTools = process.env.FIXTURE_NO_TOOLS === undefined

tools.set("echo", {
  description: "Echo the message back",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  run: (args) =>
    args.message === "__fail__"
      ? { content: [{ type: "text", text: "fixture failure" }], isError: true }
      : { content: [{ type: "text", text: String(args.message) }] },
})

tools.set("price", {
  description: "Return a structured price",
  inputSchema: { type: "object", properties: {} },
  _meta: { ui: { resourceUri: "ui://price/app.html" } },
  run: () => ({ content: [], structuredContent: { price: 42, currency: "usd" } }),
})

tools.set("add_tool", {
  description: "Register a new tool and notify",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    tools.set("added", {
      description: "Dynamically added tool",
      inputSchema: { type: "object", properties: {} },
      run: () => ({ content: [{ type: "text", text: "added" }] }),
    })
    await server.sendToolListChanged()
    return { content: [{ type: "text", text: "ok" }] }
  },
})

if (process.env.FIXTURE_COLLIDE) {
  for (const name of ["x.y", "x_y"]) {
    tools.set(name, {
      description: `colliding tool ${name}`,
      inputSchema: { type: "object", properties: {} },
      run: () => ({ content: [{ type: "text", text: name }] }),
    })
  }
}

if (withTools) {
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: Array.from(tools, ([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        _meta: tool._meta,
      })),
    }),
  )

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = tools.get(request.params.name)
    if (!tool)
      return Promise.resolve({ content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true })
    return Promise.resolve(tool.run(request.params.arguments ?? {}))
  })
}

server.setRequestHandler(ListResourcesRequestSchema, () =>
  Promise.resolve({
    resources: [{ uri: "ui://price/app.html", name: "price-app", mimeType: "text/html;profile=mcp-app" }],
  }),
)

server.setRequestHandler(ReadResourceRequestSchema, (request) => {
  if (request.params.uri !== "ui://price/app.html") return Promise.reject(new Error(`Unknown resource: ${request.params.uri}`))
  return Promise.resolve({
    contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app", text: "<html>hi</html>" }],
  })
})

await server.connect(new StdioServerTransport())
