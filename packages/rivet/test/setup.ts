import { sidecarPath } from "./sidecar-path.ts"

process.env.AGENTOS_SIDECAR_BIN ||= sidecarPath()
