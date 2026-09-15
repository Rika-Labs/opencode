import assert from "node:assert/strict"
import { test } from "node:test"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { make } from "../src/actor-process.ts"

const command = ChildProcess.make("sleep", ["10"])

const actor = (overrides: Partial<Parameters<typeof make>[0]> = {}) => ({
  CommandEpoch: () => Effect.succeed("epoch"),
  StartCommand: ({ id }: { readonly id: string }) => Effect.succeed({ id }),
  CommandStatus: () => Effect.never,
  CancelCommand: () => Effect.succeed({ status: "cancelled" as const }),
  ...overrides,
})

const failure = (process: AppProcess.Interface, signal?: AbortSignal) =>
  Effect.runPromise(process.run(command, { signal })).then(
    () => assert.fail("command unexpectedly completed"),
    (error: unknown) => error,
  )

test("cancels an accepted command when the start response is lost", async () => {
  const events: string[] = []
  const process = make(actor({
    StartCommand: () => Effect.suspend(() => {
      events.push("accepted")
      return Effect.fail(new Error("start response lost"))
    }),
    CancelCommand: () => Effect.sync(() => {
      events.push("cancelled")
      return { status: "cancelled" as const }
    }),
  }))

  assert.match(String(await failure(process)), /start response lost/)
  assert.deepEqual(events, ["accepted", "cancelled"])
})

test("cancels ownership when command status polling fails", async () => {
  const events: string[] = []
  const process = make(actor({
    StartCommand: ({ id }) => Effect.sync(() => {
      events.push("accepted")
      return { id }
    }),
    CommandStatus: () => Effect.suspend(() => {
      events.push("poll failed")
      return Effect.fail(new Error("status unavailable"))
    }),
    CancelCommand: () => Effect.sync(() => {
      events.push("cancelled")
      return { status: "cancelled" as const }
    }),
  }))

  assert.match(String(await failure(process)), /status unavailable/)
  assert.deepEqual(events, ["accepted", "poll failed", "cancelled"])
})

test("propagates cancellation failure instead of confirming cleanup", async () => {
  const process = make(actor({
    StartCommand: () => Effect.fail(new Error("start response lost")),
    CancelCommand: () => Effect.fail(new Error("cancellation unavailable")),
  }))

  const error = await failure(process)
  assert.match(String(error), /cancellation unavailable/)
  assert.doesNotMatch(String(error), /start response lost/)
})

test("an already-aborted run never dispatches or cancels a command", async () => {
  const events: string[] = []
  const controller = new AbortController()
  controller.abort(new Error("stopped before dispatch"))
  const process = make(actor({
    StartCommand: ({ id }) => Effect.sync(() => {
      events.push("accepted")
      return { id }
    }),
    CancelCommand: () => Effect.sync(() => {
      events.push("cancelled")
      return { status: "cancelled" as const }
    }),
  }))

  assert.match(String(await failure(process, controller.signal)), /stopped before dispatch/)
  assert.deepEqual(events, [])
})

test("aborting after dispatch waits for affirmative cancellation", async () => {
  const events: string[] = []
  const controller = new AbortController()
  const process = make(actor({
    StartCommand: ({ id }) => Effect.sync(() => {
      events.push("accepted")
      queueMicrotask(() => controller.abort(new Error("stopped after dispatch")))
      return { id }
    }),
    CancelCommand: () => Effect.promise(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      events.push("cancelled")
      return { status: "cancelled" as const }
    }),
  }))

  assert.match(String(await failure(process, controller.signal)), /stopped after dispatch/)
  assert.deepEqual(events, ["accepted", "cancelled"])
})

test("an interrupted command propagates cancellation failure", async () => {
  const controller = new AbortController()
  const process = make(actor({
    StartCommand: ({ id }) => Effect.sync(() => {
      queueMicrotask(() => controller.abort())
      return { id }
    }),
    CancelCommand: () => Effect.fail(new Error("interrupt cancellation unavailable")),
  }))

  assert.match(String(await failure(process, controller.signal)), /interrupt cancellation unavailable/)
})
