export * as E2B from "./e2b.ts"

import { Context, Effect, Exit, Layer, Predicate, Scope, Stream } from "effect"
import * as AdapterKit from "effect-sandbox/AdapterKit"
import * as E2BClient from "effect-sandbox/e2b/E2BClient"
import * as LifecyclePolicy from "effect-sandbox/LifecyclePolicy"
import * as Sandbox from "effect-sandbox/Sandbox"
import * as SandboxCommand from "effect-sandbox/SandboxCommand"
import type { Lease } from "effect-sandbox/SandboxLease"
import * as Provider from "effect-sandbox/SandboxProvider"
import type { SandboxReference } from "effect-sandbox/SandboxReference"
import { posix } from "node:path"
import { ActorFilesystem, type Filesystem } from "./actor-filesystem.ts"
import { validateArchive } from "./workspace-transfer.ts"
import type { Interface, JournalEntry, RunOptions, RunResult } from "./workload.ts"

export interface CreateOptions {
  readonly journal?: (entry: JournalEntry) => Promise<void>
  readonly timeoutMs?: number
  readonly metadata?: Readonly<Record<string, string>>
  readonly template?: string
  readonly secure?: boolean
  readonly envs?: Readonly<Record<string, string>>
}

export interface ReconnectOptions {
  readonly sandboxId: string
  readonly boundaryToken?: string
  readonly timeoutMs?: number
}

const defaultEnvironment: Readonly<Record<string, string>> = {
  HOME: "/home/user",
  PATH: "/usr/local/bin:/usr/bin:/bin",
}

const sandboxIdPattern = /^[A-Za-z0-9_-]{1,128}$/

const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)))

const runPromise = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect).catch((cause: unknown) => {
    throw asError(cause)
  })

const filesystemCode = (cause: unknown): string | undefined => {
  if (Predicate.isTagged(cause, "NotFoundError")) return "ENOENT"
  if (cause instanceof Error && /\bEEXIST\b|already exists/i.test(cause.message)) return "EEXIST"
  if (cause instanceof Error && /\bEACCES\b|\bEPERM\b|permission/i.test(cause.message)) return "EACCES"
  return undefined
}

const failFiles = (operation: string, cause: unknown): never => {
  throw new ActorFilesystem.Error({ operation, cause, filesystemCode: filesystemCode(cause) })
}

const toStat = (entry: {
  readonly kind: string
  readonly size: number | null
  readonly mode?: number
  readonly mtimeMs?: number
  readonly owner?: string
  readonly group?: string
}) => ({
  isSymbolicLink: entry.kind === "symlink",
  isDirectory: entry.kind === "directory",
  mtimeMs: entry.mtimeMs ?? 0,
  atimeMs: 0,
  ctimeMs: 0,
  birthtimeMs: 0,
  dev: 0,
  ino: 0,
  mode: entry.mode ?? 0,
  nlink: 0,
  uid: 0,
  gid: 0,
  rdev: 0,
  size: entry.size ?? 0,
  blocks: 0,
})

const entryType = (kind: string): "directory" | "file" | "symlink" => {
  if (kind === "directory") return "directory"
  if (kind === "symlink") return "symlink"
  return "file"
}

export class Workload implements Interface {
  readonly boundaryToken = undefined
  private sealed = false
  private readonly inflight = new Set<AbortController>()

  private constructor(
    readonly sandboxId: string,
    private readonly client: E2BClient.Service,
    private readonly clientScope: Scope.Closeable,
    private leaseScope: Scope.Closeable,
    private lease: Lease<E2BClient.Provided> | undefined,
    private readonly reference: SandboxReference,
  ) {}

  static async create(options: CreateOptions = {}) {
    if (options.secure === false) throw new Error("E2B workload requires secure controller authentication")
    if (options.envs && Object.keys(options.envs).length > 0)
      throw new Error("E2B workload does not allow sandbox-global environment variables")
    const session = await Workload.openSession()
    try {
      const request = await runPromise(
        Provider.makeRequest({
          resources: {},
          lifecycle: LifecyclePolicy.persistent("keep", options.timeoutMs ?? 300_000),
          metadata: options.metadata ?? {},
        }),
      )
      const createOptions: {
        secure: boolean
        template?: string
        timeoutMs?: number
      } = { secure: options.secure ?? true }
      if (options.template !== undefined) createOptions.template = options.template
      if (options.timeoutMs !== undefined) createOptions.timeoutMs = options.timeoutMs
      const lease = await runPromise(
        session.client.create(createOptions, request).pipe(Effect.provideService(Scope.Scope, session.leaseScope)),
      )
      const workload = new Workload(
        lease.binding.sandbox.id,
        session.client,
        session.clientScope,
        session.leaseScope,
        lease,
        lease.binding.sandbox,
      )
      try {
        await options.journal?.({ sandboxId: workload.sandboxId, state: "created" })
        await runPromise(workload.sandbox().files.mkdir("/workspace", { recursive: true })).catch(() => undefined)
        return workload
      } catch (error) {
        const cleanup = await workload.delete(options.journal).then(
          () => undefined,
          (cause: unknown) => asError(cause),
        )
        if (cleanup) throw new AggregateError([error, cleanup], "failed to create and clean up E2B workload", { cause: error })
        throw error
      }
    } catch (error) {
      await runPromise(Scope.close(session.leaseScope, Exit.succeed(undefined))).catch(() => undefined)
      await runPromise(Scope.close(session.clientScope, Exit.succeed(undefined))).catch(() => undefined)
      throw error
    }
  }

  static async reconnect(options: ReconnectOptions) {
    Workload.validateIdentity(options.sandboxId)
    const session = await Workload.openSession()
    try {
      const reference = await runPromise(
        AdapterKit.decodeReference("e2b", AdapterKit.makeOwner("e2b", {}), options.sandboxId),
      )
      const lease = await runPromise(
        session.client.connect(reference).pipe(Effect.provideService(Scope.Scope, session.leaseScope)),
      )
      if (lease.binding.sandbox.id !== options.sandboxId) throw new Error("E2B reconnected with a different sandbox ID")
      return new Workload(
        lease.binding.sandbox.id,
        session.client,
        session.clientScope,
        session.leaseScope,
        lease,
        lease.binding.sandbox,
      )
    } catch (error) {
      await runPromise(Scope.close(session.leaseScope, Exit.succeed(undefined))).catch(() => undefined)
      await runPromise(Scope.close(session.clientScope, Exit.succeed(undefined))).catch(() => undefined)
      throw error
    }
  }

  get guestFiles(): Filesystem {
    return {
      readFile: (path) => this.fileRead(path),
      writeFile: (path, data, options) => this.fileWrite(path, data, options),
      stat: (path) => this.fileStat(path),
      mkdir: (path, options) => this.fileMkdir(path, options),
      readdir: (path) => this.fileReaddir(path),
      readdirEntries: (path) => this.fileReaddirEntries(path),
      readdirRecursive: (path) => this.fileReaddirRecursive(path),
      exists: (path) => this.fileExists(path),
      remove: (path, options) => this.fileRemove(path, options),
      move: (from, to) => this.fileMove(from, to),
      realpath: (path) => this.fileRealpath(path),
    }
  }

  async run(file: string, options: RunOptions = {}): Promise<RunResult> {
    return this.exec(file, { ...options, onTimeout: "seal" })
  }

  async stop() {
    await this.sealAndKill()
  }

  async exportWorkspace() {
    if (!this.sealed) throw new Error("workload must be stopped before export")
    const archive = `/tmp/opencode-export-${crypto.randomUUID()}.tar`
    const packed = await this.runTar(["-C", "/workspace", "-cf", archive, "."], 70_000)
    if (packed.exitCode !== 0) throw new Error(`workspace export failed: ${new TextDecoder().decode(packed.stderr)}`)
    try {
      const data = await runPromise(this.sandbox().files.read(archive, { maxBytes: 536_870_912 }))
      await validateArchive(data)
      return data
    } finally {
      await runPromise(this.sandbox().files.remove(archive, { recursive: false })).catch(() => undefined)
    }
  }

  async importWorkspace(data: Uint8Array) {
    if (this.sealed) throw new Error("workload boundary is stopped")
    await validateArchive(data)
    const archive = `/tmp/opencode-import-${crypto.randomUUID()}.tar`
    await runPromise(this.sandbox().files.write(archive, data, { overwrite: true }))
    try {
      const unpacked = await this.runTar(["-C", "/workspace", "-xf", archive], 70_000)
      if (unpacked.exitCode !== 0) throw new Error(`workspace import failed: ${new TextDecoder().decode(unpacked.stderr)}`)
    } finally {
      await runPromise(this.sandbox().files.remove(archive, { recursive: false })).catch(() => undefined)
    }
  }

  async pause() {
    if (this.sealed) return { sandboxId: this.sandboxId }
    await this.detachLease()
    await runPromise(this.client.pause(this.reference))
    await this.closeClient()
    return { sandboxId: this.sandboxId }
  }

  async delete(journal?: (entry: JournalEntry) => Promise<void>) {
    const failures: unknown[] = []
    this.sealed = true
    for (const controller of this.inflight) controller.abort()
    await this.detachLease().catch((error) => failures.push(error))
    const request = await runPromise(
      Provider.makeRequest({
        resources: {},
        lifecycle: LifecyclePolicy.ephemeral(30_000),
        metadata: {},
      }),
    ).catch((error: unknown) => {
      failures.push(error)
      return undefined
    })
    if (request) {
      await runPromise(this.client.destroy(this.reference, request.operationId)).catch((error) => failures.push(error))
      const probeScope = await runPromise(Scope.make())
      const probe = await runPromise(
        Effect.exit(this.client.connect(this.reference).pipe(Effect.provideService(Scope.Scope, probeScope))),
      )
      await runPromise(Scope.close(probeScope, Exit.succeed(undefined))).catch(() => undefined)
      if (Exit.isSuccess(probe)) failures.push(new Error("E2B sandbox still exists after destroy"))
    }
    await this.closeClient().catch((error) => failures.push(error))
    if (failures.length === 0) {
      await journal?.({ sandboxId: this.sandboxId, state: "deleted" }).catch((error) => failures.push(error))
    }
    if (failures.length === 0) return
    throw new AggregateError(failures, "failed to clean up E2B sandbox")
  }

  private static async openSession() {
    const clientScope = await runPromise(Scope.make())
    const context = await runPromise(Layer.buildWithScope(E2BClient.layer(), clientScope))
    const client = Context.get(context, E2BClient.E2BClient)
    const leaseScope = await runPromise(Scope.make())
    return { client, clientScope, leaseScope }
  }

  private static validateIdentity(sandboxId: string) {
    if (!sandboxIdPattern.test(sandboxId)) throw new Error("invalid E2B sandbox ID")
  }

  private sandbox() {
    if (this.lease === undefined) throw new Error("workload is not connected")
    return Context.get(this.lease.bundle.context, Sandbox.Sandbox)
  }

  private async detachLease() {
    const scope = this.leaseScope
    this.lease = undefined
    await runPromise(Scope.close(scope, Exit.succeed(undefined)))
  }

  private async closeClient() {
    await runPromise(Scope.close(this.clientScope, Exit.succeed(undefined)))
  }

  private async sealAndKill() {
    this.sealed = true
    for (const controller of this.inflight) controller.abort()
    const sealed = this.sealed
    this.sealed = false
    try {
      await this.exec("/bin/sh", {
        args: ["-c", 'for pid in $(ps -o pid= -u user 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done'],
        cwd: "/",
        timeoutMs: 15_000,
        user: "root",
        bypassSeal: true,
        onTimeout: "throw",
      }).catch(() => undefined)
    } finally {
      this.sealed = sealed
    }
  }

  private async exec(
    file: string,
    options: RunOptions & {
      readonly user?: string
      readonly bypassSeal?: boolean
      readonly onTimeout?: "throw" | "seal"
    } = {},
  ): Promise<RunResult> {
    if (!options.bypassSeal && this.sealed) throw new Error("workload boundary is stopped")
    if (file.includes("/") && !file.startsWith("/")) throw new Error("workload executable path must be absolute")
    const sandbox = this.sandbox()
    const timeoutMs = options.timeoutMs ?? 60_000
    const commandOptions: {
      cwd: string
      environment: Record<string, string>
      timeoutMs: number
      user?: string
    } = {
      cwd: options.cwd ?? "/workspace",
      environment: { ...defaultEnvironment, ...options.env },
      timeoutMs,
    }
    if (options.user !== undefined) commandOptions.user = options.user
    const command = SandboxCommand.make(file, options.args ?? [], commandOptions)
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => {
      controller.abort()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    this.inflight.add(controller)
    const aborted = Effect.callback<never>((resume) => {
      if (controller.signal.aborted) {
        resume(Effect.interrupt)
        return
      }
      const onInnerAbort = () => resume(Effect.interrupt)
      controller.signal.addEventListener("abort", onInnerAbort, { once: true })
      return Effect.sync(() => controller.signal.removeEventListener("abort", onInnerAbort))
    })
    const work = Effect.scoped(
      Effect.gen(function* () {
        const process = yield* sandbox.spawn(command)
        const chunks = yield* Stream.runCollect(process.output)
        const observed = yield* process.awaitResult
        const outputParts: Array<Uint8Array> = []
        for (const chunk of chunks) outputParts.push(chunk.bytes)
        const exitCode = Predicate.isTagged(observed.termination, "Exited") ? observed.termination.code : 137
        const result: RunResult = {
          exitCode,
          stdout: observed.stdout,
          stderr: observed.stderr,
          output: concatBytes(outputParts),
        }
        return result
      }),
    )
    try {
      return await runPromise(Effect.raceFirst(work, aborted))
    } catch (error) {
      if (timedOut && options.signal?.aborted !== true && options.onTimeout === "seal") {
        await this.sealAndKill()
        const empty = new Uint8Array()
        return { exitCode: 124, stdout: empty, stderr: empty, output: empty }
      }
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      this.inflight.delete(controller)
    }
  }

  private async runTar(args: ReadonlyArray<string>, timeoutMs: number) {
    const sealed = this.sealed
    this.sealed = false
    try {
      return await this.exec("/usr/bin/tar", { args, cwd: "/", timeoutMs, bypassSeal: true, onTimeout: "throw" })
    } finally {
      this.sealed = sealed
    }
  }

  private async fileRead(path: string) {
    return runPromise(this.sandbox().files.read(path, { maxBytes: 536_870_912 })).catch((cause) => failFiles("read", cause))
  }

  private async fileWrite(
    path: string,
    data: Uint8Array,
    options?: { readonly flag?: "w" | "wx"; readonly mode?: number },
  ) {
    const writeOptions: { overwrite: boolean; mode?: number } = { overwrite: options?.flag !== "wx" }
    if (options?.mode !== undefined) writeOptions.mode = options.mode
    return runPromise(this.sandbox().files.write(path, data, writeOptions)).catch((cause) => failFiles("write", cause))
  }

  private async fileStat(path: string) {
    return runPromise(this.sandbox().files.stat(path))
      .then(toStat)
      .catch((cause) => failFiles("stat", cause))
  }

  private async fileMkdir(path: string, options?: { readonly recursive?: boolean }) {
    return runPromise(this.sandbox().files.mkdir(path, { recursive: options?.recursive === true })).catch((cause) =>
      failFiles("mkdir", cause),
    )
  }

  private async fileReaddir(path: string) {
    return runPromise(this.sandbox().files.list(path))
      .then((entries) => entries.map((entry) => posix.basename(entry.path)))
      .catch((cause) => failFiles("readdir", cause))
  }

  private async fileReaddirEntries(path: string) {
    return runPromise(this.sandbox().files.list(path))
      .then((entries) =>
        entries.map((entry) => ({
          name: posix.basename(entry.path),
          isDirectory: entry.kind === "directory",
          isSymbolicLink: entry.kind === "symlink",
        })),
      )
      .catch((cause) => failFiles("readdir", cause))
  }

  private async fileReaddirRecursive(path: string) {
    return runPromise(this.sandbox().files.list(path, { recursive: true }))
      .then((entries) =>
        entries.map((entry) => ({
          path: entry.path,
          type: entryType(entry.kind),
        })),
      )
      .catch((cause) => failFiles("readdir", cause))
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await runPromise(this.sandbox().files.stat(path))
      return true
    } catch (cause) {
      if (Predicate.isTagged(cause, "NotFoundError")) return false
      if (cause instanceof Error && /\bENOENT\b|no such file or directory/i.test(cause.message)) return false
      failFiles("exists", cause)
      return false
    }
  }

  private async fileRemove(path: string, options?: { readonly recursive?: boolean }) {
    return runPromise(this.sandbox().files.remove(path, { recursive: options?.recursive === true })).catch((cause) =>
      failFiles("remove", cause),
    )
  }

  private async fileMove(from: string, to: string) {
    return runPromise(this.sandbox().files.rename(from, to)).catch((cause) => failFiles("move", cause))
  }

  private async fileRealpath(path: string) {
    return runPromise(this.sandbox().files.realpath(path)).catch((cause) => failFiles("realpath", cause))
  }
}

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}
