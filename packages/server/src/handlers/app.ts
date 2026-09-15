import path from "node:path"
import { AppV2 } from "@opencode-ai/core/app"
import { AppTicket } from "@opencode-ai/core/app/ticket"
import { Location } from "@opencode-ai/core/location"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ApiAppNotFoundError, APP_TICKET_QUERY, appAssetCookieName } from "@opencode-ai/protocol/groups/app"
import { response } from "../location"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory, workspaceID: location.workspaceID }
})

const HASHED_ASSET = /[.-][0-9a-f]{8,}\./

function csp(csp: AppV2.Csp | undefined) {
  const resource = csp?.resourceDomains ?? []
  const join = (domains: readonly string[]) => (domains.length ? " " + domains.join(" ") : "")
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${join(resource)}`,
    `style-src 'self' 'unsafe-inline'${join(resource)}`,
    `connect-src 'self'${join(csp?.connectDomains ?? [])}`,
    `img-src 'self' data:${join(resource)}`,
    `font-src 'self'${join(resource)}`,
    `media-src 'self' data:${join(resource)}`,
    `frame-src${csp?.frameDomains?.length ? join(csp.frameDomains) : " 'none'"}`,
    "object-src 'none'",
    `base-uri${csp?.baseUriDomains?.length ? join(csp.baseUriDomains) : " 'self'"}`,
  ].join("; ")
}

function permissionsPolicy(permissions: AppV2.Permissions | undefined) {
  if (!permissions) return undefined
  const rule = (allowed: boolean | undefined) => (allowed ? "(self)" : "()")
  return [
    `camera=${rule(permissions.camera)}`,
    `microphone=${rule(permissions.microphone)}`,
    `geolocation=${rule(permissions.geolocation)}`,
    `clipboard-write=${rule(permissions.clipboardWrite)}`,
  ].join(", ")
}

function cookieToken(header: string | undefined, name: string) {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return undefined
}

export const AppHandler = HttpApiBuilder.group(Api, "server.app", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* AppTicket.Service

    const notFound = (id: string) => new ApiAppNotFoundError({ id, message: `App not found: ${id}` })

    return handlers
      .handle(
        "app.list",
        Effect.fn(function* () {
          const apps = yield* AppV2.Service
          return yield* response(apps.list())
        }),
      )
      .handle(
        "app.get",
        Effect.fn(function* (ctx) {
          const apps = yield* AppV2.Service
          const info = yield* apps
            .get(ctx.params.id)
            .pipe(Effect.catchTag("AppV2.NotFoundError", () => notFound(ctx.params.id)))
          return yield* response(Effect.succeed(info))
        }),
      )
      .handle(
        "app.ticket",
        Effect.fn(function* (ctx) {
          const apps = yield* AppV2.Service
          yield* apps
            .get(ctx.params.id)
            .pipe(Effect.catchTag("AppV2.NotFoundError", () => notFound(ctx.params.id)))
          return yield* response(
            tickets.issue({ appID: ctx.params.id, ...(yield* ticketScope) }),
          )
        }),
      )
      .handleRaw(
        "app.asset",
        Effect.fn("AppHandler.asset")(function* (ctx) {
          const apps = yield* AppV2.Service
          const id = ctx.params.id
          const name = appAssetCookieName(id)
          const scope = { appID: id, ...(yield* ticketScope) }
          const url = new URL(ctx.request.url, "http://localhost")

          const ticket = url.searchParams.get(APP_TICKET_QUERY)
          if (ticket !== null) {
            const valid = yield* tickets.consume({ ...scope, ticket })
            if (!valid) return HttpServerResponse.empty({ status: 401 })
            const session = yield* tickets.session.issue(scope)
            url.searchParams.delete(APP_TICKET_QUERY)
            const local =
              url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
            const redirect = HttpServerResponse.redirect(url.pathname + url.search, { status: 302 })
            return HttpServerResponse.setCookieUnsafe(redirect, name, session.token, {
              path: `/api/app/${id}/`,
              httpOnly: true,
              sameSite: local ? "lax" : "none",
              secure: !local,
            })
          }

          const token = cookieToken(ctx.request.headers.cookie, name)
          if (!token || !(yield* tickets.session.verify({ ...scope, token })))
            return HttpServerResponse.empty({ status: 401 })

          const prefix = `/api/app/${id}/web`
          const splat = url.pathname.startsWith(prefix + "/") ? url.pathname.slice(prefix.length + 1) : ""
          const info = yield* apps.get(id).pipe(Effect.catchTag("AppV2.NotFoundError", () => Effect.succeed(undefined)))
          if (!info) return HttpServerResponse.empty({ status: 404 })
          const resolved = yield* apps.asset(id, splat).pipe(
            Effect.catchTags({
              "AppV2.NotFoundError": () => Effect.succeed(undefined),
              "AppV2.AssetError": () => Effect.succeed(undefined),
            }),
          )
          if (!resolved) return HttpServerResponse.empty({ status: 404 })
          const body = yield* resolved.read.pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!body) return HttpServerResponse.empty({ status: 404 })

          const headers: Record<string, string> = {}
          if (resolved.mime === "text/html") {
            headers["content-security-policy"] = csp(info.manifest.ui?.csp)
            const policy = permissionsPolicy(info.manifest.ui?.permissions)
            if (policy) headers["permissions-policy"] = policy
            headers["cache-control"] = "no-cache"
          } else {
            headers["cache-control"] = HASHED_ASSET.test(path.basename(resolved.path))
              ? "public, max-age=31536000, immutable"
              : "no-cache"
          }
          return HttpServerResponse.uint8Array(body, {
            status: 200,
            contentType: resolved.mime,
            headers,
          })
        }),
      )
  }),
)
