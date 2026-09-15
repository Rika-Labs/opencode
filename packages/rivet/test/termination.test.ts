import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentOs } from "@rikalabs/agentos-core"
import { StdioSidecarProtocolClient } from "@rikalabs/agentos-runtime-core/native-client"

test("native disposal rejects unconfirmed termination and retains the child for retry", async (t) => {
  const client = StdioSidecarProtocolClient.spawn({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    gracefulExitMs: 10,
    forceExitMs: 10,
  })
  const kill = t.mock.method(client.child, "kill", () => false)
  client.failPermanently(new Error("injected transport failure"))
  try {
    await assert.rejects(client.dispose(), /sidecar termination was not confirmed/)
    assert.equal(client.child.exitCode, null)
    assert.equal(client.child.signalCode, null)
    assert.deepEqual(kill.mock.calls[0].arguments, ["SIGKILL"])
  } finally {
    kill.mock.restore()
    await client.dispose().catch(() => undefined)
    assert.ok(client.child.exitCode !== null || client.child.signalCode !== null)
  }
})

test("explicit sidecar termination propagates failure and preserves ownership for retry", async (t) => {
  const spawn = StdioSidecarProtocolClient.spawn.bind(StdioSidecarProtocolClient)
  const children: StdioSidecarProtocolClient["child"][] = []
  t.mock.method(StdioSidecarProtocolClient, "spawn", (options: Parameters<typeof spawn>[0]) => {
    const client = spawn(options)
    children.push(client.child)
    return client
  })
  const sidecar = await AgentOs.createSidecar()
  const vm = await AgentOs.create({ sidecar: { kind: "explicit", handle: sidecar } })
  assert.equal(children.length, 1)
  const child = children[0]
  const kill = t.mock.method(child, "kill", () => false)
  try {
    await assert.rejects(sidecar.terminate(), /sidecar termination was not confirmed/)
    assert.equal(sidecar.describe().state, "disposing")
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    kill.mock.restore()
    await sidecar.terminate()
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(sidecar.describe().state, "disposed")
    await vm.dispose()
  }
})
