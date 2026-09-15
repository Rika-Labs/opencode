import path from "node:path"
import { AppV2 } from "@opencode-ai/core/app"
import { AppTicket } from "@opencode-ai/core/app/ticket"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppNotFoundError, ForbiddenError } from "@opencode-ai/protocol/errors"
import { APP_TICKET_QUERY, appAssetCookieName } from "@opencode-ai/protocol/groups/app"
import { Effect, Option } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { credentialFromRequest } from "../middleware/authorization"
import { response } from "../location"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory, workspaceID: location.workspaceID }
})

const HASHED_ASSET = /[.-][0-9a-f]{8,}\./

function csp(csp: AppV2.Csp | undefined) {
  const clean = (domains: readonly string[] | undefined) =>
    (domains ?? []).map((domain) => domain.replace(/[\s;'"]/g, "")).filter((domain) => domain.length > 0)
  const resource = clean(csp?.resourceDomains)
  const join = (domains: readonly string[]) => (domains.length ? " " + domains.join(" ") : "")
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${join(resource)}`,
    `style-src 'self' 'unsafe-inline'${join(resource)}`,
    `connect-src 'self'${join(clean(csp?.connectDomains))}`,
    `img-src 'self' data:${join(resource)}`,
    `font-src 'self'${join(resource)}`,
    `media-src 'self' data:${join(resource)}`,
    `frame-src${clean(csp?.frameDomains).length ? join(clean(csp?.frameDomains)) : " 'none'"}`,
    "object-src 'none'",
    `base-uri${clean(csp?.baseUriDomains).length ? join(clean(csp?.baseUriDomains)) : " 'self'"}`,
    "form-action 'self'",
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
    const locations = yield* LocationServiceMap.Service
    const serverAuth = yield* ServerAuth.Config
    const cors = yield* CorsConfig

    const notFound = (id: string) => new AppNotFoundError({ id, message: `App not found: ${id}` })

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
          if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors))
            return yield* new ForbiddenError({ message: "Invalid app ticket request" })
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
          const id = ctx.params.id
          const url = new URL(ctx.request.url, "http://localhost")

          const ticket = url.searchParams.get(APP_TICKET_QUERY)
          if (ticket !== null) {
            const stored = yield* tickets.consume(ticket)
            if (Option.isSome(stored) && stored.value.appID === id) {
              const session = yield* tickets.session.issue(stored.value)
              url.searchParams.delete(APP_TICKET_QUERY)
              const secure = url.protocol === "https:"
              const redirect = HttpServerResponse.setHeader(
                HttpServerResponse.redirect(url.pathname + url.search, { status: 302 }),
                "cache-control",
                "no-store",
              )
              return HttpServerResponse.setCookieUnsafe(redirect, appAssetCookieName(id), session.token, {
                path: `/api/app/${id}/`,
                httpOnly: true,
                sameSite: secure ? "none" : "lax",
                secure,
              })
            }
          }

          const prefix = `/api/app/${id}/web`
          const splat = url.pathname.startsWith(prefix + "/") ? url.pathname.slice(prefix.length + 1) : ""
          const serve = Effect.gen(function* () {
            const apps = yield* AppV2.Service
            const info = yield* apps
              .get(id)
              .pipe(Effect.catchTag("AppV2.NotFoundError", () => Effect.succeed(undefined)))
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
            const headers: Record<string, string> = {
              "cache-control":
                resolved.mime !== "text/html" && HASHED_ASSET.test(path.basename(resolved.path))
                  ? "public, max-age=31536000, immutable"
                  : "no-cache",
            }
            if (resolved.mime === "text/html") {
              headers["content-security-policy"] = csp(info.manifest.ui?.csp)
              const policy = permissionsPolicy(info.manifest.ui?.permissions)
              if (policy) headers["permissions-policy"] = policy
            }
            return HttpServerResponse.uint8Array(body, {
              status: 200,
              contentType: resolved.mime,
              headers,
            })
          })

          const token = cookieToken(ctx.request.headers.cookie, appAssetCookieName(id))
          const scope = token ? yield* tickets.session.verify(token) : Option.none<AppTicket.Scope>()
          if (Option.isSome(scope) && scope.value.appID === id) {
            const ref = Location.Ref.make({
              directory: AbsolutePath.make(scope.value.directory),
              workspaceID: scope.value.workspaceID,
            })
            return yield* serve.pipe(Effect.provide(locations.get(ref)), Effect.orDie)
          }
          const credential = yield* credentialFromRequest(ctx.request)
          if (ServerAuth.required(serverAuth) && ServerAuth.authorized(credential, serverAuth))
            return yield* serve
          return HttpServerResponse.empty({ status: 401 })
        }),
      )
  }),
)
