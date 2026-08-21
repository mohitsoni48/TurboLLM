// Turbo Link (ADR-376): typed client for the admin surface in
// turbollm/src/api/link-admin-routes.ts. Mirrors turbollm/src/link/types.ts +
// capabilities.ts — kept in sync by hand, same convention as lib/types.ts.
//
// Two roles, two panels in TurboLinkSection.tsx:
// - Host: mint a scoped token for another machine (mintLink), see who has linked in
//   (listInbound).
// - Peer: link to another machine's host (addLink), and manage the machines this one
//   has linked to (listLinks/patchLink/deleteLink).

// `request()` in api.ts is module-private, so every sibling API module (code-api.ts,
// chat-api.ts, onboarding-api.ts, routine-api.ts, agent-api.ts) re-implements the same
// shape locally against the shared ApiError/authHeaders — this follows that convention
// rather than hand-rolling a different fetch pattern.
import { ApiError, authHeaders } from './api'

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(),
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const res = await fetch(path, { ...init, headers, body })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? safeJson(text) : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(
      env?.error?.code ?? 'http_error',
      env?.error?.message ?? `Request failed with status ${res.status}.`,
      res.status,
    )
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// LINK_CAPABILITIES / LINK_PRESETS live in link-constants.ts, not here: this module is
// wholesale `vi.mock`'d by TurboLinkSection.test.tsx (per the task brief's own mock),
// so a constant defined only here would come back `undefined` under that mock. The type
// itself is just erased at compile time, so it's safe to import/re-export from here too.
import type { LinkCapability } from './link-constants'
export type { LinkCapability } from './link-constants'

/** Peer-side link lifecycle state. Three failure states, deliberately not collapsed
 *  into one "offline" — each carries its own actionable `lastError` on the record. */
export type LinkStatus = 'unknown' | 'online' | 'unreachable' | 'revoked' | 'incompatible'

/** This machine's record of a host it has linked to (GET /api/v1/links,
 *  POST /api/v1/links, PATCH /api/v1/links/:id). `grantedCapabilities` is what the
 *  host reported at handshake — render capability chips from this, never from a guess.
 *
 *  Deliberately has NO `token` field, unlike the server's internal `LinkRecord`
 *  (turbollm/src/link/types.ts) — the server-side `redactLink()` allowlist projection
 *  strips the raw bearer credential before any of these three routes ever serializes a
 *  link to the browser, so this type mirrors what's actually on the wire, not the
 *  server's full internal record. */
export interface LinkRecord {
  id: string
  name: string
  /** Editable — a Kaggle host hands back a new tunnel URL every session, so relinking
   *  is PATCH baseUrl, not delete-and-recreate. */
  baseUrl: string
  machineId: string | null
  grantedCapabilities: LinkCapability[]
  linkApiVersion: number | null
  status: LinkStatus
  lastSeenAt: string | null
  /** Human-readable reason for a non-online status. Always show this, never a bare
   *  "offline" — see status copy in TurboLinkSection.tsx. */
  lastError: string | null
}

/** One machine that has linked TO this one (GET /api/v1/links/inbound), derived from
 *  a granted API key. */
export interface InboundLink {
  id: string
  name: string
  capabilities: LinkCapability[]
  models: string[] | null
  createdAt: string
  lastUsedAt: string | null
}

/** Result of minting a scoped token for another machine. `token`/`linkString` are
 *  revealed exactly once — only the hash is stored server-side, so they can never be
 *  re-shown after this response. */
export interface MintedLink {
  keyId: string
  token: string
  linkString: string
}

/** Host side: mint a scoped token for another machine. */
export function mintLink(input: { name: string; capabilities: LinkCapability[]; models?: string[] }): Promise<MintedLink> {
  return request<MintedLink>('/api/v1/links/mint', { method: 'POST', json: input })
}

/** Host side: who has linked in, with what capabilities. */
export function listInbound(): Promise<InboundLink[]> {
  return request<{ inbound: InboundLink[] }>('/api/v1/links/inbound').then((r) => r.inbound)
}

/** Peer side: machines this one has linked to. */
export function listLinks(): Promise<LinkRecord[]> {
  return request<{ links: LinkRecord[] }>('/api/v1/links').then((r) => r.links)
}

/** Peer side: add a link from a pasted link string. A junk string is a 400 (ApiError). */
export function addLink(linkString: string): Promise<LinkRecord> {
  return request<{ link: LinkRecord }>('/api/v1/links', { method: 'POST', json: { linkString } }).then((r) => r.link)
}

/** Peer side: edit a link's base URL and/or name — the Kaggle relink path — and re-probe. */
export function patchLink(id: string, patch: { baseUrl?: string; name?: string }): Promise<LinkRecord> {
  return request<{ link: LinkRecord }>(`/api/v1/links/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch }).then((r) => r.link)
}

/** Peer side: remove a link. */
export function deleteLink(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/links/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
