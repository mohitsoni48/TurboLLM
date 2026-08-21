/** Turbo Link capability set (ADR-376 §1). Permissions ride on the API token IAM-style:
 *  whatever the token grants is what the linked peer may do.
 *
 *  `engines:*` is deliberately ABSENT and must stay absent — engine add/scan executes a
 *  caller-supplied binary path, and ADR-139 settled that no remote caller gets that, valid
 *  key or not. Remote Engines rows are read-only. types.test.ts enforces this. */
export const LINK_CAPABILITIES = [
  'models:use',
  'models:wake',
  'models:load',
  'models:unload',
  'downloads:read',
  'downloads:write',
  'config:read',
  'config:write',
] as const

export type LinkCapability = (typeof LINK_CAPABILITIES)[number]

/** What a link token is allowed to do. Attached to an ApiKey as `grant`.
 *  ABSENT grant = a normal, pre-Turbo-Link full-access key (every existing key). */
export interface LinkGrant {
  capabilities: LinkCapability[]
  /** Model keys this token may address. Absent or empty = every local model. */
  models?: string[]
}

/** Peer-side link lifecycle state (spec §4.5). Three failure states, deliberately
 *  not collapsed into one "offline". */
export type LinkStatus = 'unknown' | 'online' | 'unreachable' | 'revoked' | 'incompatible'

/** The peer's record of a host it has linked to. Stored in config.links.
 *  `token` is the RAW token — the peer must be able to present it. This is no new class
 *  of secret: config.json already stores tavilyApiKey/kagiApiKey in plaintext (ADR-376). */
export interface LinkRecord {
  id: string
  /** Display name, seeded from the host's machineName at handshake, user-editable. */
  name: string
  /** Base origin of the host, e.g. https://foo.trycloudflare.com — no trailing slash.
   *  EDITABLE: a Kaggle host hands back a new tunnel URL every session (spec §8.2). */
  baseUrl: string
  token: string
  machineId: string | null
  grantedCapabilities: LinkCapability[]
  linkApiVersion: number | null
  status: LinkStatus
  lastSeenAt: string | null
  /** Human-readable reason for the current non-online status. */
  lastError: string | null
}

/** Host's reply to POST /api/link/v1/hello. */
export interface HelloResponse {
  machineId: string
  machineName: string
  appVersion: string
  linkApiVersions: number[]
  capabilities: LinkCapability[]
  /** Present only when the grant narrows the model allowlist. */
  models?: string[]
}
