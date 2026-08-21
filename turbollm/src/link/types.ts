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
  /** LATCHED anti-hijack flag: this URL answered as a different machine than the one the
   *  user linked. Set on the probe that saw the change and NEVER cleared by a later probe
   *  — only by an explicit user acknowledgement (PATCH { acknowledgeMachineChange: true }).
   *  A warning that the next successful poll erases is not a warning; the peer keeps
   *  talking to whatever now answers that URL until a human says that is fine.
   *  Optional so an existing config.json needs no migration; absent means false. */
  machineIdChanged?: boolean
  grantedCapabilities: LinkCapability[]
  linkApiVersion: number | null
  status: LinkStatus
  lastSeenAt: string | null
  /** Human-readable reason for the current non-online status — or, when
   *  `machineIdChanged` is latched, for an ONLINE one. */
  lastError: string | null
}

/** The subset of a `LinkRecord` safe to hand to the browser. Deliberately an ALLOWLIST
 *  projection, not a delete-list: `token` is a live bearer credential this machine uses
 *  to authenticate to the host, so building the response by spreading the record and
 *  deleting `token` would leak-by-default the moment a future field is added to
 *  `LinkRecord` — an allowlist fails safe instead. Every admin route that returns a
 *  link (GET /api/v1/links, POST /api/v1/links, PATCH /api/v1/links/:id) must go
 *  through this, never return a raw `LinkRecord` to the client. */
export type RedactedLinkRecord = Omit<LinkRecord, 'token'>

export function redactLink(rec: LinkRecord): RedactedLinkRecord {
  return {
    id: rec.id,
    name: rec.name,
    baseUrl: rec.baseUrl,
    machineId: rec.machineId,
    machineIdChanged: rec.machineIdChanged ?? false,
    grantedCapabilities: rec.grantedCapabilities,
    linkApiVersion: rec.linkApiVersion,
    status: rec.status,
    lastSeenAt: rec.lastSeenAt,
    lastError: rec.lastError,
  }
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

/** One model as advertised by a linked host over `GET /api/link/v1/models`.
 *  Deliberately mirrors that response row exactly — notably it has NO `path`: the host
 *  does not disclose its filesystem layout, so the peer must never expect one. */
export interface RemoteModel {
  key: string
  name: string
  quant: string | null
  nativeCtx: number | null
  vision: boolean
  loaded: boolean
}

/** One download as advertised by a linked host over `GET /api/link/v1/downloads`.
 *
 *  An ALLOWLIST projection of `DownloadRecord`, for the same reason `RedactedLinkRecord`
 *  is one: a delete-list leaks by default the moment a field is added upstream. Every
 *  omission below is deliberate, and the rule they follow is **no host filesystem detail
 *  crosses the façade** — not "strip the field someone happened to name". This feature has
 *  paid for that rule three times (the engine's `launchCommand`, then `engine.error`'s log
 *  tail, then this).
 *
 *  Omitted, and why:
 *   - `dest` — an ABSOLUTE path on the host's disk. The headline leak.
 *   - `url` — the source URL. The peer either chose the repo itself or has no use for it,
 *     and it is the field a future signed/credentialed download URL would land in.
 *   - `sha256` — not host-private, but nothing peer-side renders it; kept off the wire so
 *     the surface stays as small as what the peer actually needs. */
export interface RemoteDownload {
  id: string
  /** Bare destination FILENAME — never a path fragment. See `redactDownload`. */
  name: string
  /** Source HF repo ("owner/name"), or '' for a raw-URL import. Public either way. */
  repo: string
  total: number
  received: number
  status: string
  /** A FIXED string when the download failed, `null` otherwise — never the host's own
   *  message. `DownloadRecord.error` holds a raw `Error.message`, which for an fs failure
   *  is a full absolute path ("ENOENT … open 'D:\\models\\x.gguf.part'"). The peer still
   *  needs to see THAT it failed; it has no business seeing where. */
  error: string | null
  bytesPerSec: number
  createdAt: string
}

/** Generic stand-in for a host-authored download error message. */
export const REMOTE_DOWNLOAD_ERROR = 'The download failed on the host machine.'

/** Project a host `DownloadRecord` onto the wire shape a peer may see.
 *
 *  Typed structurally rather than against `DownloadRecord` so link/types.ts stays free of a
 *  downloads import; the façade route is what binds the two, and `link-routes.downloads.test.ts`
 *  pins the exact key set this produces. */
export function redactDownload(rec: {
  id: string
  name: string
  repo: string
  total: number
  received: number
  status: string
  error: string | null
  bytesPerSec: number
  createdAt: string
}): RemoteDownload {
  return {
    id: rec.id,
    // `basename`-equivalent without a node:path import: DownloadManager always sets `name`
    // to a bare filename, but this is a trust boundary and a defensive last segment costs
    // nothing if a future caller ever puts a fragment in there.
    name: rec.name.split(/[\\/]/).pop() ?? rec.name,
    repo: rec.repo,
    total: rec.total,
    received: rec.received,
    status: rec.status,
    error: rec.error === null ? null : REMOTE_DOWNLOAD_ERROR,
    bytesPerSec: rec.bytesPerSec,
    createdAt: rec.createdAt,
  }
}

