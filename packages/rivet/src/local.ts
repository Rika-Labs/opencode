export * as Local from "./local.ts"

import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { validateArchive } from "./workspace-transfer.ts"
import type { Interface, JournalEntry, RunOptions, RunResult } from "./workload.ts"

export interface CreateOptions {
  /** Attach to an existing directory instead of provisioning a fresh one. */
  readonly root?: string
}

const timeoutExitCode = 124

export class Workload implements Interface {
  readonly boundaryToken = undefined

  constructor(
    readonly sandboxId: string,
    readonly root: string,
    private readonly children = new Set<ChildProcess>(),
  ) {}

  static async create(options: CreateOptions = {}, journal?: (entry: JournalEntry) => Promise<void>) {
    const root = options.root
      ? resolve(options.root)
      : await mkdtemp(join(process.env.RIVET_LOCAL_WORKSPACES_DIR ?? tmpdir(), "opencode-local-"))
    if (!(await stat(root).catch(() => undefined))?.isDirectory())
      throw new globalThis.Error(`local workspace root is not a directory: ${root}`)
    const workload = new Workload(`local-${randomUUID()}`, root)
    await journal?.({ sandboxId: workload.sandboxId, state: "created" })
    return workload
  }

  static async reconnect(options: { sandboxId: string; root: string }) {
    if (!/^[a-zA-Z0-9-]+$/.test(options.sandboxId)) throw new globalThis.Error("invalid local sandbox ID")
    if (!(await stat(options.root).catch(() => undefined))?.isDirectory())
      throw new globalThis.Error(`local workspace root is missing: ${options.root}`)
    return new Workload(options.sandboxId, options.root)
  }

  async run(command: string, options: RunOptions = {}): Promise<RunResult> {
    const child = spawn(command, options.args ?? [], {
      cwd: options.cwd ?? this.root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.children.add(child)
    const abort = () => child.kill("SIGKILL")
    options.signal?.addEventListener("abort", abort, { once: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const output: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
      output.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
      output.push(chunk)
    })
    const deadline = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code) => resolve(code))
      })
      return {
        exitCode: child.killed ? timeoutExitCode : exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        output: Buffer.concat(output),
      }
    } finally {
      clearTimeout(deadline)
      options.signal?.removeEventListener("abort", abort)
      this.children.delete(child)
    }
  }

  async exportWorkspace() {
    const result = await this.run("tar", { args: ["-C", this.root, "-cf", "-", "."] })
    if (result.exitCode !== 0) throw new globalThis.Error(`local workspace export failed: ${result.stderr.toString()}`)
    return result.stdout
  }

  async importWorkspace(archive: Uint8Array) {
    validateArchive(archive)
    await mkdir(this.root, { recursive: true })
    const staged = await mkdtemp(join(tmpdir(), "opencode-local-import-"))
    try {
      const file = join(staged, "workspace.tar")
      await Bun.write(file, archive)
      const result = await this.run("tar", { args: ["-C", this.root, "-xf", file] })
      if (result.exitCode !== 0) throw new globalThis.Error(`local workspace import failed: ${result.stderr.toString()}`)
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  }

  async pause() {
    return { sandboxId: this.sandboxId }
  }

  async stop() {
    for (const child of this.children) child.kill("SIGKILL")
  }

  // The local root is the user's real directory; deletion releases the identity, never the files.
  async delete(journal?: (entry: JournalEntry) => Promise<void>) {
    await this.stop()
    await journal?.({ sandboxId: this.sandboxId, state: "deleted" })
  }
}
