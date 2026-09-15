# Rivet SDK integration: implementation plan

Status at handoff: implementation and verification complete; release in flight. SDK composition, Rivet Effect workspace actors, guest filesystem/process RPC, workspace admission, and agentOS ↔ E2B round-trip migration are implemented and verified on native macOS arm64 (Bun and bundled Node) plus live E2B and Daytona runs. GitHub auth was restored via device flow (`repo` + `workflow` scopes); both branches are pushed and the agentOS fork PRs are merged. `@rikalabs/*@0.2.19-rika.1` is published on npm via `Rika-Labs/agentos` `publish.yaml` (npm token lives in Actions secrets). Sections below describe the original design and historical checkpoints; this handoff status supersedes their progress and authorization claims.

## Current handoff checkpoint

- Shipped so far: `rivet-sdk` pushed; `Rika-Labs/opencode#1` open (`rivet-sdk`→`dev`; auto-closed once by the template-compliance bot, reopened with a compliant body). `confirmed-shutdown` merged via `Rika-Labs/agentos#1`; `Rika-Labs/agentos#2` dropped the `codex-wasm` publish job, then `Rika-Labs/agentos#3` restored it (dropping tokio's `[patch.crates-io]` line invalidates the shipped lockfile entry, so `cargo vendor` floated tokio — fixed by editing only tokio's lockfile stanza to registry `1.52.3` + checksum, preserving all other pins); `Rika-Labs/agentos#4` added the real root-cause fix — `make codex` now depends on `patch-std` because the tokio wasi companion needs `From<ChildStd*> for OwnedFd` from `std-patches/std/os/wasi/process.rs`, which only `patch-std` installs into the toolchain rust-src (upstream's self-hosted runner had it pre-applied; cold `ubuntu-latest` did not). `Rika-Labs/agentos#6` added `install-staged-app.mjs` — npm cannot map unscoped `rikalabs-*.tgz` filenames to their scoped package names, so the clean-install smoke now installs external deps via npm and unpacks staged tarballs under their real `@rikalabs/*` names. The upstream PR `rivet-dev/agentos#1977` was closed per user direction — all PRs target the Rika-Labs forks only; the chown fix ships via `Rika-Labs/agentos`.
- **Published**: `@rikalabs/*@0.2.19-rika.1` is live on npm (publish run `35005078065`, all jobs green). The dep swap landed on `rivet-sdk`: `link:` deps replaced by published `@rikalabs/agentos-core`/`agentos-runtime-core` `0.2.19-rika.1`, all `@rivet-dev/agentos-*` import specifiers renamed, and the 8-package resolved `@rikalabs` set enumerated in `minimumReleaseAgeExcludes` — bun does not expand scope wildcards. `bun.lock` regenerated against the published packages; rivet suite re-verified on them (28/3-skip/0) plus clean `npm install` runtime smoke under node and bun (darwin resolves via `AGENTOS_SIDECAR_BIN`; linux gets the published platform package).
- CI regressions found and fixed on `rivet-sdk`: (a) a session-runner test leaked captured `requests` into a later assertion — cleared after the closed-promotion run; (b) `WorkspaceProvider.binding` rejected explicit workspace claims whenever no provider was configured, breaking `location[workspace]` GETs on unmanaged servers — `location-services` now treats the identity as a local label unless a provider exists to bind it (managed bind failures still propagate typed errors). Remaining CI failures match `dev`'s pre-existing red baseline (same e2e specs and the model-unknown unit test fail on `dev`).
- OpenCode branch: `rika-labs/opencode:rivet-sdk`, targeting `dev`. Dependency fork branch: `rika-labs/agentos:confirmed-shutdown`. Upstream moved to `rivet-dev/agentos` (renamed from `agent-os`); its `main` is unchanged at `67d2fb75`, the fork's base.
- The architecture keeps OpenCode Sessions, model loop, transcript, permissions, and trusted application/global plugins on the host. Rivet manages workspace execution. Workspace migration transfers files and execution ownership, not process memory. Importing an existing local workspace into agentOS is not implemented. This is different from agentOS's packaged OpenCode software adapter, which runs the entire agent inside the VM.
- Verified end state (all on native macOS arm64, Bun 1.4 / Node 26):
  - Full Bun suite: 28 pass, 3 skipped (E2B live gated), 0 fail. Bundled Node suite (`build:test:node` + `run-node-tests`): 28 pass, 2 skipped, 0 fail. `tsgo --noEmit` clean for the package.
  - Live E2B migration: agentOS → E2B → agentOS round trip passed — binary contents, modes, symlinks, generation fencing on both retired generations, and resource cleanup (all 4 sandboxes deleted).
  - Live Daytona: filesystem semantics, binary/mode/symlink preservation, exclusive writes, stop/start persistence, deleted-ID rejection after asynchronous propagation. Daytona promotion stays explicitly `unsupported` — no verified shutdown boundary exists there.
  - Registry cases (isolated engines): actor command, long command (65s), migration, provider, workspace-actor all pass.
  - Fork publish machinery: `SIDECAR_PLATFORMS=darwin-arm64 prepare-rika-npm` packs and verifies 18 `@rikalabs` packages; `runtime-smoke.mjs` passes under both node and bun against a clean install of the staged tarballs.
- agentOS guest-write fix: `host_dir` mounts project the fixed guest-visible identity `0:0`; the VM now runs `user: { uid: 0, gid: 0, username: "root" }` so kernel DAC admits workspace writes, and the sidecar `chown` no-ops when assigning the projected identity or the entry's current host owner (an unprivileged sidecar cannot `fchownat` at all). Committed on `confirmed-shutdown` with a `host_dir.rs` regression test. This is the upstream-PR payload; upstream `rivet-dev/agentos#1872` tracks the guest-denial and has no fix or maintainer response — no duplication.
- Provider typed errors: actor `BeginPromotion` reports `stopped` for non-running workspaces; provider maps actor reasons to `WorkspaceProvider.Error` codes (`stopped`/`unsupported`→`unsupported`, `stale_generation`/`command_conflict`/`promotion_conflict`→`conflict`, `unknown_command`→`not_found`, `storage_missing`/`environment_failed`/`capacity`→`failed`).
- Workspace transfer resolves a `tarfile extractall(filter=)`-capable Python (`python3` → `python3.13/3.12/3.11`, cached probe) and fails explicitly when none exists — required because macOS system python is 3.9.
- E2B import normalizes extracted ownership to `1000:1000` (archives record source host uids; foreign-owned mode-0751 files were unreadable to the workload user) and manifest comparison no longer checks symlink mode bits (not portable).
- Known limitations (honest, unfixed):
  - Intermittent upstream mount-root `readdir` EINVAL: plain `ls /workspace` on a direct WASM spawn failed once with "general io error: Invalid argument" and then could not be reproduced in 4+ subsequent runs on identical input — `ls -la`, trailing-slash, subdir, `stat`, and shell-mediated access always work. Believed to be a first-access race in agentOS mount/index resolution, not OpenCode code. Report upstream alongside the chown PR; do not claim a fix.
  - agentOS guests must run uid 0 to write `host_dir` mounts; default-uid guests still cannot write (upstream design gap, not a security hole — the mount projects 0:0 ownership).
  - Daytona promotion unsupported by design (no shutdown boundary). Live provider tests need cloud credentials; E2B tests are gated behind `E2B_LIVE`.
  - Development dependencies now resolve the published `@rikalabs/*@0.2.19-rika.1` packages (see the checkpoint above); the former `link:` setup is gone.
  - Only the linux-x64-gnu sidecar matrix is published — no `@rikalabs/agentos-sidecar-darwin-*` packages exist. macOS runs resolve the sidecar via `AGENTOS_SIDECAR_BIN` (e.g. the repo's `target/release/agentos-sidecar`); linux consumers get the platform package automatically.
- Fork publish machinery fixed this session: `--foreground-scripts=false` for npm ≥11 lifecycle stdout, `@agentos-software/manifest` published under `@rikalabs` with the other lockstep software, rika pack/publish set restricted to packages that map into `@rikalabs`, realpath'd `relDir` (was corrupting `repository.directory` on macOS), and the release smoke test runs its VM as root.
- Remaining before merge: confirm the opencode PR checks reach dev-parity (pre-existing e2e/unit-linux baseline failures are documented above and on `dev`), merge, then release the OpenCode fork via `publish-npm.yml` on `dev` (inputs: `version`, `channel`; publishes `@rikalabs/opencode` plus per-platform `@rikalabs/opencode-*` binaries).
- Do not add code comments, weaken types/tests, skip failing tests to claim success, overwrite unrelated work, or merge known critical defects. Tests should document behavior. Recheck upstream agentOS fixes/issues/PRs immediately before contributing; adopt equivalent fixes rather than duplicate them.

Repository: rika-labs/opencode. Base branch: dev. Working branch: rivet-sdk.
Source discussion: https://ampcode.com/threads/T-01a0a0bc-f837-745d-838f-26ce78cf7a67

## Outcome and scope

Add explicit TypeScript SDK composition for Rivet Actors, agentOS execution, and full-sandbox promotion inside this fork. Preserve the fork's SessionV2/model/tool loop and database. Do not launch upstream OpenCode through ACP. Cloudflare is unchanged.

The user authorized implementation through a PR-ready branch and subsequently authorized pushing the work for a local Devin handoff. Follow the current handoff checkpoint above for subsequent PR, merge, and release authorization. The separate request to remove the personal goal plugin was fulfilled in the global personal plugins repository; do not reinstall or use goal automation.

One workspace owns one execution environment; multiple Sessions can share it. Ordinary Rivet actors manage that environment with the Rivet Effect SDK. This is not a general arbitrary-actor registration framework or clustered Session execution.

Simple explanation: same OpenCode brain and memory, lightweight computer first, full Linux computer when needed. Move the workbench, not a running hammer swing.

## Current execution, verified from source

```diagram
SDK OpenCode.create() / HTTP Server
  │
  ▼
SessionV2.prompt
  ├── SessionInput.admit: durable exact-retry reconciliation
  └── advisory SessionExecution.wake
         │
         ▼
SessionExecutionLocal → SessionRunCoordinator
  │                      one drain per Session
  ▼
LocationServiceMap → SessionRunner
  ├── one model stream per provider turn
  └── canonical Tool registry / leaf permissions
         │
         ▼
Host filesystem / AppProcess / native PTY
```

Source ownership:

- `packages/sdk-next/src/opencode.ts`: currently `OpenCode.create()` accepts no options; builds one application memo map, in-memory Server router, and Effect Client. Closing Scope disposes host resources.
- `packages/server/src/routes.ts`: hardwires `SessionExecutionLocal`; must accept backend-neutral composition without importing Rivet.
- `packages/core/src/session.ts`: durable prompt admission precedes advisory wake, exact retries require matching Session/prompt/delivery; `resume: false` admits only.
- `packages/core/src/session/execution.ts`: process-global Session-ID based execution contract; active/interrupt are process-local ownership.
- `packages/core/src/session/run-coordinator.ts`: same-Session serialization, wake coalescing, different-Session concurrency. Interrupt does not prevent successor wakes.
- `packages/core/src/session/runner/llm.ts`: continuation and turn allowance are in-memory; services captured at layer construction.
- `packages/core/src/location-services.ts`: Location graph and LayerMap lifetime; replacements must be applied before global hoisting.
- `packages/core/src/fs-util.ts`, `process.ts`: global services. Do not replace globally with guest implementations.
- `packages/core/src/location.ts`, `project.ts`: project discovery currently uses host FS/Git before constructing complete Location graph.
- `packages/core/src/config.ts`: mixes host-global and workspace configuration reads.
- `packages/core/src/snapshot.ts`, `git.ts`: snapshots combine host-global object storage and workspace worktree; absolute alternates matter to portability.
- `packages/core/src/location-mutation.ts`: realpath/symlink containment is security-relevant.
- `packages/core/src/file-mutation.ts`: target locks are not a workspace-wide freeze.
- `packages/core/src/pty.ts`: native processes directly owned here, not by AppProcess.
- `packages/opencode/src/control-plane/types.ts`, `workspace.ts`: legacy local/remote workspace adapter and sessionWarp exist, but are not V2 execution fencing or a safe promotion shortcut.

Cloudflare's `packages/function/src/api.ts::SyncServer` is share synchronization, not coding execution. The current ShareNext protocol also differs from that old Worker; neither is in scope.

## Proposed ownership and execution

```diagram
┌───────────────────────────────────────────────┐
│ OpenCode host                                 │
│ Database / SessionV2 / SessionRunCoordinator   │
│ Model loop / canonical tools / permissions    │
└─────────────────────┬─────────────────────────┘
                      │ workspace operations
                      ▼
┌───────────────────────────────────────────────┐
│ Neutral Location workspace capabilities       │
│ Workspace-wide gate / generation-bound leases │
└─────────────────────┬─────────────────────────┘
                      ▼
┌───────────────────────────────────────────────┐
│ @opencode-ai/rivet workspace actor             │
│ @rivetkit/effect actions + wake-scoped resources│
│ Environment identity / promotion journal       │
└──────────────────┬────────────────┬───────────┘
                   ▼                ▼
          ┌────────────────┐ ┌──────────────────┐
          │ agentOS core   │ │ Full sandbox     │
          │ lightweight VM │ │ Sandbox Agent I/O│
          └────────────────┘ └──────────────────┘
```

Ownership:

- OpenCode is the sole Session/transcript/admission/permission authority.
- Workspace actor is the sole backend/generation/promotion authority. Host stores stable association, not another authoritative state machine.
- Workspace gate spans all Sessions and subdirectory Locations in a workspace.
- Ordinary local Locations remain unchanged; explicit managed workspaces opt in.
- Stable logical workspace paths survive promotion; physical provider paths stay internal.
- Initial deployment: one persistent worker with exclusive durable volume ownership. Rivet region/pool selection alone does not provide physical-host affinity. Missing storage fails closed rather than creating a blank environment.
- Do not create a new OpenCode host or database per actor.
- No provider SDK dependencies in Schema/Core/Protocol/generic Client. Integration package implements Core-owned neutral contracts; SDK composes them.
- Closing Scope disconnects resources; deleting a workspace/sandbox requires an explicit operation.

## Platform findings and compatibility spike

Verified package metadata on 2026-09-14:

- `@rivetkit/effect` 2.3.17 peers on `rivetkit` 2.3.17 and Effect `^4.0.0-beta.66`.
- Fork pins patched Effect 4.0.0-beta.83.
- Published agentOS core and actor packages are 0.2.19 (earlier source research reported repository-internal 0.0.1; use published metadata).
- agentOS core carries native sidecar and better-sqlite3 dependencies. It includes bundled agent packages, but this integration must not invoke their ACP sessions.
- Orb currently has Bun 1.3.10 while repo declares 1.3.14; Node is 26.5.1. Validate supported runtime, use Node 22+ worker if Bun incompatible, no forced repo-wide Effect upgrade.

Rivet semantics:

- Actor actions may overlap; State semaphore does not serialize full actions.
- `State.set` updates raw state and schedules saving; it is not durable acknowledgment.
- Explicit `rawRivetkitContext.saveState({ immediate: true })` is a persistence barrier; promotion transitions must use an actual durable commit.
- Scoped fibers are interrupted on teardown but do not automatically keep the actor awake. Use tracked raw keepAwake/waitUntil bridges for active work.
- Raw action default timeout is 60 seconds. Long commands/promotions require explicit lifecycle design; do not hold one default RPC for an unbounded operation.
- Effect SDK has raw context access but lacks public raw actor registration / custom actor HTTP and WebSocket hook configuration.
- Published 0.2.19 did not preserve ordinary virtual-root files across dispose/reopen in the compatibility spike. Only the explicit `host_dir` workspace mount was verified durable. Do not describe sqlite_file as proof of durable virtual-root state. One VM per DB file.
- Stock `agentOS()` actor requires its own UDS/root storage conventions. Prefer embedded core in our Effect actor, not mutation of Effect Registry internals.
- Dynamic mounts require our own persisted descriptors or reconstruction from authoritative backend metadata.
- Published 0.2.19 `exec(signal)` panicked during cancellation in the spike. Use scoped spawn/closeStdin/wait with kill/wait on interruption. The production spawn proxy ignores its timeout option, so the Effect adapter enforces the deadline. Neither root exit nor a synthetic exit after transport failure proves workspace quiescence.
- Sandbox mounting is remote FS plus process bindings, not copying or migration. Its mount does not preserve all POSIX metadata (modes/symlinks), so it is not the promotion copier.
- Stock sandbox provider adapter creates per VM and destroys on disposal; direct SandboxAgent supports reconnect using persisted sandboxId and ordinary disconnect via dispose().

References:

- https://rivet.dev/actors/docs/quickstart/effect
- https://github.com/rivet-dev/rivet/tree/main/rivetkit-typescript/packages/effect/src
- https://github.com/rivet-dev/rivet/blob/main/rivetkit-typescript/packages/rivetkit/src/client/query.ts
- https://github.com/rivet-dev/agentos/blob/main/packages/core/src/agent-os.ts
- https://github.com/rivet-dev/agentos/blob/main/packages/core/src/sandbox.ts
- https://github.com/rivet-dev/agentos/blob/main/examples/embedded/persistence.ts
- https://github.com/rivet-dev/agentos/blob/main/packages/agentos-sandbox/src/provider.ts
- https://github.com/rivet-dev/sandbox-agent/blob/main/sdks/typescript/src/client.ts
- https://rivet.dev/agentos/docs/sandboxes

## SDK code examples: proposed, not implemented exports

Earlier conversational examples used invented response envelopes and prompt arrays. Real sdk-next sessions.create returns the Session directly; use actual Prompt.make. Align new APIs with this convention during implementation.

### Explicit host composition

```ts
import { OpenCode, Prompt } from '@opencode-ai/sdk-next'
import { Rivet } from '@opencode-ai/rivet'
import { Config, Effect, Redacted } from 'effect'

const program = Effect.scoped(Effect.gen(function* () {
  const endpoint = yield* Config.string('RIVET_ENDPOINT')
  const namespace = yield* Config.string('RIVET_NAMESPACE')
  const token = yield* Config.redacted('RIVET_TOKEN')
  const workspaces = yield* Rivet.create({
    endpoint,
    namespace,
    token: Redacted.value(token),
    storageDirectory: '/var/lib/opencode/rivet',
    sandbox: { provider: 'e2b' },
  })
  const opencode = yield* OpenCode.create({ workspaces })
  const workspace = yield* opencode.workspaces.create({
    name: 'website', environment: { type: 'agentos' },
  })
  const session = yield* opencode.sessions.create({ location: workspace.location })
  yield* opencode.sessions.prompt({
    sessionID: session.id,
    prompt: Prompt.make({ text: 'Build a small website.' }),
  })
}))
```

Rivet.create should acquire worker integration resources, not deploy control-plane infrastructure. Secrets stay on the host. The generic SDK accepts a capability, not raw Rivet options. No CLI config or opencode serve is required for embedding. A remote SDK client connects to an already configured host.

### Multiple Sessions and sandbox-first workspaces

```ts
const implementation = yield* opencode.sessions.create({ location: workspace.location })
const review = yield* opencode.sessions.create({ location: workspace.location })
// Both share the environment and promotion gate.

const native = yield* opencode.workspaces.create({
  name: 'native-build', environment: { type: 'sandbox', provider: 'e2b' },
})
```

### Environment inspection and promotion

```ts
const environment = yield* opencode.workspaces.environment({ workspaceID: workspace.id })
// { backend: 'agentos', generation: 1, capabilities: { ... } }

const request = {
  workspaceID: workspace.id,
  requestID: crypto.randomUUID(),
  target: { type: 'sandbox' as const, provider: 'e2b' },
}
const operation = yield* opencode.workspaces.promote(request)
// Returns promptly: { id, status: 'waiting_for_idle' }.
// Retry the SAME requestID and payload after an ambiguous response.

const status = yield* opencode.workspaces.promotion({
  workspaceID: workspace.id, operationID: operation.id,
})
// waiting_for_idle → provisioning → copying → verifying → completed
// or failed with actionable error and known authority.

// After completed, same Session and history:
yield* opencode.sessions.prompt({
  sessionID: implementation.id,
  prompt: Prompt.make({ text: 'Now compile the native dependencies.' }),
})
```

### Rivet Effect actor contract

```ts
import { Action, Actor } from '@rivetkit/effect'
import { Schema } from 'effect'

const GetEnvironment = Action.make('GetEnvironment', {
  success: Schema.Struct({
    backend: Schema.Literals(['agentos', 'sandbox']), generation: Schema.Number,
  }),
})
const RequestPromotion = Action.make('RequestPromotion', {
  payload: { requestID: Schema.String },
  success: Schema.Struct({ operationID: Schema.String }),
})
export const WorkspaceActor = Actor.make('OpenCodeWorkspace', {
  actions: [GetEnvironment, RequestPromotion],
})
```

Actor implementation opens actor-specific resources in the wake scope. Handlers delegate to the workspace service; they do not implement another tool/model loop. Add filesystem/process operations required by the actual integration, with typed errors, output bounds, and generation leases.

### Embedded agentOS lifecycle

```ts
import { AgentOS } from '@opencode-ai/rivet'
import { Effect } from 'effect'

const program = Effect.scoped(Effect.gen(function* () {
  const vm = yield* AgentOS.open({
    database: workspaceDatabasePath,
    directory: managedWorkspacePath,
  })
  return yield* vm.run({
    command: 'printf',
    args: ['hello'],
    timeoutMs: 5000,
    maxOutputBytes: 4096,
  })
}))
```

This is the current compatibility adapter, not the completed OpenCode workspace integration. Host storage paths must be validated and permissioned. Network/env/process capabilities must be explicitly limited. No untrusted guest paths select host directories. A successful run does not establish promotion quiescence; detached processes can survive root exit.

### Sandbox reconnect, not recreation

```ts
import { SandboxAgent } from 'sandbox-agent'

const sandbox = yield* Effect.acquireRelease(
  Effect.tryPromise(() => SandboxAgent.start({
    sandbox: configuredProvider, sandboxId: persistedSandboxID,
  })),
  (client) => Effect.promise(() => client.dispose()),
)
// Explicit deletion is separate from Scope cleanup.
```

### Optional hybrid mount

```ts
import { createSandboxFs } from '@rivet-dev/agentos-sandbox'

await vm.filesystem.mount({
  path: '/mnt/sandbox',
  plugin: createSandboxFs({ client: sandbox, sandboxRoot: '/workspace' }),
  readOnly: false,
})
// This exposes existing remote files; it does NOT transfer source files.
```

Avoid retaining an agentOS proxy after full promotion unless a real hybrid workload needs it. Direct sandbox execution is simpler.

## Promotion protocol and oracle corrections

Initial promotion is idle-boundary, NOT interrupt/resume disguised as continuation.

```diagram
Request / authorize
  ▼
Persist intent
  ▼
Close workspace gate to NEW work
  ├── continue durable prompt admission, wake stays prompt/nonblocking
  ├── defer new prompt promotion
  └── existing task continuations finish naturally
  ▼
Drain all workspace side effects and processes
  ▼
Provision or reconcile destination
  ▼
Persist sandbox identity
  ▼
Copy to staging → verify manifest / metadata / snapshots
  ▼
Durably commit backend + generation
  ▼
Retire captured Location scopes / refresh context
  ▼
Reopen workspace gate / wake eligible inbox
```

1. Workspace-wide gate includes every Session, subdirectory Location, HTTP mutation, revert, PTY, plugin/background process. Hold leases through completion, not only initial generation checks.
2. OpenCode cannot freeze unrelated host editors/daemons; first release uses exclusively managed directories.
3. Current runner holds continuation/step count in memory. Let current work finish; new steers/queues must not indefinitely extend the promotion wait. Timeout yields pending/failure, not forced cancellation/retry.
4. A safe model-boundary suspension preserving continuation is separate future work; no automatic crash recovery of provider turns.
5. Preserve files, untracked data, binary contents, symlinks, executable modes, deletions, linked-worktree metadata, and historical snapshots/revert IDs. Git diff is insufficient.
6. Host credentials, Session database, actor secrets, ephemeral process state are not copied as workspace files. Agent home/config transfer policy must be explicit.
7. Keep source authoritative until cutover; after destination writes, never auto-rollback to stale source.
8. Persist request identity and phase before external side effects. Same request identity with conflicting target fails.
9. Provider create-success/ID-not-recorded window requires provider idempotency, searchable operation tags, or visible manual-reconciliation state. Never blind reprovision.
10. Confirm process termination, not merely request cancellation. PIDs, PTYs, sockets, provider streams are not migrated.
11. Scope finalizers must not delete promoted workspaces. Pause/preserve/delete policy must be explicit and verified per provider.
12. Refresh environment context through SessionContextEpoch's existing reconciliation path; do not keep reporting host platform after backend changes.

Concrete state:

```diagram
BEFORE                              AFTER
Session session-123                 Session session-123 (same)
Workspace workspace-abc             Workspace workspace-abc (same)
OpenCode history                    OpenCode history (same)
Backend agentos                     Backend sandbox
Generation 1                        Generation 2
Sandbox ID none                     Persisted provider ID
```

## Implementation sequence

1. Compatibility spike: install exact published dependencies in isolated scratch, boot AgentOs, execute/cancel, persist/reopen, create real Effect actor registry. Test runtime and native dependencies before broad edits. No paid provisioning without approval.
2. Add optional `packages/rivet`, exact pins, focused integration tests and documentation. Keep imports lazy so local SDK users do not load native Rivet/agentOS dependencies.
3. Add a minimal neutral workspace capability and SDK/Server composition path, preserving one application graph/memo map and unchanged local defaults. No one-use generic plugin framework.
4. Bind workspace I/O at Location scope. Split mixed host/workspace access intentionally: project bootstrap, config, FS/mutation/search, processes/Git, snapshots, PTY/watchers. Preserve security/path semantics. Unsupported capabilities fail explicitly; never host fallback.
5. Add actor-specific environment lifecycle, durable metadata, private managed storage, credentials and namespace isolation. Implement real agentOS execution, not a fake actor around host commands.
6. Add one sandbox provider and explicit lifecycle/reconnect. E2B is provisional; real provider support needs tests and create reconciliation. No ACP sessions. Docker only if available; never assume Docker/KVM in orb.
7. Add workspace gate + idle-boundary admission behavior, promotion journal/transfer/cutover/service refresh, failure recovery.
8. Expose workspace create/environment/promote/status through SDK. Add public Schema/Protocol/Server contracts only when required; if changed, run client generator from packages/client. Keep APIs honest rather than using previously imagined envelopes.
9. Add SDK examples and deployment docs including host-affinity limitation, state ownership, secret handling, capabilities, and cleanup. Cloudflare and generic provider framework are non-goals.
10. Final review/verification; local conventional commits and PR-ready description. User requested oracle review of design (completed); use further oracle review when explicitly requested or high-impact unresolved questions remain after investigation.

UI was discussed as a future consumer. SDK configuration is the user's final focus. Do not expand into an unrelated CLI configuration/Cloudflare/UI rewrite. Any UI appearance actually changed requires rendered screenshots inspected with view_media.

## Verification matrix

| Contract | Evidence required |
| --- | --- |
| Backward compatibility | Existing sdk-next embedded and import-boundary tests |
| Actor/Effect compatibility | Real registry action roundtrip, typed errors, lifecycle |
| AgentOS persistence | Files survive sleep/reopen and worker restart with same storage |
| Isolation | Two workspaces both using /workspace hold distinct content; guest cannot read host secrets |
| Filesystem contracts | read/edit/write/patch/search/path escape/symlink/stale content tests across backends |
| Process contracts | stdout/stderr, nonzero exit, limits, cancellation, timeout, confirmed termination |
| Session invariants | exact retry, conflict, steer/queue/resume:false, one provider stream per turn |
| Promotion quiescence | concurrent Sessions/mutations/processes; new admissions don't deadlock or prolong drain |
| Cutover | stale-generation work rejected, old captured services cannot write |
| Transfer | binary/untracked/modes/symlinks/large files/Git worktree/historical revert |
| Partial failure | crash before/after provisioning ID, during copy, before commit, after commit before response |
| Sandbox lifetime | wake reconnects same ID; disconnect doesn't delete; missing sandbox visible |
| Host storage | no blank replacement on wrong host/missing volume |
| Security | backend credentials never exposed; permissions stay in canonical leaves |

Commands (from package directories, never test from root):

```sh
# packages/core
bun test test/session-prompt.test.ts test/session-run-coordinator.test.ts
bun test test/location-mutation.test.ts test/file-mutation.test.ts test/process/process.test.ts
bun typecheck

# packages/sdk-next
bun test
bun typecheck

# packages/rivet (once added)
bun test
bun typecheck

# packages/server and affected Schema/Protocol/Client packages
bun typecheck

# packages/client, only after public API changes
bun run generate
```

Tests must use real disposable engine/VM when proving lifecycle. Fakes may test pure state transitions but do not count as external compatibility. Distinguish inability to execute paid/native infrastructure tests from passing tests. Do not weaken scope or call incomplete integration PR-ready.

## Progress checkpoint

- User added E2B and Daytona API keys to the project/orb and requested environment reload plus real lifecycle testing. Authorization covers disposable provider resources for agentOS → full sandbox → agentOS, sleep/resume, destroy mechanics, and cleanup of resources created for these tests. Never print keys. Round-trip migration is now explicitly required, not only one-way promotion; preserve files/metadata/history and fence the old executor in both directions. Destroyed resources must not silently resume under a different identity.
- Parallel agents have implemented the Core workspace admission owner and Session-runner safe-boundary checks, plus workspace-wide Location cache invalidation. Parent integration is still required: close gate, drain existing work, durably commit backend generation, invalidate old scopes, then reopen only when the selected backend is usable. A failed or indeterminate cutover must not automatically reopen stale authority.
- Sandbox Agent 0.4.2 adapter and protocol-level tests now exist, including remote realpath/stat and metadata-aware exclusive writes. Real cloud provisioning and migration are not yet verified. Node asset bundling and isolated test engines run the 65-second command and Core graph on Node and Bun; remaining suite failure is the oversized-payload assertion (engine rejects before actor), and search currently needs dependency/syntax/test integration. No final verification claim.
- Current architecture differs from agentOS's documented OpenCode software integration: our fork's SessionV2/model loop and database stay on the host; only workspace execution lives in agentOS. The documented alternative runs packaged OpenCode inside the VM via agentOS sessions, and can also package our fork through Custom Agents. Core changes are required by our selected split architecture, not by Rivet itself. User asked for this distinction; do not represent the designs as equivalent.
- SDK `Rivet.make(client)` now supplies real actor-backed filesystem and process bindings at logical `/workspace` without mandatory caller-provided I/O. `OpenCode.create({ workspaces })` composes this with the existing session runtime. Ordinary Actors.connect is separate from agentOS execution. No OpenCode subprocess or second model loop is started.
- Core managed locations replace native search/watcher/snapshot/PTY/project-copy layers before initialization. Local default behavior stays unchanged; managed unsupported capabilities fail rather than fall back. Config entries track provenance; workspace executable settings are filtered with warnings and workspace plugin discovery never imports host code. Host-global plugins remain trusted host code, not sandboxed extensions. Full extension/security parity is unfinished.
- New fork APIs expose realpath and atomic exclusive file creation plus mode. Actual mounted-filesystem concurrency test has one winner among 16 exclusive writes. Filesystem RPC preserves errno. AgentOS dependency patches remain removed; development symlinks must still be replaced by a verified @rikalabs release.
- Commands use short StartCommand/CommandStatus/CancelCommand RPCs because Effect SDK 2.3.17 exposes no actionTimeout override and fetch cancellation does not cancel server execution. Command records are bounded and wake-local; a per-wake epoch fences stale SDK retries. Cancel-before-start leaves a tombstone. Status never reruns unknown work. Remaining deterministic tests must cover cleanup failure, concurrent queued filesystem/cancel, and actual wake transitions.
- Passing evidence: real 65-second remote command; actual Core graph FileMutation.create/read and WorkspaceProcess.run through default Rivet binding; 27 Core targeted local/managed tests; 9 Node24 direct guest/termination tests. Full Bun registry tests require subprocess/namespace isolation because Registry.test retains runtime registrations. Tests now use isolated registry cases. Do not claim full Node embedded SDK verification: tsx encounters Core raw .txt imports; source test loading needs its normal asset-build/loader strategy.
- Removed unused raw AgentOS process-spawner prototype after choosing the actor-owned command lifecycle. Do not reintroduce a second process execution route without an actual consumer.
- No package publication, project commit/push, or upstream issue/PR has occurred. Full sandbox provisioning, promotion gate across Sessions, transfer/cutover/recovery, search/Git/snapshot/PTY parity, packaging, and final review remain outstanding. GitHub Actions still lists zero workflows for the fork and returns 403 for Actions permissions/secrets inspection; release cannot be verified through that route yet.
- User requires no added code comments; use descriptive tests as documentation and preserve unrelated existing comments.
- User confirms the fork's GitHub Actions publication secret is `NPM_TOKEN`. The workflow binds it to `NODE_AUTH_TOKEN`; never copy or print its value.
- After implementation is reviewed, tested, and checked against upstream guidelines/style, user authorizes an issue then a focused PR in `rivet-dev/agentos`. Search existing issues/PRs and current source before opening either; reuse relevant reports and adopt an equivalent upstream fix into our fork instead of duplicating it. Keep @rikalabs release machinery and OpenCode integration out of the upstream runtime PR. Continue using fork packages until a verified upstream release supports the required behavior.
- Upstream search found merged https://github.com/rivet-dev/agentos/pull/1551 as a partial predecessor (early child tracking on handshake failure), already present in the fork base; no complete equivalent for affirmative native exit, retained failed-stop ownership, or retryable single-flight explicit termination was found. Related #1535/#1640/#1902 do not establish that contract. Search again immediately before contribution; text search can miss discussions.
- Parallel workers prepared fork-only npm artifact publication and ordinary Rivet Effect workspace actor code. Parent review is ongoing. Fork lifecycle tests now pass 4/4 with explicit native binary path. Actor test currently fails on assuming concurrent RPC arrival order; replace with a serialization assertion allowing either complete command order, not interleaving. No actor/SDK integration completion claim yet.
- Latest checkpoint supersedes the historical spike results below: agentOS fixes now live in `/home/user/workspace/agentos` on `confirmed-shutdown`, not dependency patches. All agentOS patch files and patchedDependencies entries have been removed; unrelated OpenCode patches are unchanged. OpenCode temporarily links the fork's core/runtime packages for development. Replace these links with published `@rikalabs` dependencies before declaring PR readiness.
- User authorizes publishing the fork under `@rikalabs` and requests Node and Bun compatibility. No package has been published. This orb does not currently have the npm credential described by the user; identify its supported release route without exposing secrets. Upstream publication workflows must not run unchanged against upstream destinations.
- Current checks from `packages/rivet`: Node 24.21.0 `node --test --test-timeout=30000 test/*.test.ts`: 8 passed; Bun 1.4.2 `bun test test/agentos.test.ts`: 6 passed; `bun typecheck`: passed. These used symlinked fork TypeScript and the published 0.2.19 Linux native sidecar, not a complete rebuilt release. Bun 1.3.10 previously showed intermittent transport startup/cleanup failures; do not claim all Bun versions supported.
- Fork lifecycle owns the native process before authentication, prevents spawning after termination, and preserves failed termination ownership for retry. The adapter atomically registers confirmed stop before VM disposal. Detached regression now proves the child responds after its root exits, then proves no delayed write after explicit workspace stop. Separate workspace remains usable.
- Follow-up oracle review found no blockers for this private-sidecar lifecycle. Remaining recommended deterministic tests: terminate across pre-spawn lease race; concurrent refused-kill calls and retry; interruption as acquisition finishes and stop failure during scope release. Acquisition remains uninterruptible and may hang if startup never settles. Quiescent-workspace stop does not preempt an active command.
- Release prerequisite: fork source differs from published 0.2.19 native/protocol sources. Rebuild and verify matching client/native/software artifacts before publication; copied software artifacts are development-only. No full-sandbox provider integration or safe promotion is implemented yet.
- Research and oracle plan review completed; findings incorporated above.
- Branch `rivet-sdk` created from local dev; initial worktree clean.
- Published metadata checked; tarballs inspected under `/tmp/opencode-rivet-spike`.
- Root dependency installation completed. New package dependencies installed; bun.lock changed.
- Added `packages/rivet` with lazy Effect-scoped agentOS adapter and real-runtime tests. SDK, Core, and Server integration have not been changed.
- Package typecheck passed. Four real-runtime tests passed: mounted persistence/reopen and output limit, cancellation/no sequential delayed write, relative symlink escape rejection, EOF/deadline enforcement and invalid limit rejection.
- Oracle reviewed the adapter and composition seam. Fixed its concrete timeout and stdin findings. Validation covers those fixes.
- Added an intentionally failing regression: guest Node creates a detached delayed writer; root returns exit 0, but detached.txt appears afterward. `bun run test --test-name-pattern detached` fails with expected false / received true. Do not skip or weaken this assertion to claim command-owned cleanup.
- Ordinary Rivet Effect Actor/State registry action roundtrip passed in the isolated Bun spike, but has not been integrated into the package. Registry lifecycle still needs explicit worker ownership.
- Git and ripgrep software 0.3.3 failed with exit 126 in the earlier spike. Native full-sandbox provisioning was not tested: no Docker daemon and no paid provider provisioned.
- Goal plugin removed from global personal plugins, removal pushed, current plugins reloaded; do not use goal automation.
- No project push, PR, deployment, or project commit performed. This is not PR-ready.

## Blocking lifecycle prerequisite (second oracle review and reproduced runtime evidence)

Published agentOS 0.2.19 deliberately preserves detached guest children after the root exits. Its public process.list only tracks admitted roots; process.tree is VM-wide, not an atomic command-ownership snapshot. Killing all VM processes per command would break concurrent Sessions. Filtering shell text is not a security boundary.

The Core proxy can synthesize exit 1 when its event pump fails without proving guest termination. VM disposal swallows disposeVm failures, and native sidecar disposal can resolve after its final SIGKILL wait expires without affirmative native exit. An explicit private sidecar improves isolation but does not fix that acknowledgment contract by itself.

Sources pinned to the published source revision:

- [Detached child behavior](https://github.com/rivet-dev/agentos/blob/9ae6abbdc48391a75b8336e7832b3e76f42616ee/packages/core/tests/child-process-detached.nightly.test.ts#L18-L116)
- [Core process teardown](https://github.com/rivet-dev/agentos/blob/9ae6abbdc48391a75b8336e7832b3e76f42616ee/packages/core/src/sidecar/rpc-client.ts#L487-L519)
- [Native disposal acknowledgment gap](https://github.com/rivet-dev/agentos/blob/9ae6abbdc48391a75b8336e7832b3e76f42616ee/packages/runtime-core/src/native-client.ts#L165-L231)

Before promotion integration, settle a supported or pinned-patched runtime contract: explicit ownership of command descendants or a workspace-wide VM stop after admission is closed, with affirmative native termination before copying, failure propagation, and no reuse/cutover on indeterminate execution state. Workspace-wide stop is allowed only after all Sessions and mutations are quiescent. It must not be confused with per-command cancellation. Root RPC completion and process-tree polling are not substitutes for this contract.

Do not present ordinary command success, the four passing tests, or a model-independent Actor roundtrip as proof of safe sandbox promotion. The detached regression is a stronger per-command cleanup policy; a different lifecycle policy must be explicit and tested at the actual workspace stop boundary rather than silently removing the test.
