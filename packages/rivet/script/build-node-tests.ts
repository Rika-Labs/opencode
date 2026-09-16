import { readdir, rm } from "node:fs/promises"
import assert from "node:assert/strict"
import { join } from "node:path"

const outdir = "dist/node-test"

await rm(outdir, { recursive: true, force: true })
const modules = join(process.cwd(), "../..", "node_modules/.bun")
const jsonc = (await readdir(modules)).find((name) => name.startsWith("jsonc-parser@3."))
assert(jsonc, "jsonc-parser is not installed")

const result = await Bun.build({
  entrypoints: (await readdir("test"))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `./test/${file}`),
  outdir,
  target: "node",
  format: "esm",
  naming: { entry: "[name].[ext]" },
  loader: { ".txt": "text" },
  external: ["rivetkit", "@rivetkit/*"],
  plugins: [
    {
      name: "jsonc-parser-esm",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: join(modules, jsonc, "node_modules/jsonc-parser/lib/esm/main.js"),
        }))
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
