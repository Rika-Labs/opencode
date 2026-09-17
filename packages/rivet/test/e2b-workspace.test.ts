import { describe, expect, test } from "bun:test"
import { Workspace } from "@opencode/schema/workspace"
import { Context, Effect, Exit, Scope, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AdapterKit, LifecyclePolicy, Sandbox, SandboxLease, SandboxReference } from "effect-sandbox"
import { ProcessSignals } from "effect-sandbox/capabilities/ProcessSignals"
import { NotFoundError, TransportError } from "effect-sandbox/SandboxError"
import { TestSandbox } from "effect-sandbox/testing"
import { E2BWorkspace } from "../src/e2b-workspace.ts"

// Real credential-free TestSandbox leases behind a deterministic provider port.
// TestSandbox simulates execution only; none of these tests qualify live E2B.
function fixture() {
  const harness = TestSandbox.make({ commands: [] })
  const records = new Map<string, SandboxReference.SandboxReference>()
  const calls = { created: 0, connected: 0, paused: 0, destroyed: 0 }
  const reference = Effect.runSync(AdapterKit.decodeReference(
    "e2b", AdapterKit.makeOwner("e2b", { account: "test-account" }), "sandbox-test",
  ))
  const lease = Effect.gen(function* () {
    const acquired = yield* harness.profile(LifecyclePolicy.persistent("keep", 60_000)).acquire
    const original = Context.get(acquired.bundle.context, Sandbox.Sandbox)
    const binding = { ...acquired.binding, sandbox: reference }
    const sandbox = { ...original, binding, files: { ...original.files, binding } }
    const bundle = yield* SandboxLease.add(SandboxLease.empty(binding), Sandbox.Sandbox, sandbox)
    const withSignals = yield* SandboxLease.add(bundle, ProcessSignals, { binding, send: () => Effect.void })
    return { ...acquired, binding, bundle: withSignals }
  })
  const client: E2BWorkspace.Client = {
    provider: "e2b",
    config: { account: "test-account" },
    create: (_, request) => Effect.gen(function* () {
      calls.created++
      records.set(request.operationId, reference)
      return yield* lease
    }),
    connect: () => Effect.gen(function* () {
      if (!records.size) return yield* Effect.fail(new NotFoundError({ operation: "test.connect" }))
      calls.connected++
      return yield* lease
    }),
    reconcile: (id) => Effect.sync(() => {
      const reference = records.get(id)
      return reference ? { _tag: "acquired" as const, reference } : { _tag: "absent" as const }
    }),
    inspect: () => Effect.fail(new TransportError({ operation: "test.inspect" })),
    list: () => Effect.succeed({ items: [], nextCursor: null }),
    destroy: () => Effect.sync(() => { calls.destroyed++; records.clear() }),
    pause: () => Effect.sync(() => { calls.paused++ }),
  }
  const mutex = Semaphore.makeUnsafe(1)
  const options: E2BWorkspace.Options = {
    namespace: "fixture",
    // A local mutex is sufficient only for this single-process test fixture.
    exclusive: (_, effect) => mutex.withPermits(1)(effect),
  }
  return { client, options, calls, harness, driver: E2BWorkspace.make(client, options) }
}

const connect = (driver: ReturnType<typeof E2BWorkspace.make>, workspaceID: Workspace.ID) => Effect.gen(function* () {
  const created = yield* driver.create({ workspaceID })
  return yield* driver.connect({ workspaceID, binding: created.binding, saveBinding: () => Effect.void })
})

describe("E2BWorkspace", () => {
  test("stable operation stamp adopts across driver reconstruction and concurrent calls", async () => {
    const f = fixture()
    const workspaceID = Workspace.ID.create()
    const first = await Effect.runPromise(f.driver.create({ workspaceID }))
    const second = E2BWorkspace.make(f.client, f.options)
    const results = await Effect.runPromise(Effect.all([
      f.driver.create({ workspaceID }), second.create({ workspaceID }),
    ], { concurrency: "unbounded" }))
    expect(results).toEqual([first, first])
    expect(f.calls.created).toBe(1)
    expect(f.harness.counters().released).toBe(1)
    expect(f.harness.counters().destroyed).toBe(0)
  })

  test("indeterminate acquisition refuses to create or destroy", async () => {
    const f = fixture()
    const driver = E2BWorkspace.make({
      ...f.client,
      reconcile: () => Effect.succeed({ _tag: "indeterminate", reason: "multiple matches" }),
    }, f.options)
    const workspaceID = Workspace.ID.create()
    expect(Exit.isFailure(await Effect.runPromiseExit(driver.create({ workspaceID })))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(driver.destroy({ workspaceID, binding: null })))).toBe(true)
    expect(f.calls.created).toBe(0)
    expect(f.calls.destroyed).toBe(0)
  })

  test("connect rejects a binding belonging to another workspace", async () => {
    const f = fixture()
    const created = await Effect.runPromise(f.driver.create({ workspaceID: Workspace.ID.create() }))
    const result = await Effect.runPromiseExit(Effect.scoped(f.driver.connect({
      workspaceID: Workspace.ID.create(), binding: created.binding, saveBinding: () => Effect.void,
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.calls.connected).toBe(0)
  })

  test("connect rejects a binding from another namespace", async () => {
    const f = fixture()
    const workspaceID = Workspace.ID.create()
    const created = await Effect.runPromise(f.driver.create({ workspaceID }))
    const other = E2BWorkspace.make(f.client, { ...f.options, namespace: "other" })
    const result = await Effect.runPromiseExit(Effect.scoped(other.connect({
      workspaceID, binding: created.binding, saveBinding: () => Effect.void,
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.calls.connected).toBe(0)
  })

  test("connect rejects provider ownership mismatch", async () => {
    const f = fixture()
    const workspaceID = Workspace.ID.create()
    const created = await Effect.runPromise(f.driver.create({ workspaceID }))
    const other = E2BWorkspace.make({ ...f.client, config: { account: "other-account" } }, f.options)
    const result = await Effect.runPromiseExit(Effect.scoped(other.connect({
      workspaceID, binding: created.binding, saveBinding: () => Effect.void,
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.calls.connected).toBe(0)
  })

  test("scoped writes succeed and reject filesystem and spawner use after scope close", async () => {
    const f = fixture()
    const scope = Effect.runSync(Scope.make())
    const environment = await Effect.runPromise(connect(f.driver, Workspace.ID.create()).pipe(
      Effect.provideService(Scope.Scope, scope),
    ))
    const files = environment.overrides
    if (!files) throw new Error("Missing remote filesystem override")
    await Effect.runPromise(files.write("/workspace/binary", new Uint8Array([0, 255, 128])))
    // TestSandbox stat omits mtimeMs, so the driver's completeness check
    // rejects reads here; byte-exact round-trip is qualified by the live test.
    expect(Exit.isFailure(await Effect.runPromiseExit(files.read("/workspace/binary")))).toBe(true)
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    expect(Exit.isFailure(await Effect.runPromiseExit(files.write("/workspace/closed", new Uint8Array())))).toBe(true)
    expect(Exit.isFailure(
      await Effect.runPromiseExit(environment.spawner.spawn(ChildProcess.make("echo", ["closed"]))),
    )).toBe(true)
    expect(f.harness.counters().released).toBe(2)
  })

  test("destroy without binding reconciles; absence succeeds; transport failures propagate", async () => {
    const f = fixture()
    const workspaceID = Workspace.ID.create()
    await Effect.runPromise(f.driver.destroy({ workspaceID, binding: null }))
    expect(f.calls.destroyed).toBe(0)
    const created = await Effect.runPromise(f.driver.create({ workspaceID }))
    const failing = E2BWorkspace.make({
      ...f.client, destroy: () => Effect.fail(new TransportError({ operation: "test.destroy" })),
    }, f.options)
    expect(Exit.isFailure(await Effect.runPromiseExit(failing.destroy({ workspaceID, binding: created.binding })))).toBe(true)
    await Effect.runPromise(f.driver.destroy({ workspaceID, binding: null }))
    expect(f.calls.destroyed).toBe(1)
  })

  test("idle suspend calls provider pause rather than detach or destroy", async () => {
    const f = fixture()
    const workspaceID = Workspace.ID.create()
    const created = await Effect.runPromise(f.driver.create({ workspaceID }))
    await Effect.runPromise(f.driver.suspendForIdle({ workspaceID, binding: created.binding, saveBinding: () => Effect.void }))
    expect(f.calls.paused).toBe(1)
    expect(f.calls.connected).toBe(0)
    expect(f.calls.destroyed).toBe(0)
  })

  test("spawner rejects piped command trees instead of falling back to local execution", async () => {
    const f = fixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const environment = yield* connect(f.driver, Workspace.ID.create())
      return yield* Effect.exit(environment.spawner.spawn(ChildProcess.make("echo", ["hello"]).pipe(
        ChildProcess.pipeTo(ChildProcess.make("cat")),
      )))
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(f.harness.counters().launched).toBe(0)
  })
})
