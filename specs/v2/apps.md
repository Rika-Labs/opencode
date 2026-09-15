# V2 Apps

Status: proposal. No code exists yet for anything in this document.

## Goal

Let one distributable "app" (for example a deterministic pricing calculator) serve four consumers from a single authoritative backend:

| Consumer | Surface |
| --- | --- |
| Agent inside an OpenCode session | MCP tools + skills |
| Human inside an external frontend, inline in a conversation | MCP Apps view (`ui://` resource rendered in a sandboxed iframe) |
| Human at a standalone or portal URL | Served web build |
| External clients (SDK, other frontends) | V2 `/api/...` endpoints |

OpenCode is the backend. Frontends (the desktop/web app, or any external product built on `@opencode-ai/client`) render iframes and run the MCP Apps host bridge. Core owns discovery, registration, tool plumbing, asset serving, and authorization. Nothing in this document requires the Solid frontends to change.

## Verified starting point

These facts constrain the design and were confirmed against the tree, not assumed.

- MCP is V1-only. The MCP client (`packages/opencode/src/mcp`) feeds the V1 `ToolRegistry` and the legacy `InstanceHttpApi` (`/mcp/*`). `packages/core` has no MCP service, no MCP schema beyond `ConfigMCP` (config shape only, unused at runtime), and `packages/protocol` has no MCP group. `packages/core/src/tool/AGENTS.md` records this as an open gap: "MCP and future Session-scoped registrations still need an explicit canonical registration design."
- V2 tools are canonical `Tool.make(...)` values registered through `Tools.Service.register` (Location-scoped, `Scope`-bound, last-registration-wins). `Tool.make` derives the model-facing JSON Schema from an Effect Schema; there is no way to supply a precomputed JSON Schema today. MCP tools arrive as JSON Schema.
- `ApplicationTools.Service` is process-scoped and is the seam `sdk-next` exposes as `opencode.tools.register`.
- `SkillV2` already supports `directory`, `url`, and `embedded` sources with `trusted-global` / `workspace` authority. Config-driven skill discovery is an internal plugin (`ConfigSkillPlugin`).
- `PtyTicket` (core, global node) is the existing single-use scoped-ticket pattern; the legacy server also accepts `?auth_token=` on any URL.
- Both API surfaces are mounted on one listener by `packages/opencode`, but `packages/client` is generated only from `packages/protocol`. The V2 server (`packages/server/src/routes.ts`) mounts only `HttpApiBuilder.layer(Api)`; there is no raw router or catch-all, so asset routes have no ordering hazard there. The legacy server has a `/*` UI catch-all, so any raw asset route added there must be registered before `uiRoute`.
- `@modelcontextprotocol/sdk` is pinned to `1.29.0` across the repo. `@modelcontextprotocol/ext-apps` 1.7.x peers on `sdk ^1.29.0`; 2.0.0 peers on the split `@modelcontextprotocol/{core,client,server} ^2`. Use 1.7.x server-side; do not bump the SDK incidentally.
- `@rivet-dev/dynamic-apps` 0.3.1 pins `rivetkit 2.3.11` and `@rivet-dev/agentos-core 0.2.18`; this repo uses `rivetkit 2.3.17` and a `link:` agentos-core. It requires Node >= 22, buffers request bodies, and does not support generic WebSockets or HTTP streaming.
- User decisions recorded for this design: target the V2 `/api` surface; widget-initiated tool calls are a direct authenticated proxy (server auth only, no permission ruleset evaluation).

## Design

### Layering

Follow the repo dependency rule: `schema -> {core, protocol} -> server`, client depends on schema + protocol only, `packages/opencode` wires everything, `packages/rivet` stays an adapter.

```
packages/schema/src/mcp.ts             MCP wire contracts: ServerStatus, ToolInfo (with ui meta), ResourceInfo, ResourceContents, CallResult
packages/schema/src/app.ts             App.Manifest, App.Info, App.ID, App.Ticket
packages/core/src/mcp.ts               McpV2.Service       Location-scoped MCP client registry
packages/core/src/mcp/catalog.ts       listing/pagination/name sanitization (port of V1 catalog)
packages/core/src/mcp/tool.ts          MCP tool -> canonical Tool.make bridge
packages/core/src/config/plugin/mcp.ts ConfigMcpPlugin      config.mcp.servers -> McpV2 registrations
packages/core/src/app.ts               App.Service         Location-scoped app registry (manifest discovery + composition)
packages/core/src/app/ticket.ts        AppTicket.Service    global single-use portal tickets (clone of PtyTicket)
packages/core/src/config/plugin/app.ts ConfigAppPlugin      config.apps + .opencode/app(s)/* -> App.Service
packages/protocol/src/groups/mcp.ts    server.mcp group
packages/protocol/src/groups/app.ts    server.app group
packages/server/src/handlers/mcp.ts
packages/server/src/handlers/app.ts
packages/client                        regenerate (`bun run generate`)
packages/rivet/src/app-host.ts         AppHost adapter for Rivet Dynamic Apps (phase 5, optional)
```

### Phase 1: V2 MCP (prerequisite)

Everything else depends on MCP existing in core. This is the largest piece and closes the recorded gap in `tool/AGENTS.md`.

**`McpV2.Service`** (Location node, deps: `Config`, `Tools`, `Location`, `EventV2`, `WorkspaceProcess` for stdio spawning, `HttpClient`).

```ts
interface Interface {
  readonly status: () => Effect.Effect<Record<string, Mcp.ServerStatus>>
  readonly tools: (server?: string) => Effect.Effect<ReadonlyArray<Mcp.ToolInfo>>
  readonly resources: (server?: string) => Effect.Effect<ReadonlyArray<Mcp.ResourceInfo>>
  readonly readResource: (server: string, uri: string) => Effect.Effect<Mcp.ResourceContents, NotFoundError | McpError>
  readonly callTool: (server: string, name: string, args: Schema.Json) => Effect.Effect<Mcp.CallResult, NotFoundError | McpError>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly transform: State.Transformable<Draft>  // same pattern as SkillV2: plugins add server definitions
}
```

Scoping: Location-scoped, like `SkillV2` and `ToolRegistry`. A server configured in workspace config only exists for that Location. `LocationServiceMap` already disposes Location services after idle, which gives MCP process teardown for free via `Effect.addFinalizer` in the layer.

Registration into V2 tools: on connect, `McpV2` registers `{ [sanitize(server) + "_" + sanitize(tool)]: Tool.make(...) }` through `Tools.Service.register` inside a per-server `Scope`; disconnect closes the scope, which removes the registrations. `tools/list_changed` closes and reopens the scope. This is the "separate scoped canonical registration" `tool/AGENTS.md` anticipates and does not add a second executable entry type.

**Required change to `Tool.make`:** widen `input` to accept either an Effect Schema or a raw JSON Schema document, following the precedent already set by `@opencode-ai/codemode` (`SchemaType = Schema.Decoder<unknown> | JsonSchema`, `packages/codemode/src/tool.ts`). `definition()` renders a JSON Schema input verbatim and derives one from an Effect Schema as today; `settle()` skips decoding for JSON Schema inputs, so `execute` receives `unknown` (the MCP server validates). The `execute` parameter type narrows the same way codemode's `InputType<S>` does. This keeps one constructor, one executor, and the codec-boundary law (identity codec for JSON Schema). Amend the `Design` section of `specs/v2/tools.md` to `input: Schema | JsonSchema` in the same change. This also unblocks plugin-authored tools, the other registration gap recorded in `tool/AGENTS.md`.

Permission: MCP leaf tools evaluate `PermissionV2` themselves in `execute`, using the canonical source `{ type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID }`, with action `mcp` and resource `<server>:<tool>`. This mirrors the "leaves own permission" rule and keeps `ToolRegistry` permission-free. The HTTP `callTool` endpoint bypasses this by design (user decision: direct proxy); it is protected only by server auth.

`_meta` preservation: `Mcp.ToolInfo` carries `meta: Schema.Json | undefined` verbatim, and the bridge exposes `ui.resourceUri` from `_meta.ui` as a first-class optional field so frontends do not parse `_meta`. Tool results likewise carry `meta` and `structuredContent` through `Mcp.CallResult`.

OAuth: port `McpOAuthProvider` + `McpAuth` token storage into core under `packages/core/src/mcp/oauth*.ts`, storing tokens through the existing `Credential` service rather than the V1 auth file. Ship stdio + streamable HTTP + SSE without OAuth first; OAuth is a follow-up inside this phase.

Config: `ConfigMcpPlugin` reads `config.mcp.servers` (already specified in `specs/v2/config.md` with `disabled` and `timeout.{startup,request}`) and adds them to `McpV2` through `transform`. Workspace-origin `local` servers are refused everywhere (workspace config is untrusted and must not select executables). In managed workspaces every workspace-origin server is refused, `remote` included — matching `config.ts`, which drops the `mcp` key from managed workspace documents entirely.

Protocol/server: `server.mcp` group with `mcp.status`, `mcp.tool.list`, `mcp.resource.list`, `mcp.resource.read`, `mcp.tool.call`, `mcp.connect`, `mcp.disconnect`, all with `LocationQuery` and Location middleware. Errors are explicit `Schema.ErrorClass` contracts (`ApiMcpNotFoundError`, `ApiMcpError`), never `HttpApiError.*` with messages.

Not in scope for phase 1: prompts, resource templates, elicitation, sampling, code mode. Keep parity with what apps need.

### Phase 2: App manifest and registry

An app is a composition of primitives that already exist after phase 1. The manifest adds no runtime of its own.

```ts
// packages/schema/src/app.ts
export const Manifest = Schema.Struct({
  id: ID,                                        // "app_" prefixed
  name: Schema.String,
  version: Schema.String,
  description: Schema.String.pipe(optional),
  mcp: ConfigMCP.Server.pipe(optional),          // the app's tool server; registered under the app id
  skills: Schema.Array(RelativePath).pipe(optional), // directories relative to the manifest, added as SkillV2 directory sources
  web: Schema.Struct({
    root: RelativePath,                          // built static assets; index.html at root
    entry: RelativePath.pipe(optional),          // defaults to index.html
  }).pipe(optional),
  ui: Schema.Struct({                            // MCP Apps declarations (mirrors ext-apps resource _meta.ui)
    csp: Csp.pipe(optional),
    permissions: Permissions.pipe(optional),
  }).pipe(optional),
  permissions: Schema.Array(Schema.String).pipe(optional), // requested; never auto-granted
})
```

Discovery (`ConfigAppPlugin`, same shape as `ConfigExternalPlugin`): `config.apps` entries (path, `file://`, or npm spec resolved through `Npm.Service`) plus `{app,apps}/*/app.json` under each config directory. Workspace-origin apps contribute only `web` and `skills`; their `mcp` entry reaches `McpV2` with `workspace` authority and is refused by the managed-workspace rule above. `skills` and `web.root` paths are confined to the app directory; entries that escape are dropped.

Composition (`App.Service`, Location node): for each manifest, add the `mcp` server to `McpV2` via `transform` under the app id, add `skills` directories to `SkillV2` via `transform` with authority inherited from the config entry origin, and record `web.root` for asset serving. `App.Info` is the wire shape: manifest + `mcpServer` (the server name the app registered under) + `hasWeb` + status.

Uninstall/disable removes the transform contributions; there is nothing else to tear down.

### Phase 3: Asset serving and portal tickets

**Assets.** `server.app` group: `app.list`, `app.get`, and `app.asset` (`GET /api/app/:id/web/*`). Handlers serve files from the app's `web.root` through the Location filesystem with `FSUtil.mimeType`, path-normalized, confined to `web.root` on the real path (symlink escapes rejected via `FSUtil.resolve` + `FSUtil.contains`), and regular files only. HTML responses carry a CSP built from `manifest.ui.csp` exactly as the ext-apps host reference does (`default-src 'none'; script-src 'self' 'unsafe-inline' <resourceDomains>; connect-src 'self' <connectDomains>; frame-src <frameDomains|'none'>; form-action 'self'; ...`), with manifest domain values pattern-validated against directive injection. Non-HTML assets are immutable-cacheable by content hash if the build emits hashed names; otherwise `no-cache`.

**Tickets.** `AppTicket.Service` is a global node cloned from `PtyTicket` with scope `{ appID, directory, workspaceID? }` and a 60 s TTL. `app.ticket` (`POST /api/app/:id/ticket`, authenticated, origin-checked via `isAllowedRequestOrigin` — cross-origin browser mints carry `Origin` and are refused) issues one binding the caller's request location. `GET /api/app/:id/web/?ticket=` consumes it — `consume(ticket)` returns the stored scope, the exchange verifies `scope.appID` matches the path id, then responds `Set-Cookie: opencode_app_<id>=<session>; Path=/api/app/<id>/; HttpOnly` plus `cache-control: no-store` and a redirect to the clean URL. Cookie attributes are protocol-derived: `https:` gets `SameSite=None; Secure` (embeddable cross-site), `http:` gets `SameSite=Lax` (browsers reject `Secure` cookies on non-localhost HTTP). Subsequent asset requests verify the cookie against the stored scope and serve through the stored scope's location via `LocationServiceMap.get` — the ticket/session scope is authoritative, never re-derived from request params, because `iframe src` navigations and subresource requests cannot carry `location[...]` params. A stale ticket falls through to the cookie check; credential-authenticated callers skip the cookie requirement and serve through the request location. The `Authorization` middleware bypasses `/api/app/:id/web/*` requests carrying either the ticket or an `opencode_app_`-prefixed cookie, analogous to `hasPtyConnectTicketURL`. Cookie sessions are process-local (`Cache` with TTL); a restart invalidates them, which is acceptable for a first slice.

**Frontend contract (documented, not shipped as code in this phase).** A host renders an app by: `sdk.app.ticket(id)` -> iframe `src = /api/app/:id/web/?ticket=`. For inline MCP Apps views: `sdk.mcp.tool.list()` to find `ui.resourceUri`, `sdk.mcp.resource.read(server, uri)` to fetch HTML, then the ext-apps double-iframe sandbox proxy with `AppBridge` over `PostMessageTransport`, forwarding `tools/call` to `sdk.mcp.tool.call` and `resources/read` to `sdk.mcp.resource.read`. Host capabilities advertised: `serverTools`, `serverResources`, `logging`; no `openLinks` until a policy exists.

### Phase 4: Host bridge helper

Ship the host side of the MCP Apps protocol once so consumers do not hand-roll it. Location: `packages/client/src/apps/` (client may depend on schema + protocol only, which this does) or a sibling `packages/apps-host` if the React/ext-apps peer dependencies would pollute `client`. The helper wraps `@modelcontextprotocol/ext-apps/host` 1.7.x: create the sandbox proxy iframe, connect `AppBridge`, translate `tools/call` and `resources/read` to typed client calls, and forward theme/size notifications. Framework-agnostic; React and Solid wrappers are thin.

### Phase 5: Deployment adapter (optional, out of core)

Define `AppHost` in core as a contract only:

```ts
interface AppHost.Interface {
  readonly publish: (app: App.Info, build: AbsolutePath) => Effect.Effect<App.Release, AppHost.Error>
  readonly url: (release: App.Release) => Effect.Effect<URL>
  readonly retire: (release: App.Release) => Effect.Effect<void, AppHost.Error>
}
```

Core provides the local implementation (a release is the served `web.root`). `packages/rivet/src/app-host.ts` implements it with `@rivet-dev/dynamic-apps` `deployApp`, pinned separately and tested against its own dependency set. Do not add `dynamic-apps` to core or `packages/opencode`. Rivet-hosted apps get auth from our routing layer in front of Rivet, never from Rivet itself.

## Trust boundaries

- App code never runs inside the OpenCode host. An app contributes an MCP server (own process or remote), static assets, and skill markdown. Nothing is `import()`ed. This is the difference between apps and plugins; do not blur it by letting a manifest reference a plugin module.
- Serving an app's HTML from `/api/app/:id/web/` puts it on the OpenCode origin. The CSP above is mandatory, and frontends must still iframe with `sandbox="allow-scripts allow-forms"` (add `allow-same-origin` only when the ext-apps double-iframe proxy requires it). A later hardening step is a separate asset origin; document it as such rather than blocking phase 3 on it.
- A portal cookie authorizes asset reads under one app path only. It grants no `/api` access. The bridge in the frontend, not the iframe, holds real credentials.
- Widget tool calls bypass the permission ruleset by decision. Consequence: any authenticated frontend user can invoke any connected MCP tool through `mcp.tool.call`. Record this in the endpoint description. If that proves too broad, the manifest `permissions` field is the hook for an allowlist without changing the API.
- Requested manifest permissions are informational until an approval flow exists.

## Rules this design must respect

- `schema` holds only serializable contracts; `Mcp.*` and `App.*` wire types live there, runtime in core.
- New core services are Location nodes unless genuinely process-global (`AppTicket` is global like `PtyTicket`). Register them in `location-services.ts`.
- Config module additions follow the self-export-at-top pattern (`export * as ConfigMcpPlugin from "./mcp"`).
- No `export namespace`; flat exports plus `export * as X from "./x"`.
- Public API errors are explicit `Schema.ErrorClass` contracts declared per endpoint.
- After changing protocol or server HttpApi: `bun run generate` from `packages/client`; never edit `src/generated*`.
- Tests run from package directories, never root; `bun typecheck` per package.
- Do not bump `@modelcontextprotocol/sdk`; use `ext-apps` 1.7.x.
- Do not touch `packages/opencode/src/mcp` V1 behavior. V1 keeps working unchanged; V2 is additive. Removing V1 MCP is a separate decision once V2 reaches parity.

## Decisions

Settled with the project owner; treat as fixed inputs for implementation.

1. `Tool.make` accepts `input: Schema | JsonSchema` (codemode precedent). No separate constructor, no side-channel schema field.
2. `mcp.tool.call` requires no Session. It is Location-scoped and logs server, tool, and caller principal. Widgets work at standalone portal URLs.
3. App `web` assets in managed workspaces are read through `WorkspaceFileSystem` at request time. Snapshotting is a phase 5 (`AppHost`) concern.
4. Portal auth is ticket -> path-scoped `HttpOnly` cookie under `/api/app/:id/`. Signed per-asset URLs are rejected because a React build has many subresources.
5. Target surface is V2 `/api` (`protocol` -> `server` -> `client`). V1 MCP is untouched.
6. Widget-initiated tool calls are a direct authenticated proxy; the permission ruleset is not evaluated for `mcp.tool.call`.

## Verification

Each phase lands with tests in its owning package, run from that package directory:

- Phase 1: `packages/core` tests using the existing MCP fixtures pattern (`test/fixture/mcp-lifecycle-stdio.ts` has a portable in-process server) covering connect, tool registration visible through `ToolRegistry.materialize`, `_meta` round-trip, `readResource`, `callTool`, disconnect removing registrations, and `tools/list_changed` re-registration. `packages/server` handler tests for each `server.mcp` endpoint.
- Phase 2: manifest decode tests in `packages/schema`; `App.Service` tests asserting that one manifest produces exactly one MCP registration and the declared skill sources, and that removal reverts both.
- Phase 3: path-confinement test (`..` and encoded traversal rejected), CSP header test, ticket single-use and expiry tests, cookie-scoped authorization test (cookie does not authorize `/api/session`).
- End-to-end: one calculator fixture with two ruleset versions; identical results via `mcp.tool.call` and via an agent session tool call; old quote reproducible after ruleset change.
