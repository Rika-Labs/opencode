import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { make } from "../src/search.ts"

const liveLayer = LayerNode.compile(LayerNode.group([AppProcess.node, FSUtil.node]))

test("searches only the guest filesystem with Core-compatible paths and bounds", async () => {
  const host = await mkdtemp(join(tmpdir(), "opencode-rivet-search-"))
  const workspace = join(host, "workspace")
  await mkdir(join(workspace, "src", "nested"), { recursive: true })
  await mkdir(join(workspace, ".hidden"))
  await mkdir(join(workspace, ".git"))
  await writeFile(join(workspace, "src", "alpha.ts"), "é prefix needle and needle\nsecond needle\n")
  await writeFile(join(workspace, "src", "nested", "beta.ts"), "needle\n")
  await writeFile(join(workspace, "src", "skip.txt"), "needle\n")
  await writeFile(join(workspace, ".hidden", "secret.ts"), "needle\n")
  await writeFile(join(workspace, ".git", "index.ts"), "needle\n")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const local = yield* AppProcess.Service
        const localFilesystem = yield* FSUtil.Service
        const filesystem = FSUtil.Service.of({
          ...localFilesystem,
          glob: (pattern, options) =>
            localFilesystem.glob(pattern, {
              ...options,
              cwd: options?.cwd?.replace(/^\/workspace/, workspace),
            }).pipe(
              Effect.map((paths) =>
                options?.absolute ? paths.map((path) => path.replace(workspace, "/workspace")) : paths,
              ),
            ),
          stat: (path) => localFilesystem.stat(path.replace(/^\/workspace/, workspace)),
        })
        const process = AppProcess.Service.of({
          ...local,
          run: (command, options) => {
            if (command._tag !== "StandardCommand") return local.run(command, options)
            return local
              .run(
                ChildProcess.make(
                  command.command,
                  command.args.map((arg) =>
                    arg === "/workspace" ? workspace : arg.startsWith("/workspace/") ? join(workspace, arg.slice(11)) : arg,
                  ),
                  { ...command.options, cwd: command.options.cwd?.replace(/^\/workspace/, workspace) },
                ),
                options,
              )
              .pipe(Effect.map((result) => ({ ...result, stdout: Buffer.from(result.stdout.toString().replaceAll(workspace, "/workspace")) })))
          },
        })
        const search = make(filesystem, process)

        const found = yield* search.find({ query: "nested" })
        assert(found.some((entry) => entry.path === "src/nested/" && entry.type === "directory"))
        assert(!found.some((entry) => entry.path.startsWith(".git")))

        const globbed = yield* search.glob({ pattern: "**/*.ts", limit: 2 })
        assert.equal(globbed.length, 2)
        assert(globbed.every((entry) => !entry.path.startsWith(".hidden") && !entry.path.startsWith(".git")))

        const matches = yield* search.grep({ pattern: "needle", include: "*.ts", limit: 3 })
        assert.equal(matches.length, 3)
        assert(!matches.some((match) => match.entry.path.startsWith(".git")), JSON.stringify(matches))
        const hidden = yield* search.grep({ pattern: "needle", include: "*.ts" })
        const first = hidden.find((match) => match.entry.path === "src/alpha.ts" && match.line === 1)
        assert(first)
        assert.equal(first.offset, 0)
        assert.deepEqual(first.submatches.map((match) => [match.start, match.end]), [[10, 16], [21, 27]])
        assert(hidden.some((match) => match.entry.path === ".hidden/secret.ts"))
        assert(!hidden.some((match) => match.entry.path.startsWith(".git")))
      }).pipe(Effect.provide(liveLayer)),
    )
  } finally {
    await rm(host, { recursive: true, force: true })
  }
})

test("fails explicitly on malformed guest ripgrep JSON", async () => {
  const host = await mkdtemp(join(tmpdir(), "opencode-rivet-search-json-"))
  const workspace = join(host, "workspace")
  await mkdir(workspace)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const local = yield* AppProcess.Service
        const filesystem = yield* FSUtil.Service
        const process = AppProcess.Service.of({
          ...local,
          run: (command, options) =>
            command._tag === "StandardCommand" && command.args.includes("--json")
              ? Effect.succeed({
                  command: "rg",
                  exitCode: 0,
                  stdout: Buffer.from("not-json\n"),
                  stderr: Buffer.alloc(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : command._tag === "StandardCommand"
                ? local.run(ChildProcess.make(command.command, command.args, { ...command.options, cwd: workspace }), options)
                : local.run(command, options),
        })
        const error = yield* make(filesystem, process)
          .grep({ pattern: "needle" })
          .pipe(Effect.flip)
        assert.match(error.message, /Invalid guest ripgrep JSON output/)
      }).pipe(Effect.provide(liveLayer)),
    )
  } finally {
    await rm(host, { recursive: true, force: true })
  }
})
