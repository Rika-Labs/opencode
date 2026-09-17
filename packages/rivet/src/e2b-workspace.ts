export * as E2BWorkspace from "./e2b-workspace.ts"

import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { Failed, NotFound, WrongKind, type FilesImpl } from "@opencode/core/environment/files"
import { Context, Effect, Layer, Scope } from "effect"
import { AdapterKit, LifecyclePolicy, Sandbox, SandboxProvider, SandboxReference } from "effect-sandbox"
import * as ChildProcessBridge from "effect-sandbox/ChildProcessBridge"
import { ProcessSignals } from "effect-sandbox/capabilities/ProcessSignals"
import type { Service } from "effect-sandbox/e2b/E2BClient"
import type { Config, CreateOptions } from "effect-sandbox/e2b/E2BConfig"
import { createHash } from "node:crypto"
import { posix } from "node:path"

export interface Client extends SandboxProvider.Driver<CreateOptions, Sandbox.Sandbox | ProcessSignals> {
  readonly config: Service["config"]
  readonly pause: Service["pause"]
}

export const DEFAULT_ROOT = "/workspace"

export interface Options {
  readonly namespace: string
  readonly template?: string
  readonly timeoutMs?: number
  readonly root?: string
  /** Serialize across every owner of this namespace, including recovery. Metadata lookup is not atomic allocation. */
  readonly exclusive: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const create = Effect.fn("E2BWorkspace.create")(function* (options: Options & { readonly config?: Config }) {
  const { E2BClient, layer } = yield* Effect.promise(() => import("effect-sandbox/e2b/E2BClient"))
  const context = yield* Layer.build(layer(options.config))
  return make(Context.get(context, E2BClient), options)
})

export function make(client: Client, options: Options): WorkspaceDriver.Interface {
  const owner = AdapterKit.makeOwner("e2b", client.config)
  const identity = Effect.fn("E2BWorkspace.identity")(function* (workspaceID: string) {
    if (!options.namespace.trim()) return yield* failure("A stable nonempty namespace is required")
    const result = SandboxReference.id<"Operation">(
      `opencode-${createHash("sha256").update(JSON.stringify([owner, options.namespace, workspaceID])).digest("hex")}`,
    )
    if (!result.ok) return yield* failure("Invalid workspace operation identity")
    return result.value
  })
  const bindingOf = (workspaceID: string, reference: SandboxReference.SandboxReference): WorkspaceDriver.Binding => ({
    version: 1, workspaceID, namespace: options.namespace,
    reference: { ...reference, owner: { ...reference.owner } },
  })
  const referenceOf = Effect.fn("E2BWorkspace.referenceOf")(function* (workspaceID: string, binding: WorkspaceDriver.Binding) {
    if (binding.version !== 1 || binding.workspaceID !== workspaceID || binding.namespace !== options.namespace)
      return yield* failure("E2B binding belongs to a different workspace or namespace")
    const reference = SandboxReference.decode(binding.reference)
    if (!reference.ok || !SandboxReference.sameOwner(reference.value.owner, owner))
      return yield* failure("Invalid E2B reference or provider ownership mismatch")
    return reference.value
  })
  const reconcile = Effect.fn("E2BWorkspace.reconcile")(function* (id: SandboxReference.OperationId) {
    const result = yield* client.reconcile(id)
    if (result._tag === "indeterminate") return yield* failure("E2B acquisition is indeterminate; refusing to allocate or guess")
    if (result._tag === "absent") return undefined
    if (!SandboxReference.sameOwner(result.reference.owner, owner)) return yield* failure("Reconciled E2B owner mismatch")
    return result.reference
  })
  const exclusive = <A, E, R>(workspaceID: string, effect: Effect.Effect<A, E, R>) =>
    identity(workspaceID).pipe(
      Effect.flatMap((id) => options.exclusive(id, effect)),
      Effect.mapError((cause) => new WorkspaceDriver.Error({ message: "E2B workspace operation failed", cause })),
    )
  return WorkspaceDriver.make({
    create: ({ workspaceID }) => exclusive(workspaceID, Effect.scoped(Effect.gen(function* () {
      const id = yield* identity(workspaceID)
      const existing = yield* reconcile(id)
      if (existing) return { binding: bindingOf(workspaceID, existing) }
      const request = yield* SandboxProvider.makeRequest({
        operationId: id, resources: {}, metadata: {},
        lifecycle: LifecyclePolicy.persistent("keep", options.timeoutMs ?? 300_000),
      })
      const lease = yield* client.create({ secure: true, template: options.template, timeoutMs: options.timeoutMs ?? 300_000 }, request)
      if (!SandboxReference.sameOwner(lease.binding.sandbox.owner, owner)) return yield* failure("Created E2B owner mismatch")
      return { binding: bindingOf(workspaceID, lease.binding.sandbox) }
    }))),
    connect: ({ workspaceID, binding }) => Effect.gen(function* () {
      const reference = yield* referenceOf(workspaceID, binding)
      const lease = yield* client.connect(reference)
      if (!SandboxReference.sameSandbox(reference, lease.binding.sandbox)) return yield* failure("E2B connected to a different sandbox")
      const sandbox = Context.get(lease.bundle.context, Sandbox.Sandbox)
      const signals = Context.get(lease.bundle.context, ProcessSignals)
      yield* sandbox.files.mkdir(options.root ?? DEFAULT_ROOT, { recursive: true })
      const scope = yield* Scope.Scope
      const active = { value: true }
      yield* Scope.addFinalizer(scope, Effect.sync(() => { active.value = false }))
      const guard = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | WorkspaceDriver.Error, R> =>
        Effect.suspend<A, E | WorkspaceDriver.Error, R>(() => active.value ? effect : failure("E2B connection scope is closed"))
      const spawner = yield* ChildProcessBridge.make({ sandbox, signals })
      return { overrides: files(sandbox, guard), spawner }
    }).pipe(Effect.mapError((cause) => new WorkspaceDriver.Error({ message: "E2B connection failed", cause }))),
    suspendForIdle: ({ workspaceID, binding }) => exclusive(workspaceID, Effect.gen(function* () {
      yield* client.pause(yield* referenceOf(workspaceID, binding))
    })),
    destroy: ({ workspaceID, binding }) => exclusive(workspaceID, Effect.gen(function* () {
      const id = yield* identity(workspaceID)
      const reference = binding ? yield* referenceOf(workspaceID, binding) : yield* reconcile(id)
      if (reference) yield* client.destroy(reference, id).pipe(Effect.catchTag("NotFoundError", () => Effect.void))
    })),
  })
}

const failure = (message: string) => Effect.fail(new WorkspaceDriver.Error({ message }))

type Guard = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | WorkspaceDriver.Error, R>

function files(sandbox: Sandbox.Service, guard: Guard): FilesImpl {
  const failed = (path: string) => (cause: unknown) => new Failed({ path, cause })
  const readError = (path: string) => (cause: unknown) =>
    cause instanceof NotFound || cause instanceof Failed ? cause : failed(path)(cause)
  const stat = (path: string) => guard(sandbox.files.stat(path)).pipe(
    Effect.catchTag("NotFoundError", () => Effect.fail(new NotFound({ path }))),
    Effect.mapError(readError(path)),
    Effect.flatMap((entry) => entry.mtimeMs === undefined || entry.size === null
      ? Effect.fail(failed(path)(new Error("E2B file metadata is incomplete")))
      : Effect.succeed({ type: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs })),
  )
  const resolve = (path: string) => guard(sandbox.files.realpath(path)).pipe(
    Effect.catchTag("NotFoundError", () => Effect.fail(new NotFound({ path }))),
    Effect.mapError(readError(path)),
  )
  return {
    stat,
    read: (path, range) => Effect.gen(function* () {
      const target = yield* resolve(path)
      const info = yield* stat(target)
      if (info.type !== "file") return yield* Effect.fail(new WrongKind({ path, actual: info.type }))
      const bytes = yield* guard(sandbox.files.read(target, { maxBytes: 64 * 1024 * 1024 })).pipe(Effect.mapError(failed(path)))
      return { info, bytes: range ? bytes.subarray(range.offset, range.offset + range.length) : bytes }
    }),
    list: (path) => Effect.gen(function* () {
      const target = yield* resolve(path)
      const info = yield* stat(target)
      if (info.type !== "directory") return yield* Effect.fail(new WrongKind({ path, actual: info.type }))
      return yield* guard(sandbox.files.list(target)).pipe(
        Effect.map((entries) => entries.map((entry) => ({ name: posix.basename(entry.path), type: entry.kind }))),
        Effect.mapError(failed(path)),
      )
    }),
    write: (path, bytes) => guard(sandbox.files.write(path, bytes, { overwrite: true })).pipe(Effect.mapError(failed(path))),
    mkdir: (path) => guard(sandbox.files.mkdir(path, { recursive: true })).pipe(Effect.mapError(failed(path))),
    remove: (path) => guard(sandbox.files.remove(path, { recursive: true })).pipe(Effect.mapError(failed(path))),
    move: (from, to) => guard(sandbox.files.rename(from, to)).pipe(
      Effect.catchTag("NotFoundError", () => Effect.fail(new NotFound({ path: from }))),
      Effect.mapError((cause) => cause instanceof NotFound ? cause : failed(from)(cause)),
    ),
  }
}
