import path from "path"
import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer, Option } from "effect"
import { App } from "@opencode-ai/schema/app"
import { AppHost } from "@opencode-ai/core/app-host"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function info(directory: AbsolutePath, web = true): App.Info {
  return {
    manifest: App.Manifest.make({
      id: App.ID.make("app_calc"),
      name: "Calculator",
      version: "1.0.0",
      web: web ? { root: RelativePath.make("web"), entry: RelativePath.make("index.html") } : undefined,
    }),
    directory,
    hasWeb: web,
    status: { status: "active" },
  }
}

function hostLayer(directory: AbsolutePath) {
  return AppNodeBuilder.build(AppHost.node, [
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
  ])
}

describe("AppHost", () => {
  it.effect("local publish returns a release for the served web root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const host = yield* AppHost.Service
          const first = yield* host.publish(
            info(directory),
            AbsolutePath.make(path.join(tmp.path, "web")),
          )
          const second = yield* host.publish(
            info(directory),
            AbsolutePath.make(path.join(tmp.path, "web")),
          )
          expect(first.id as string).toMatch(/^rel_/)
          expect(second.id).not.toBe(first.id)
          expect(first.app as string).toBe("app_calc")
          expect(first.url).toBe("/api/app/app_calc/web/")
          expect(typeof DateTime.toEpochMillis(first.created)).toBe("number")
        }).pipe(Effect.provide(hostLayer(AbsolutePath.make(tmp.path)))),
      ),
    ),
  )

  it.effect("url resolves the release and fails after the release is retired", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const host = yield* AppHost.Service
          const release = yield* host.publish(
            info(directory),
            AbsolutePath.make(path.join(tmp.path, "web")),
          )
          const resolved = yield* host.url(release)
          expect(resolved.pathname).toBe("/api/app/app_calc/web/")
          yield* host.retire(release)
          const exit = yield* host.url(release).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause)
            expect(Option.isSome(failure) && failure.value._tag === "AppHost.Error").toBe(true)
          }
          const next = yield* host.publish(
            info(directory),
            AbsolutePath.make(path.join(tmp.path, "web")),
          )
          expect(next.id).not.toBe(release.id)
          expect((yield* host.url(next)).pathname).toBe("/api/app/app_calc/web/")
        }).pipe(Effect.provide(hostLayer(AbsolutePath.make(tmp.path)))),
      ),
    ),
  )

  it.effect("publish fails for an app without a web build", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const host = yield* AppHost.Service
          const exit = yield* host
            .publish(info(directory, false), AbsolutePath.make(path.join(tmp.path, "web")))
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }).pipe(Effect.provide(hostLayer(AbsolutePath.make(tmp.path)))),
      ),
    ),
  )

  it.effect("publish fails when the build escapes the app directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const host = yield* AppHost.Service
          const exit = yield* host
            .publish(info(directory), AbsolutePath.make(path.join(tmp.path, "..", "elsewhere")))
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }).pipe(Effect.provide(hostLayer(AbsolutePath.make(tmp.path)))),
      ),
    ),
  )
})
