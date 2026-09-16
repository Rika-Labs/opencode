import { App } from "@opencode/schema/app"
import { AppTicket } from "@opencode/schema/app-ticket"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { AppNotFoundError, ForbiddenError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const APP_TICKET_QUERY = "ticket"
export const APP_ASSET_COOKIE_PREFIX = "opencode_app_"

const APP_ASSET_PATH = /^\/api\/app\/[^/]+\/web(?:\/|$)/

export function isAppAssetPath(pathname: string) {
  return APP_ASSET_PATH.test(pathname)
}

export function hasAppAssetTicketURL(url: URL) {
  return isAppAssetPath(url.pathname) && url.searchParams.has(APP_TICKET_QUERY)
}

export function appAssetCookieName(id: string) {
  return `${APP_ASSET_COOKIE_PREFIX}${id}`
}

const AssetQuery = Schema.Struct({
  ...LocationQuery.fields,
  ticket: Schema.String.pipe(Schema.optional),
})

export const AppGroup = HttpApiGroup.make("server.app")
  .add(
    HttpApiEndpoint.get("app.list", "/api/app", {
      query: LocationQuery,
      success: Location.response(Schema.Array(App.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.app.list",
          summary: "List apps",
          description: "List installed apps for a location, including failed manifests.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("app.get", "/api/app/:id", {
      params: { id: App.ID },
      query: LocationQuery,
      success: Location.response(App.Info),
      error: AppNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.app.get",
          summary: "Get app",
          description: "Get one installed app by id.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("app.ticket", "/api/app/:id/ticket", {
      params: { id: App.ID },
      query: LocationQuery,
      success: Location.response(AppTicket.Ticket),
      error: [ForbiddenError, AppNotFoundError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.app.ticket",
          summary: "Create app portal ticket",
          description:
            "Create a short-lived single-use ticket for opening the app's web portal. Exchange it via GET /api/app/:id/web/?ticket= to receive a path-scoped session cookie.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("app.asset", "/api/app/:id/web/*", {
      params: { id: App.ID },
      query: AssetQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.app.asset",
          summary: "Serve app web asset",
          description:
            "Serve a static asset from the app's web root. Requires a valid ticket query parameter (exchanged for a session cookie) or the opencode_app_<id> cookie.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "apps",
      description: "Experimental app registry and portal asset routes.",
    }),
  )
