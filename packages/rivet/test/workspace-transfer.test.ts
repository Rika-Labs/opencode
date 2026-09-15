import assert from "node:assert/strict"
import { chmod, lstat, lutimes, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { archiveWorkspace, extractWorkspace, validateArchive } from "../src/workspace-transfer.ts"

test("workspace transfer preserves binary data, modes, links, and dot directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-transfer-test-"))
  try {
    const source = join(root, "source")
    const destination = join(root, "destination")
    await mkdir(join(source, ".git", "objects"), { recursive: true })
    await writeFile(join(source, ".git", "objects", "binary"), Buffer.from([0, 1, 255]))
    await chmod(join(source, ".git", "objects", "binary"), 0o751)
    await symlink(".git/objects/binary", join(source, "binary.link"))
    await lutimes(join(source, "binary.link"), 1_700_000_000, 1_700_000_001)
    await extractWorkspace(await archiveWorkspace(source), destination)
    assert.deepEqual(await readFile(join(destination, ".git", "objects", "binary")), Buffer.from([0, 1, 255]))
    assert.equal((await lstat(join(destination, ".git", "objects", "binary"))).mode & 0o777, 0o751)
    assert.equal(await readlink(join(destination, "binary.link")), ".git/objects/binary")
    assert.equal((await lstat(join(destination, "binary.link"))).mtimeMs, 1_700_000_001_000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace transfer rejects malformed and truncated archives without retaining destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-transfer-invalid-"))
  try {
    const malformed = Buffer.from("not a tar archive")
    await assert.rejects(validateArchive(malformed))
    await assert.rejects(extractWorkspace(malformed, join(root, "destination")))
    await assert.rejects(lstat(join(root, "destination")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
