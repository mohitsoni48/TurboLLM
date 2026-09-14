// Remote access (ADR-422): typed client for turbollm/src/remote/routes.ts. Mirrors
// turbollm/src/remote/types.ts — kept in sync by hand, the same convention link-api.ts and
// lib/types.ts follow.
import { useQuery } from '@tanstack/react-query'
import { ApiError, authHeaders } from './api'

export type RemoteProviderId =
  | 'cloudflare-quick'
  | 'cloudflare-named'
  | 'tailscale-serve'
  | 'tailscale-funnel'
  | 'ngrok'
  | 'custom'

export type RemoteState =
  | { kind: 'off' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'needs-setup'; reason: string }
  | { kind: 'starting' }
  | { kind: 'connected'; url: string; since: string }
  | { kind: 'reconnecting'; attempt: number; lastError: string }
  | { kind: 'failed'; reason: string }

export interface RemoteStatus {
  provider: RemoteProviderId
  enabled: boolean
  state: RemoteState
  url: string
  ingressPort: number | null
}

/** Is this provider reachable by anyone on the internet?
 *
 *  Tailscale Serve is the one that is NOT: it is tailnet-only, so an "exposing to the
 *  internet" confirmation there would be crying wolf — and a warning that fires when it
 *  shouldn't stops being read when it should (spec 30 §7.2). The chip uses this same
 *  predicate to pick its wording. */
export function isPublicProvider(id: RemoteProviderId): boolean {
  return id !== 'tailscale-serve'
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders() }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const res = await fetch(path, { ...init, headers, body })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed (${res.status}).`, res.status)
  }
  return data as T
}

export const getRemoteStatus = () => request<RemoteStatus>('/api/v1/remote/status')
// `token` is present exactly once per successful start (ADR-422 §6.3): the store keeps only
// a hash, so this response is the only moment the raw value exists. Optional because a
// caller-side error, or a start that never reaches the mint step, carries none.
export const startRemote = () => request<{ state: RemoteState; token?: string }>('/api/v1/remote/start', { method: 'POST' })
export const stopRemote = () => request<{ state: RemoteState; revoked?: number }>('/api/v1/remote/stop', { method: 'POST' })
export const preflightRemote = (provider: RemoteProviderId) =>
  request<{ provider: RemoteProviderId; state: RemoteState }>('/api/v1/remote/preflight', { method: 'POST', json: { provider } })

/** Polls while remote access is transitional so the pane and the chip both track a
 *  reconnect without the user refreshing. Six seconds matches the cadence the Code session
 *  list already uses. */
export function useRemoteStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['remote-status'],
    queryFn: getRemoteStatus,
    enabled,
    refetchInterval: 6_000,
    retry: false,
  })
}
