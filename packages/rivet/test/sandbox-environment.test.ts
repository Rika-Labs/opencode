import assert from "node:assert/strict"
import { test } from "node:test"
import { guestPathFromHost } from "../src/sandbox-environment.ts"

test("guestPathFromHost maps Darwin /private/var aliases onto /workspace", () => {
  const root = "/var/folders/xx/workspace"
  const realRoot = "/private/var/folders/xx/workspace"
  const aliases = [root, realRoot]
  assert.equal(guestPathFromHost(root, aliases), "/workspace")
  assert.equal(guestPathFromHost(realRoot, aliases), "/workspace")
  assert.equal(guestPathFromHost(`${realRoot}/src/a.ts`, aliases), "/workspace/src/a.ts")
  assert.equal(guestPathFromHost(`${root}/src/a.ts`, aliases), "/workspace/src/a.ts")
  assert.equal(guestPathFromHost("/tmp/other", aliases), "/tmp/other")
})
