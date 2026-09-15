import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { NonNegativeInt, PositiveInt, RelativePath } from "@opencode-ai/core/schema"
import { WorkspaceProvider } from "@opencode-ai/core/workspace-provider"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import fuzzysort from "fuzzysort"
import { posix } from "node:path"

const root = "/workspace"
const maximumOutputBytes = 1024 * 1024

export function make(filesystem: FSUtil.Interface, process: AppProcess.Interface): WorkspaceProvider.Search {
  const failure = (operation: string, cause: unknown, code: WorkspaceProvider.Error["code"] = "failed") =>
    new WorkspaceProvider.Error({ operation, code, message: cause instanceof Error ? cause.message : String(cause), cause })
  const target = (input?: string) => {
    const path = posix.resolve(root, input ?? ".")
    if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`Path escapes workspace: ${input}`)
    return path
  }
  const relative = (path: string) => RelativePath.make(posix.relative(root, path).replaceAll("\\", "/"))
  const entries = (operation: string, path: string) =>
    filesystem.glob("**", { cwd: path, absolute: true, dot: true, include: "all" }).pipe(
      Effect.mapError((cause) => failure(operation, cause)),
      Effect.map((paths) => paths.filter((path) => !posix.relative(root, path).split("/").includes(".git"))),
      Effect.flatMap((paths) =>
        Effect.forEach(paths, (path) =>
          filesystem.stat(path).pipe(
            Effect.map((info) => ({ path, type: info.type === "Directory" ? ("directory" as const) : ("file" as const) })),
            Effect.mapError((cause) => failure(operation, cause)),
          ),
        ),
      ),
    )
  const commandAvailable = (command: string, args: string[]) =>
    process.run(ChildProcess.make(command, args, { cwd: root }), { maxOutputBytes: 4096 }).pipe(
      Effect.map((result) => result.exitCode === 0 && !result.stdoutTruncated && !result.stderrTruncated),
      Effect.catch(() => Effect.succeed(false)),
    )

  return {
    find: (input) =>
      entries("find", root).pipe(
        Effect.map((items) =>
          fuzzysort.go(input.query, items.filter((item) => input.type === undefined || item.type === input.type), {
            key: "path",
            limit: input.limit ?? 50,
          }).map((item) =>
            FileSystem.Entry.make({
              path: RelativePath.make(relative(item.obj.path) + (item.obj.type === "directory" ? "/" : "")),
              type: item.obj.type,
            }),
          ),
        ),
      ),
    glob: (input) =>
      Effect.try({ try: () => target(input.path), catch: (cause) => failure("glob", cause, "invalid_path") }).pipe(
        Effect.flatMap((cwd) =>
          filesystem.glob(input.pattern, { cwd, absolute: true, dot: false, include: "file" }).pipe(
            Effect.mapError((cause) => failure("glob", cause)),
          ),
        ),
        Effect.map((paths) =>
          paths
            .slice(0, input.limit ?? Number.MAX_SAFE_INTEGER)
            .map((path) => FileSystem.Entry.make({ path: relative(path), type: "file" })),
        ),
      ),
    grep: (input) =>
      Effect.try({ try: () => target(input.path), catch: (cause) => failure("grep", cause, "invalid_path") }).pipe(
        Effect.flatMap((path) =>
          commandAvailable("rg", ["--version"]).pipe(
            Effect.flatMap((hasRipgrep) =>
              hasRipgrep
                ? ripgrep(process, input, input.path ?? ".", failure)
                : Effect.fail(failure("grep", new Error("Guest ripgrep is unavailable"), "unsupported")),
            ),
          ),
        ),
      ),
  }
}

function ripgrep(
  process: AppProcess.Interface,
  input: FileSystem.GrepInput,
  path: string,
  failure: (operation: string, cause: unknown, code?: WorkspaceProvider.Error["code"]) => WorkspaceProvider.Error,
) {
  const args = ["--no-config", "--json", "--hidden", "--no-messages"]
  if (input.include) args.push(`--glob=${input.include}`)
  args.push("--glob=!.git/**", "--glob=!**/.git/**")
  args.push("--", input.pattern, path)
  return process.run(ChildProcess.make("rg", args, { cwd: root }), { maxOutputBytes: maximumOutputBytes }).pipe(
    Effect.flatMap((result) => {
      if (result.stdoutTruncated || result.stderrTruncated) {
        return Effect.fail(failure("grep", new Error("Guest ripgrep output exceeded the capture limit")))
      }
      if (result.exitCode === 1) return Effect.succeed([])
      if (result.exitCode !== 0) {
        const message = result.stderr.toString("utf8").trim() || `Guest ripgrep exited with code ${result.exitCode}`
        return Effect.fail(failure("grep", new Error(message)))
      }
      return Effect.forEach(result.stdout.toString("utf8").split("\n"), (line) => decodeMatch(line, failure), {
        concurrency: 1,
      }).pipe(
        Effect.map((matches) =>
          matches.filter((match) => match !== undefined).slice(0, input.limit ?? Number.MAX_SAFE_INTEGER),
        ),
      )
    }),
    Effect.mapError((cause) => cause instanceof WorkspaceProvider.Error ? cause : failure("grep", cause)),
  )
}

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

function decodeMatch(
  line: string,
  failure: (operation: string, cause: unknown, code?: WorkspaceProvider.Error["code"]) => WorkspaceProvider.Error,
) {
  if (!line) return Effect.succeed(undefined)
  return Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: (cause) => failure("grep", new Error("Invalid guest ripgrep JSON output", { cause })),
  }).pipe(
    Effect.flatMap((event) => {
      if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "match") return Effect.succeed(undefined)
      return Schema.decodeUnknownEffect(RawMatch)(event).pipe(
        Effect.mapError((cause) => failure("grep", new Error("Invalid guest ripgrep match output", { cause }))),
      )
    }),
    Effect.map((match) => {
      if (!match) return undefined
      return FileSystem.Match.make({
        entry: FileSystem.Entry.make({
          path: RelativePath.make(
            (posix.isAbsolute(match.data.path.text) ? posix.relative(root, match.data.path.text) : match.data.path.text)
              .replace(/^(?:\.\/)+/, "")
              .replaceAll("\\", "/"),
          ),
          type: "file",
        }),
        line: match.data.line_number,
        offset: match.data.absolute_offset,
        text: match.data.lines.text.length > 2_000 ? `${match.data.lines.text.slice(0, 2_000)}...` : match.data.lines.text,
        submatches: match.data.submatches.slice(0, 100).map((item) => ({ text: item.match.text, start: item.start, end: item.end })),
      })
    }),
  )
}
