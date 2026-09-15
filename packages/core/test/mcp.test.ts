import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { ConfigMcpPlugin } from "@opencode-ai/core/config/plugin/mcp"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { McpV2 } from "@opencode-ai/core/mcp"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_mcp_test")
const fixture = path.join(import.meta.dir, "fixture/mcp-server.ts")

const serverConfig = () => new ConfigMCP.Local({ type: "local", command: [process.execPath, fixture] })

const published: EventV2.Payload[] = []

const events = Layer.succeed(
  EventV2.Service,
  EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const payload = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<
          typeof definition
        >
        published.push(payload)
        return payload
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  }),
)

function permissionLayer(assertions: PermissionV2.AssertInput[]) {
  return Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: (input) => Effect.sync(() => assertions.push(input)),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
}

function mcpLayer(directory: string, workspaceID?: WorkspaceID, assertions: PermissionV2.AssertInput[] = []) {
  return AppNodeBuilder.build(LayerNode.group([McpV2.node, ToolRegistry.node]), [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make(directory), workspaceID }),
        ),
      ),
    ],
    [PermissionV2.node, permissionLayer(assertions)],
    [EventV2.node, events],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])
}

const poll = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, attempts = 100) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(50)
    }
    return yield* effect
  })

describe("Tool JSON Schema input", () => {
  it.effect("renders JSON Schema input verbatim and passes raw input to execute", () =>
    Effect.gen(function* () {
      const inputSchema = {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      } as const
      const seen: unknown[] = []
      const tool = Tool.make({
        description: "raw input",
        input: inputSchema,
        output: Schema.String,
        execute: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return "ok"
          }),
      })
      expect(Tool.definition("raw", tool).inputSchema).toEqual(inputSchema)
      const output = yield* Tool.settle(
        tool,
        { type: "tool-call", id: "call-raw", name: "raw", input: { message: "not validated", extra: 1 } },
        { sessionID, agent: toolIdentity.agent, assistantMessageID: toolIdentity.assistantMessageID, toolCallID: "call-raw" },
      )
      expect(output.structured).toBe("ok")
      expect(seen).toEqual([{ message: "not validated", extra: 1 }])
    }),
  )
})

describe("McpV2", () => {
  it.live("connects a local server, lists tools with ui meta, and registers them", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const assertions: PermissionV2.AssertInput[] = []
          return yield* Effect.gen(function* () {
            const mcp = yield* McpV2.Service
            const registry = yield* ToolRegistry.Service
            yield* mcp.transform((draft) => {
              draft.server("test", serverConfig())
            })

            expect(yield* mcp.status()).toEqual({ test: { status: "connected" } })

            const listed = yield* mcp.tools()
            expect(listed.map((tool) => tool.name).toSorted()).toEqual(["add_tool", "echo", "price"])
            const price = listed.find((tool) => tool.name === "price")
            expect(price?.ui).toEqual({ resourceUri: "ui://price/app.html" })
            expect(price?.meta).toEqual({ ui: { resourceUri: "ui://price/app.html" } })

            const definitions = yield* toolDefinitions(registry)
            const echo = definitions.find((definition) => definition.name === "mcp_test_echo")
            expect(echo).toBeDefined()
            expect(echo?.inputSchema).toEqual({
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            })
            expect(definitions.some((definition) => definition.name === "mcp_test_price")).toBe(true)

            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-echo", name: "mcp_test_echo", input: { message: "hi" } },
              }),
            ).toEqual({ type: "text", value: "hi" })
            expect(assertions).toMatchObject([
              {
                sessionID,
                action: "mcp",
                resources: ["test:echo"],
                source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-echo" },
              },
            ])

            expect(yield* mcp.readResource("test", "ui://price/app.html")).toEqual({
              contents: [{ uri: "ui://price/app.html", mimeType: "text/html;profile=mcp-app", text: "<html>hi</html>" }],
            })
            expect(yield* mcp.resources("test")).toEqual([
              { server: "test", uri: "ui://price/app.html", name: "price-app", mimeType: "text/html;profile=mcp-app" },
            ])

            const result = yield* mcp.callTool("test", "price", {})
            expect(result.structuredContent).toEqual({ price: 42, currency: "usd" })

            yield* mcp.callTool("test", "add_tool", {})
            const updated = yield* poll(toolDefinitions(registry), (defs) =>
              defs.some((definition) => definition.name === "mcp_test_added"),
            )
            expect(updated.some((definition) => definition.name === "mcp_test_added")).toBe(true)
            const seen = yield* poll(
              Effect.sync(() => published.some((event) => event.type === McpEvent.ToolsChanged.type)),
              (fired) => fired,
            )
            expect(seen).toBe(true)

            yield* mcp.disconnect("test")
            const after = yield* toolDefinitions(registry)
            expect(after.some((definition) => definition.name === "mcp_test_echo")).toBe(false)
          }).pipe(Effect.provide(mcpLayer(tmp.path, undefined, assertions)))
        }),
      ),
    ),
  )

  it.live("refuses local servers in managed workspaces", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server("test", serverConfig())
          })
          expect(yield* mcp.status()).toEqual({
            test: { status: "failed", error: "Local MCP servers are not supported in managed workspaces" },
          })
          expect(yield* mcp.tools()).toEqual([])
          const error = yield* mcp.connect("test").pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "McpV2.Error", server: "test", operation: "connect" })
        }).pipe(Effect.provide(mcpLayer(tmp.path, WorkspaceID.create()))),
      ),
    ),
  )

  it.live("refuses workspace-authority servers by location and transport", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server("test", serverConfig(), "workspace")
          })
          expect(yield* mcp.status()).toEqual({
            test: { status: "failed", error: "Local MCP servers from workspace configuration are not supported" },
          })
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("refuses workspace-authority remote servers in managed workspaces", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server(
              "test",
              new ConfigMCP.Remote({ type: "remote", url: "https://mcp.example.com/" }),
              "workspace",
            )
          })
          expect(yield* mcp.status()).toEqual({
            test: {
              status: "failed",
              error: "Workspace-configured MCP servers are not supported in managed workspaces",
            },
          })
          expect(yield* mcp.tools()).toEqual([])
        }).pipe(Effect.provide(mcpLayer(tmp.path, WorkspaceID.create()))),
      ),
    ),
  )

  it.live("ConfigMcpPlugin registers servers from config", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: new Config.Info({
                  mcp: new ConfigMCP.Info({
                    servers: {
                      test: new ConfigMCP.Local({ type: "local", command: [process.execPath, fixture], disabled: true }),
                    },
                  }),
                }),
              }),
            ]),
        })
        return Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* ConfigMcpPlugin.Plugin.effect({} as PluginContext).pipe(
            Effect.provideService(Config.Service, config),
          )
          expect(yield* mcp.status()).toEqual({ test: { status: "disabled" } })
        }).pipe(Effect.provide(mcpLayer(tmp.path)))
      }),
    ),
  )

  it.live("fails public connect for a disabled server", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server("test", new ConfigMCP.Local({ type: "local", command: [process.execPath, fixture], disabled: true }))
          })
          expect(yield* mcp.status()).toEqual({ test: { status: "disabled" } })
          const error = yield* mcp.connect("test").pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "McpV2.Error", server: "test", operation: "connect" })
          expect(yield* mcp.status()).toEqual({ test: { status: "disabled" } })
          expect(yield* mcp.tools()).toEqual([])
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("disconnect clears status and connect round-trips to connected", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server("test", serverConfig())
          })
          expect(yield* mcp.status()).toEqual({ test: { status: "connected" } })
          yield* mcp.disconnect("test")
          expect(yield* mcp.status()).toEqual({})
          yield* mcp.connect("test")
          expect(yield* mcp.status()).toEqual({ test: { status: "connected" } })
          expect((yield* mcp.tools()).map((tool) => tool.name)).toContain("echo")
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("fails unknown servers with NotFoundError", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          const exits: Exit.Exit<unknown, McpV2.NotFoundError | McpV2.McpError>[] = [
            yield* mcp.callTool("missing", "echo", {}).pipe(Effect.exit),
            yield* mcp.readResource("missing", "ui://price/app.html").pipe(Effect.exit),
            yield* mcp.connect("missing").pipe(Effect.exit),
          ]
          for (const exit of exits) {
            expect(exit._tag).toBe("Failure")
            if (Exit.isFailure(exit))
              expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
                _tag: "McpV2.NotFoundError",
                name: "missing",
              })
          }
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("surfaces isError tool results as tool failures", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          const registry = yield* ToolRegistry.Service
          yield* mcp.transform((draft) => {
            draft.server("test", serverConfig())
          })
          const direct = yield* mcp.callTool("test", "bogus", {})
          expect(direct.isError).toBe(true)
          expect(
            yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-fail", name: "mcp_test_echo", input: { message: "__fail__" } },
            }),
          ).toEqual({ type: "error", value: "fixture failure" })
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("connects a resources-only server without a tools capability", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server(
              "test",
              new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, fixture],
                environment: { FIXTURE_NO_TOOLS: "1" },
              }),
            )
          })
          expect(yield* mcp.status()).toEqual({ test: { status: "connected" } })
          expect(yield* mcp.tools()).toEqual([])
          expect((yield* mcp.resources()).map((resource) => resource.uri)).toContain("ui://price/app.html")
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("fails a server whose sanitized tool names collide", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          yield* mcp.transform((draft) => {
            draft.server(
              "test",
              new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, fixture],
                environment: { FIXTURE_COLLIDE: "1" },
              }),
            )
          })
          expect(yield* mcp.status()).toEqual({
            test: { status: "failed", error: 'Duplicate tool names from "test"' },
          })
          const error = yield* mcp.connect("test").pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "McpV2.Error" })
          expect(yield* mcp.status()).toEqual({
            test: { status: "failed", error: 'Duplicate tool names from "test"' },
          })
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )

  it.live("keeps a managed connection across reloads with an equal config", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const mcp = yield* McpV2.Service
          const registry = yield* ToolRegistry.Service
          yield* mcp.transform((draft) => {
            draft.server("test", serverConfig())
          })
          yield* mcp.callTool("test", "add_tool", {})
          const before = yield* poll(toolDefinitions(registry), (defs) =>
            defs.some((definition) => definition.name === "mcp_test_added"),
          )
          expect(before.some((definition) => definition.name === "mcp_test_added")).toBe(true)

          yield* mcp.transform((draft) => {
            draft.server("test", serverConfig())
          })
          expect(yield* mcp.status()).toEqual({ test: { status: "connected" } })
          expect(
            (yield* toolDefinitions(registry)).some((definition) => definition.name === "mcp_test_added"),
          ).toBe(true)
          expect(yield* mcp.callTool("test", "added", {})).toMatchObject({ isError: undefined })
        }).pipe(Effect.provide(mcpLayer(tmp.path))),
      ),
    ),
  )
})
