#!/usr/bin/env bun
import { $ } from "bun"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const version = process.env.OPENCODE_VERSION ?? "2.0.5-rika.1"
const channel = process.env.OPENCODE_CHANNEL ?? "next"
const publish = process.argv.includes("--publish")
const dest = join(root, "dist", "rikalabs-opencode")

const internals = [
  "schema",
  "protocol",
  "util",
  "plugin",
  "client",
  "server",
  "core",
  "sdk",
  "cli",
  "rivet",
  "apps-host",
]

await rm(dest, { recursive: true, force: true })
await mkdir(join(dest, "src"), { recursive: true })

for (const name of internals) {
  await cp(join(root, "packages", name), join(dest, "packages", name), {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes(".turbo"),
  })
}

await writeFile(
  join(dest, "src", "sdk.ts"),
  `export * from "@opencode/sdk"\n`,
)
await writeFile(
  join(dest, "src", "sdk-effect.ts"),
  `export * from "@opencode/sdk/effect"\n`,
)
await writeFile(
  join(dest, "src", "rivet.ts"),
  `export * from "@opencode/rivet"\n`,
)
await writeFile(
  join(dest, "src", "cli.ts"),
  `export * from "@opencode/cli/run"\n`,
)
await writeFile(
  join(dest, "src", "apps-host.ts"),
  `export * from "@opencode/apps-host"\n`,
)

const pkg = {
  name: "@rikalabs/opencode",
  version,
  type: "module",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/Rika-Labs/opencode.git",
  },
  publishConfig: { access: "public" },
  exports: {
    "./sdk": "./src/sdk.ts",
    "./sdk/effect": "./src/sdk-effect.ts",
    "./rivet": "./src/rivet.ts",
    "./cli": "./src/cli.ts",
    "./apps-host": "./src/apps-host.ts",
  },
  files: ["src", "packages"],
  dependencies: {
    "@modelcontextprotocol/ext-apps": "1.7.5",
    "@modelcontextprotocol/sdk": "1.29.0",
    "@rivetkit/effect": "2.3.17",
    effect: "4.0.0-rc.112",
    "effect-sandbox": "0.1.0",
    rivetkit: "2.3.17",
  },
  imports: {
    "@opencode/apps-host": "./packages/apps-host/src/index.ts",
    "@opencode/apps-host/*": "./packages/apps-host/src/*.ts",
    "@opencode/cli": "./packages/cli/src/index.ts",
    "@opencode/cli/*": "./packages/cli/src/*.ts",
    "@opencode/client": "./packages/client/src/index.ts",
    "@opencode/client/*": "./packages/client/src/*.ts",
    "@opencode/core": "./packages/core/src/app.ts",
    "@opencode/core/*": "./packages/core/src/*.ts",
    "@opencode/plugin": "./packages/plugin/src/index.ts",
    "@opencode/plugin/*": "./packages/plugin/src/*.ts",
    "@opencode/protocol": "./packages/protocol/src/index.ts",
    "@opencode/protocol/*": "./packages/protocol/src/*.ts",
    "@opencode/rivet": "./packages/rivet/src/index.ts",
    "@opencode/rivet/*": "./packages/rivet/src/*.ts",
    "@opencode/schema": "./packages/schema/src/index.ts",
    "@opencode/schema/*": "./packages/schema/src/*.ts",
    "@opencode/sdk": "./packages/sdk/src/index.ts",
    "@opencode/sdk/*": "./packages/sdk/src/*.ts",
    "@opencode/server": "./packages/server/src/index.ts",
    "@opencode/server/*": "./packages/server/src/*.ts",
    "@opencode/util": "./packages/util/src/index.ts",
    "@opencode/util/*": "./packages/util/src/*.ts",
  },
}

const rootPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  workspaces?: { catalog?: Record<string, string> }
}
const catalog = rootPkg.workspaces?.catalog ?? {}
const extras = new Map<string, string>()
for (const name of internals) {
  const raw = await readFile(join(root, "packages", name, "package.json"), "utf8")
  const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
  for (const [dep, spec] of Object.entries(parsed.dependencies ?? {})) {
    if (dep.startsWith("@opencode/") || spec === "workspace:*") continue
    extras.set(dep, spec === "catalog:" ? catalog[dep] ?? spec : spec)
  }
}
pkg.dependencies = { ...Object.fromEntries(extras), ...pkg.dependencies }

await writeFile(join(dest, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)

if (!publish) {
  console.log(`packed ${dest} as ${pkg.name}@${version}`)
  process.exit(0)
}

const already = (text: string) =>
  text.includes("cannot publish over the previously published versions") ||
  text.includes("You cannot publish over the previously published versions")

const result = await $`npm publish --access public --tag ${channel}`.cwd(dest).nothrow()
if (result.exitCode !== 0 && !already(result.stderr.toString() + result.stdout.toString())) {
  console.error(result.stderr.toString())
  process.exit(result.exitCode)
}

console.log(`published ${pkg.name}@${version}`)
