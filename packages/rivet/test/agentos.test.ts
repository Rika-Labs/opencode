import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { Effect, Fiber } from "effect"
import { AgentOS } from "../src/agentos.ts"

test("commands execute in agentOS with durable workspace files and bounded output", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  const options = { directory, database: join(root, "vm.sqlite") }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vm = yield* AgentOS.open(options)
          const result = yield* vm.run({
            command: "sh",
            args: ["-c", "printf durable > result.txt; printf abcdefgh; printf error >&2; exit 7"],
            timeoutMs: 5000,
            maxOutputBytes: 5,
          })
          assert.equal(result.exitCode, 7)
          assert.equal(result.stdout.toString(), "abcde")
          assert.equal(result.stdout.length + result.stderr.length, 5)
          assert.equal(result.truncated, true)
        }),
      ),
    )
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "durable")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vm = yield* AgentOS.open(options)
          const result = yield* vm.run({ command: "cat", args: ["result.txt"], timeoutMs: 5000, maxOutputBytes: 100 })
          assert.equal(result.stdout.toString(), "durable")
          assert.equal(result.truncated, false)
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("interrupting a command reaps its process before releasing the VM", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-interrupt-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vm = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") })
          const fiber = yield* vm
            .run({
              command: "sh",
              args: ["-c", "printf ready > started; sleep 1; printf leaked > leaked"],
              timeoutMs: 5000,
              maxOutputBytes: 100,
            })
            .pipe(Effect.forkChild)
          yield* Effect.promise(async (signal) => {
            while (!existsSync(join(directory, "started"))) {
              signal.throwIfAborted()
              await setTimeout(10, undefined, { signal })
            }
          }).pipe(Effect.timeout("3 seconds"))
          yield* Fiber.interrupt(fiber)
          yield* Effect.sleep("1500 millis")
          assert.equal(existsSync(join(directory, "leaked")), false)
          const result = yield* vm.run({
            command: "printf",
            args: ["still usable"],
            timeoutMs: 5000,
            maxOutputBytes: 100,
          })
          assert.equal(result.stdout.toString(), "still usable")
        }),
      ).pipe(Effect.timeout("10 seconds")),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace mount cannot follow symlinks into private host storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-isolation-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  await writeFile(join(root, "private.txt"), "host-only-canary")
  await symlink("../private.txt", join(directory, "escape"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vm = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") })
          const result = yield* vm.run({ command: "cat", args: ["escape"], timeoutMs: 5000, maxOutputBytes: 100 })
          assert.ok(!result.stdout.toString().includes("host-only-canary"))
          assert.notEqual(result.exitCode, 0)
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stdin reaches EOF and deadlines stop delayed writes before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-timeout-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vm = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") })
          const eof = yield* vm.run({ command: "cat", timeoutMs: 5000, maxOutputBytes: 0 })
          assert.equal(eof.exitCode, 0)
          assert.equal(eof.stdout.length, 0)
          const timed = yield* vm
            .run({
              command: "sh",
              args: ["-c", "printf ready > started; sleep 2; printf leaked > leaked"],
              timeoutMs: 500,
              maxOutputBytes: 100,
            })
            .pipe(Effect.flip)
          assert.equal(timed.operation, "timeout")
          assert.equal(yield* Effect.promise(() => readFile(join(directory, "started"), "utf8")), "ready")
          yield* Effect.sleep("2200 millis")
          assert.equal(existsSync(join(directory, "leaked")), false)
          const next = yield* vm.run({ command: "printf", args: ["healthy"], timeoutMs: 1000, maxOutputBytes: 100 })
          assert.equal(next.stdout.toString(), "healthy")
          const invalid = yield* vm
            .run({ command: "printf", timeoutMs: 1000, maxOutputBytes: Infinity })
            .pipe(Effect.flip)
          assert.equal(invalid.operation, "validate")
        }),
      ).pipe(Effect.timeout("10 seconds")),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace stop terminates detached writers and rejects subsequent commands", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-detached-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vm = yield* AgentOS.open({ directory, database: join(root, "vm.sqlite") })
          const result = yield* vm.run({
            command: "node",
            args: [
              "-e",
              'const {spawn}=require("node:child_process"); const child=spawn("sh",["-c","while [ ! -e /workspace/release ]; do sleep 0.01; done; printf ready > /workspace/ready; sleep 2; printf detached > /workspace/detached.txt"],{detached:true,stdio:"ignore"}); child.unref()',
            ],
            timeoutMs: 5000,
            maxOutputBytes: 1000,
          })
          assert.equal(result.exitCode, 0)
          yield* Effect.promise(() => writeFile(join(directory, "release"), "go"))
          yield* Effect.promise(async (signal) => {
            while (!existsSync(join(directory, "ready"))) await setTimeout(10, undefined, { signal })
          }).pipe(Effect.timeout("3 seconds"))
          yield* vm.stop
          yield* Effect.sleep("2500 millis")
          assert.equal(existsSync(join(directory, "detached.txt")), false)
          const stopped = yield* vm.run({ command: "printf", timeoutMs: 1000, maxOutputBytes: 100 }).pipe(Effect.flip)
          assert.equal(stopped.operation, "run")
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stopping one workspace does not stop another workspace's active command", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agentos-independent-"))
  await mkdir(join(root, "one"))
  await mkdir(join(root, "two"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const one = yield* AgentOS.open({ directory: join(root, "one"), database: join(root, "one.sqlite") })
          const two = yield* AgentOS.open({ directory: join(root, "two"), database: join(root, "two.sqlite") })
          const running = yield* two.run({
            command: "sh",
            args: ["-c", "printf started > ready; sleep 1; printf independent > result"],
            timeoutMs: 5000,
            maxOutputBytes: 100,
          }).pipe(Effect.forkChild)
          yield* Effect.promise(async (signal) => {
            while (!existsSync(join(root, "two", "ready"))) await setTimeout(10, undefined, { signal })
          }).pipe(Effect.timeout("3 seconds"))
          yield* one.stop
          assert.equal((yield* Fiber.join(running)).exitCode, 0)
          assert.equal(yield* Effect.promise(() => readFile(join(root, "two", "result"), "utf8")), "independent")
          assert.equal(existsSync(join(root, "one", "result")), false)
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
