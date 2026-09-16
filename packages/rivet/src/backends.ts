export * as Backends from "./backends.ts"

import { existsSync } from "node:fs"
import { E2B } from "./e2b.ts"
import { Local } from "./local.ts"
import type { Workload } from "./workload.ts"
import type { Backend } from "./workspace-schema.ts"

export interface Identity {
  readonly sandboxId: string
  readonly root?: string
}

export interface Module {
  /** Provision a fresh workload, or attach when the backend requires a caller-supplied root. */
  readonly create: (options: { readonly root?: string }) => Promise<Workload.Interface>
  /** Reacquire an initialized workload from its persisted identity. */
  readonly reconnect: (identity: { sandboxId: string; boundaryToken?: string; root?: string }) => Promise<Workload.Interface>
  /** Return the reason the persisted identity is unusable, or undefined when it is complete. */
  readonly validate: (identity: { sandboxId?: string; boundaryToken?: string; root?: string }) => string | undefined
}

const modules: Record<Backend, Module> = {
  local: {
    // A caller-supplied root attaches to an existing directory; omitting one provisions a fresh host directory.
    create: (options) => Local.Workload.create({ root: options.root }),
    reconnect: (identity) => {
      if (!identity.root) return Promise.reject(new globalThis.Error("Local workspace root is missing"))
      return Local.Workload.reconnect({ sandboxId: identity.sandboxId, root: identity.root })
    },
    validate: (identity) => {
      if (!identity.root) return "Local workspace root is missing"
      if (!existsSync(identity.root)) return "Local workspace root no longer exists"
      return undefined
    },
  },
  e2b: {
    create: () => E2B.Workload.create(),
    reconnect: (identity) => {
      if (!identity.sandboxId) return Promise.reject(new globalThis.Error("E2B identity is missing"))
      return E2B.Workload.reconnect({ sandboxId: identity.sandboxId })
    },
    validate: (identity) => {
      if (!identity.sandboxId) return "E2B identity is missing"
      return undefined
    },
  },
}

export const create = (backend: Backend, options: { readonly root?: string } = {}) => modules[backend].create(options)

export const reconnect = (backend: Backend, identity: { sandboxId: string; boundaryToken?: string; root?: string }) =>
  modules[backend].reconnect(identity)

export const validate = (backend: Backend, identity: { sandboxId?: string; boundaryToken?: string; root?: string }) =>
  modules[backend].validate(identity)
