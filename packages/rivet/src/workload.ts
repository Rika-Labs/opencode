export * as Workload from "./workload.ts"

export interface JournalEntry {
  readonly sandboxId: string
  readonly boundaryToken?: string
  readonly state: "created" | "deleted"
}

export interface RunOptions {
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  /** Aborting kills the in-flight command instead of letting it run to completion. */
  readonly signal?: AbortSignal
}

export interface RunResult {
  readonly exitCode: number | null | undefined
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  /** Both streams merged in arrival order, as the process wrote them. */
  readonly output: Uint8Array
}

/**
 * The sandbox execution contract every workspace backend implements. Commands
 * and filesystem operations are performed inside the sandbox; export and
 * import move whole workspace trees as validated tar archives between the
 * workload and the caller.
 */
export interface Interface {
  readonly sandboxId: string
  readonly boundaryToken?: string
  /** The caller-visible workspace directory; backends without one on the host leave it undefined. */
  readonly root?: string
  readonly run: (command: string, options?: RunOptions) => Promise<RunResult>
  readonly exportWorkspace: () => Promise<Uint8Array>
  readonly importWorkspace: (archive: Uint8Array) => Promise<void>
  readonly pause: () => Promise<{ sandboxId: string; boundaryToken?: string }>
  readonly stop: () => Promise<void>
  readonly delete: (journal?: (entry: JournalEntry) => Promise<void>) => Promise<void>
}
