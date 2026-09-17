#!/usr/bin/env bun
import { $, Glob } from "bun"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const version = process.env.OPENCODE_VERSION ?? "2.0.5-rika.1"
const channel = process.env.OPENCODE_CHANNEL ?? "next"
const publish = process.argv.includes("--publish")
const dest = join(root, "dist", "rikalabs-opencode")

const specifierRe = /\b(?:from|import|require)\s*\(?\s*["']@opencode\/([a-z0-9-]+)/g

const internals = await (async () => {
  const seen = new Set<string>()
  const queue = ["sdk", "rivet", "cli", "apps-host"]
  const glob = new Glob("**/*.{ts,tsx,mts}")
  while (queue.length > 0) {
    const name = queue.pop()!
    if (seen.has(name)) continue
    seen.add(name)
    const src = join(root, "packages", name, "src")
    if (!existsSync(src)) continue
    for await (const file of glob.scan({ cwd: src })) {
      const text = await readFile(join(src, file), "utf8")
      for (const match of text.matchAll(specifierRe)) queue.push(match[1]!)
    }
  }
  return [...seen].sort()
})()

await rm(dest, { recursive: true, force: true })
await mkdir(join(dest, "src"), { recursive: true })

for (const name of internals) {
  const from = join(root, "packages", name)
  const to = join(dest, "packages", name)
  await cp(join(from, "src"), join(to, "src"), {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes(".turbo"),
  })
  await cp(join(from, "package.json"), join(to, "package.json"))
}

const exportsCache = new Map<string, Record<string, unknown>>()
const exportsOf = async (pkg: string) => {
  const cached = exportsCache.get(pkg)
  if (cached) return cached
  const raw = await readFile(join(dest, "packages", pkg, "package.json"), "utf8")
  const parsed = (JSON.parse(raw) as { exports?: Record<string, unknown> }).exports ?? {}
  exportsCache.set(pkg, parsed)
  return parsed
}

const exportTarget = (value: unknown) => {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const picked = record.import ?? record.default ?? record.types
    if (typeof picked === "string") return picked
  }
  return undefined
}

const resolveSpecifier = async (pkg: string, sub: string | undefined): Promise<string> => {
  const base = `packages/${pkg}`
  const exports = await exportsOf(pkg)
  if (!sub || sub === "/") {
    const dot = exportTarget(exports["."])
    if (dot) return `${base}/${dot.slice(2)}`
    return `${base}/src/${pkg === "core" ? "app" : "index"}.ts`
  }
  const clean = sub.slice(1).replace(/\/$/, "")
  const exact = exportTarget(exports[`./${clean}`])
  if (exact && existsSync(join(dest, base, exact.slice(2)))) return `${base}/${exact.slice(2)}`
  const candidates: string[] = []
  const wildcards = Object.entries(exports)
    .map(([key, value]) => ({ key, target: exportTarget(value) }))
    .filter(
      (entry): entry is { key: string; target: string } =>
        entry.target !== undefined && entry.key.includes("*") && entry.target.includes("*"),
    )
    .filter(({ key }) => {
      const prefix = key.slice(2, key.indexOf("*"))
      const suffix = key.slice(key.indexOf("*") + 1)
      return clean.startsWith(prefix) && clean.endsWith(suffix)
    })
    .sort((a, b) => b.key.indexOf("*") - a.key.indexOf("*"))
  for (const { key, target } of wildcards) {
    const prefix = key.slice(2, key.indexOf("*"))
    const suffix = key.slice(key.indexOf("*") + 1)
    candidates.push(target.slice(2).replace("*", clean.slice(prefix.length, clean.length - suffix.length)))
  }
  candidates.push(
    ...(clean === "package.json"
      ? ["package.json"]
      : [
          `src/${clean}`,
          `src/${clean}.ts`,
          `src/${clean}.tsx`,
          `src/${clean}.mts`,
          `src/${clean}.json`,
          `src/${clean}/index.ts`,
          `src/${clean}/index.tsx`,
        ]),
  )
  for (const candidate of candidates) {
    if (existsSync(join(dest, base, candidate))) return `${base}/${candidate}`
  }
  throw new Error(`Cannot resolve specifier @opencode/${pkg}${sub ?? ""} inside packed sources`)
}

const rewriteRe = /(\b(?:from|import|require)\s*\(?\s*)(["'])@opencode\/([a-z0-9-]+)(\/[^"'\s]*)?["']/g

const rewriteFile = async (file: string) => {
  const text = await readFile(file, "utf8")
  if (!text.includes("@opencode/")) return
  const matches = [...text.matchAll(rewriteRe)]
  if (matches.length === 0) return
  const replacements = await Promise.all(
    matches.map(async (match) => {
      const target = await resolveSpecifier(match[3]!, match[4])
      let rel = relative(dirname(file), join(dest, target))
      if (!rel.startsWith(".")) rel = `./${rel}`
      return {
        start: match.index! + match[1].length + 1,
        end: match.index! + match[0].length - 1,
        rel,
      }
    }),
  )
  let out = ""
  let cursor = 0
  for (const part of replacements) {
    out += text.slice(cursor, part.start) + part.rel
    cursor = part.end
  }
  out += text.slice(cursor)
  await writeFile(file, out)
}

{
  const glob = new Glob("**/*.{ts,tsx,mts}")
  const files: string[] = []
  for await (const file of glob.scan({ cwd: dest })) files.push(join(dest, file))
  for (const file of files) await rewriteFile(file)
}

await writeFile(
  join(dest, "src", "sdk.ts"),
  `export * from "../packages/sdk/src/index.ts"\n`,
)
await writeFile(
  join(dest, "src", "sdk-effect.ts"),
  `export * from "../packages/sdk/src/effect/index.ts"\n`,
)
await writeFile(
  join(dest, "src", "rivet.ts"),
  `export * from "../packages/rivet/src/index.ts"\n`,
)
await writeFile(
  join(dest, "src", "cli.ts"),
  `export * from "../packages/cli/src/run/index.ts"\n`,
)
await writeFile(
  join(dest, "src", "apps-host.ts"),
  `export * from "../packages/apps-host/src/index.ts"\n`,
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
    effect: "4.0.0-rc.112",
    "effect-sandbox": "0.2.0",
    rivetkit: "2.3.17",
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
