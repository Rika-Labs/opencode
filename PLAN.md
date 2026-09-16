# Rivet workspaces: bare-metal execution targets

Status: implemented and verified on branch `sandbox-workspaces`. Every claim below was re-proven this session (see [Verification](#verification)); the historical agentOS-era plan that preceded this file described the removed design and no longer applies to any current code.

## What this is

OpenCode server can execute each workspace's tools either on the host it runs on or inside an E2B sandbox. The execution target is a pluggable registry record, not an if-chain: adding a thirtieth provider later means adding one module to one record.

The product shape this enables: every thread in a new app binds to a Rivet actor. The actor is the durable foreman — it holds identity, generation, lifecycle, and command bookkeeping in Rivet's durable storage. The box underneath it (host directory or sandbox) is replaceable and reattached automatically after any restart.

Settled decisions, made by the product owner:

- **Rivet Actors only.** No agentOS, no sandbox-agent dependency, no fork of a third-party runtime.
- **Two execution targets for now:** `local` (the host itself, no sandbox) and `e2b`. Daytona and `effect-sandbox` are deferred (see below).
- **No migration machinery.** Promotion/transfer between providers was deleted entirely. Export/import exist only as the workload contract primitives (used by tests and future providers), not as a user-facing migrate flow. Migration will be figured out later.
- **One global opencode sqlite per install.** The database lives on the host, never inside a sandbox; sandboxes are stateless compute.
- **Normal opencode keeps working.** With no Rivet provider configured, nothing in the core workspace layer changes behavior; the provider is additive.

## Architecture

All Rivet-side code lives in `packages/rivet/src`:

| Module | Responsibility |
| --- | --- |
| `workload.ts` | `Workload.Interface` — the execution-target contract: `run`, `exportWorkspace`, `importWorkspace`, `pause`, `stop`, `delete`, plus identity (`sandboxId`, optional `boundaryToken`, optional host `root`). |
| `backends.ts` | `Record<Backend, Module>` registry. Each module: `create({root?})`, `reconnect(identity)`, `validate(identity)`. Adding a backend = adding one record. |
| `local.ts` | Host backend. Runs commands with node `spawn` under a root directory (caller-supplied, or provisioned via mkdtemp). Timeout kills with SIGKILL and reports exit 124; abort signals kill the child; cleanup always runs via `finally`. `delete` releases identity and never touches the user's files. |
| `e2b.ts` | E2B backend. A root-run Python boundary helper (inline template) forks each command into a dedicated cgroup, records the child pid in a flock'd state file, and supports `inspect/check/stop/export/import/remove/cancel`. Cancel kills the recorded pid only after verifying its `/proc/<pid>/cgroup` matches the recorded cgroup (pid-reuse defense; compared in both absolute and cgroup-namespace-relative form). |
| `sandbox-environment.ts` | Opens a workload into a serialized run/filesystem/stop surface; per-run AbortController wired through `Effect.onInterrupt` so fiber interruption kills in-flight guest commands. Owns the guest↔host path mapping (below). |
| `workspace-actor.ts` | The durable actor: `Initialize`, `Run`, `CommandEpoch`, `StartCommand`, `CommandStatus`, `CancelCommand`, `Filesystem`, `Stop`, `GetEnvironment`. Durable state: backend, generation, lifecycle, storage identity, workload identity. In-memory per-wake state: environment handle, command records, epochs. |
| `actor-filesystem.ts` | Adapts the actor's filesystem actions into Effect `FileSystem` for core. Translates caller paths (the caller's mount) to/from guest-absolute `/workspace` paths. |
| `actor-process.ts` | Adapts the actor's command actions into core `AppProcess`. Caller aborts win the arbitration race and propagate their own reason; the affirmative cancel is still awaited. |
| `provider.ts` | `WorkspaceProvider.Interface` for core: maps core `EnvironmentTarget` (`{type:"local",root}` / `{type:"sandbox",provider:"e2b"}`) to actor `Initialize` payloads and exposes bind/create/environment. |

Core (`packages/core`) owns `EnvironmentTarget` and the workspace-provider seam; `sdk-next` composes the provider into the server (`workspace-client` glue was deleted — the provider is passed through directly).

### Path spaces (the one subtle contract)

Three path spaces exist and must never be mixed:

1. **Caller space** — the workspace directory the caller sees: the real host directory for `local`, `/workspace` for `e2b`.
2. **Guest space** — actor-absolute paths rooted at `/workspace` (the actor's canonical convention, both backends).
3. **Host space** — where the python helper actually executes: the sandbox `/workspace` for `e2b`, the workload `root` directory for `local`.

`ActorFilesystem.make` translates caller↔guest at its boundary (`toGuest`/`fromGuest`); `sandbox-environment` translates guest↔host (`toHost`/`fromHost`) for workload types with a host root. E2B is identity in both maps. Relative paths are workspace-relative. This is covered end-to-end by the provider registry case (recursive readdir, glob relative and absolute, `resolve`/realPath, findUp) and would fail loudly on any drift.

### Concurrency model

- `lock` guards actor state and the command map; `vmLock` serializes workload connect/stop; `ioLock` serializes command execution and filesystem operations (the workload is a single serialized surface).
- `CancelCommand` and `Stop` release `lock` before interrupting a fiber, and the fiber's terminal record write takes `lock` in its uninterruptible tail — no deadlock, no lost update.
- `CancelCommand` never destroys a terminal record: it returns the truthful state (`cancelled`, or `completed`/`failed` with the result if the command finished first).
- `Stop` interrupts running fibers, stops the workload, and persists `stopped` through the same `persist` path as every other durable write.

## What was deleted (and why)

- **agentOS / sandbox-agent support** — required forking and publishing an 18-package `@rikalabs` fork of rivet's agentos; the wasm/sidecar machinery was disproportionate to running shell commands. All `@rikalabs/*` dependencies removed.
- **Daytona backend** — unverified shutdown boundary; deferred with the provider-registry seam ready for it.
- **Promotion/migration machinery** — `Promotion` schema, `promote`, the migration registry case, and the sdk migration client. Migration is a product decision for later; the transfer primitives (`exportWorkspace`/`importWorkspace` with validated tar archives) remain as contract-level building blocks.
- **sdk-next workspace-client** — indirect plumbing; the provider now flows through `options.workspaces`.

Net: the branch removes ~3.7k lines and adds ~350.

## Deferred

- **`effect-sandbox`** — its E2B provider's peer range wants Effect `4.0.0-rc.112` while this repo pins `4.0.0-beta.83`, and its provider cannot yet express our contract (byte-preserving transfer, posix stat fields, rename/realpath/mode semantics). The `Workload` registry seam makes adopting it later a bounded adapter change, not a redesign.
- **Daytona** — same seam; add a `Module` record and a schema literal when the shutdown boundary exists.
- **Migration between targets** — deliberately out of scope; revisit after the first real deployment.
- **Sandboxed sqlite** — the opencode database stays global on the host by design.

## Verification

All commands run from `packages/rivet`. Type-checks (`bun typecheck`) are clean in `packages/rivet`, `packages/core`, `packages/server`, `packages/sdk-next`.

Credential-free (CI-safe):

- `bun test test/local.test.ts test/actor-filesystem.test.ts test/actor-process.test.ts test/workspace-transfer.test.ts` → 15 pass.
- `bun test test/registry.test.ts` — spawns a real rivet engine per case and runs every registry case against the **local** backend: long command (67s), command lifecycle (identity, cancellation with real child kill, status, output), provider composition (bind, filesystem round-trips, path-returning ops, abort), resume (provision → engine restart → wake → reconnect → verify file → stop), workspace-actor persistence/isolation. All pass (~2min).

Live (`E2B_LIVE=1`, real E2B credentials):

- The same registry cases run against **real E2B sandboxes** — all pass, including the two-phase resume case, which reconnects a paused sandbox on a fresh engine.
- `test/e2b.test.ts` (cgroup fences across stop/pause) and `test/e2b-auth.test.ts` (envd rejects unauthenticated guest requests) — pass.

Two bugs found and fixed by these live runs rather than by reading code:

1. The e2b cancel pid-reuse check compared the recorded cgroup path against `/proc/<pid>/cgroup` verbatim, but `/proc` reports the path relative to the cgroup namespace root inside the sandbox — the check never matched and cancelled commands kept running until their natural timeout. Reproduced with in-sandbox forensics; fixed by comparing both forms; regression covered by the registry command-lifecycle case, which now waits past the guest write deadline so a failed kill cannot hide.
2. The actor process adapter's abort arbitration let the command's generic cancellation error win the race against the caller's abort reason once cancellation became fast. Fixed by settling the abort error first and awaiting the affirmative cancel before propagating; unit tests cover both orders.

Two review rounds (independent subagent reviews) ran over this diff: round 1 produced 16 findings (all resolved or explicitly skipped with reasons), round 2 produced 8 (both blockers fixed: local reconnect now passes the persisted root; host→guest output mapping added for `realpath` and recursive entries; coverage added for both). sdk-next `embedded.test.ts` has 3 pre-existing `SQLITE_CANTOPEN` failures identical on a stashed baseline — environmental, out of scope.
