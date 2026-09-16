#!/usr/bin/env bun
import { $ } from "bun"
import { mkdir, rm, cp, readFile, writeFile, readdir, stat } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const version = process.env.OPENCODE_VERSION ?? "1.18.30-rika.4"
const channel = process.env.OPENCODE_CHANNEL ?? "next"
const publish = process.argv.includes("--publish")
const destRoot = join(root, "dist", "libs")

const packages = [
  { from: "packages/schema", name: "schema" },
  { from: "packages/protocol", name: "protocol" },
  { from: "packages/sdk/js", name: "sdk" },
  { from: "packages/plugin", name: "plugin" },
  { from: "packages/http-recorder", name: "http-recorder" },
  { from: "packages/httpapi-codegen", name: "httpapi-codegen" },
  { from: "packages/llm", name: "llm" },
  { from: "packages/effect-sqlite-node", name: "effect-sqlite-node" },
  { from: "packages/effect-drizzle-sqlite", name: "effect-drizzle-sqlite" },
  { from: "packages/core", name: "core" },
  { from: "packages/server", name: "server" },
  { from: "packages/client", name: "client" },
  { from: "packages/sdk-next", name: "sdk-next" },
  { from: "packages/rivet", name: "rivet" },
  { from: "packages/apps-host", name: "apps-host" },
] as const

const remap = new Map(packages.map((item) => [`@opencode-ai/${item.name}`, `@rikalabs/${item.name}`]))
const fileVersions: Record<string, string> = {
  "effect-sandbox": "0.1.0",
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  workspaces?: { catalog?: Record<string, string> }
}
const catalog = rootPackage.workspaces?.catalog ?? {}

function rewriteText(value: string) {
  let next = value
  for (const [from, to] of remap) {
    next = next.split(from).join(to)
  }
  return next
}

function rewriteDependencyMap(value: Record<string, string> | undefined) {
  if (!value) return value
  const next: Record<string, string> = {}
  for (const [name, spec] of Object.entries(value)) {
    const mapped = remap.get(name) ?? name
    if (spec === "workspace:*") {
      next[mapped] = version
      continue
    }
    if (spec === "catalog:") {
      const resolved = catalog[name]
      if (!resolved) throw new Error(`unresolved catalog dependency ${name}`)
      next[mapped] = resolved
      continue
    }
    if (spec.startsWith("file:")) {
      const resolved = fileVersions[mapped]
      if (!resolved) throw new Error(`unresolved file dependency ${mapped} ${spec}`)
      next[mapped] = resolved
      continue
    }
    next[mapped] = spec
  }
  return next
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory)
  const files: string[] = []
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue
    const path = join(directory, entry)
    const info = await stat(path)
    if (info.isDirectory()) files.push(...(await walk(path)))
    else files.push(path)
  }
  return files
}

await rm(destRoot, { recursive: true, force: true })
await mkdir(destRoot, { recursive: true })

for (const item of packages) {
  const source = join(root, item.from)
  const dest = join(destRoot, item.name)
  await mkdir(dirname(dest), { recursive: true })
  await cp(source, dest, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.includes("/dist/") && !path.endsWith(".tgz"),
  })
  const manifestPath = join(dest, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
  manifest.name = `@rikalabs/${item.name}`
  manifest.version = version
  manifest.private = false
  manifest.files = ["src", "package.json", "README.md"]
  delete manifest.bin
  delete manifest.overrides
  delete manifest["$schema"]
  manifest.publishConfig = { access: "public" }
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    const current = manifest[key]
    if (current && typeof current === "object") {
      manifest[key] = rewriteDependencyMap(current as Record<string, string>)
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const file of await walk(dest)) {
    if (!/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(file)) continue
    if (file.endsWith("package.json")) continue
    const raw = await readFile(file, "utf8")
    const rewritten = rewriteText(raw)
    if (rewritten !== raw) await writeFile(file, rewritten)
  }
  console.log(`packed ${relative(root, dest)} -> @rikalabs/${item.name}@${version}`)
}

if (publish) {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error("NODE_AUTH_TOKEN is required to publish")
  for (const item of packages) {
    const dest = join(destRoot, item.name)
    const name = `@rikalabs/${item.name}`
    const result = await $`npm publish --access public --tag ${channel}`.cwd(dest).nothrow()
    const output = `${result.stdout}${result.stderr}`
    if (result.exitCode === 0 || output.includes("cannot publish over the previously published versions")) {
      const access = await $`npm access set status=public ${name}`.nothrow()
      if (access.exitCode !== 0) {
        const accessOutput = `${access.stdout}${access.stderr}`
        if (!accessOutput.includes("already") && !accessOutput.includes("Status: public")) {
          throw new Error(`failed to make ${name} public\n${accessOutput}`)
        }
      }
      console.log(`${result.exitCode === 0 ? "published" : "already published"} ${name}@${version}`)
      continue
    }
    throw new Error(`failed to publish ${name}@${version}\n${output}`)
  }
}
