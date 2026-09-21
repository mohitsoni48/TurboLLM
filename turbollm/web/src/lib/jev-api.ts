// Jev (ADR-434 (c), (d), ADR-439): the three gateway endpoints a Jev model answers (classify,
// rerank and systemone), the daemon probe for what a load would interrupt, and the curl the
// playground hands the user.
//
// `request()` in api.ts is module-private, so every sibling API module (link-api.ts,
// code-api.ts, chat-api.ts, …) re-implements the same shape locally against the shared
// ApiError/authHeaders — this follows that convention rather than exporting it.
import { ApiError, authHeaders } from './api'
import type { SystemOneRequest, SystemOneResponse } from './systemone-types'
import type { ActiveWork, ClassifyRequest, ClassifyResponse, RerankRequest, RerankResponse } from './types'

/** Upper bound on hypotheses (check) or options (choose) in one request. Mirrors
 *  MAX_JEV_INPUTS in src/gateway/jev-endpoints.ts, so a panel can refuse before the
 *  round trip rather than showing the user a 400. */
export const MAX_JEV_INPUTS = 128

export function classify(req: ClassifyRequest): Promise<ClassifyResponse> {
  return request<ClassifyResponse>('/v1/classify', { method: 'POST', json: req })
}

export function rerank(req: RerankRequest): Promise<RerankResponse> {
  return request<RerankResponse>('/v1/rerank', { method: 'POST', json: req })
}

export function systemone(req: SystemOneRequest): Promise<SystemOneResponse> {
  return request<SystemOneResponse>('/v1/systemone', { method: 'POST', json: req })
}

export function getActivity(): Promise<ActiveWork> {
  return request<ActiveWork>('/api/v1/activity')
}

/** The exact command for this run, ready to paste. It NEVER contains the stored key:
 *  this is the view people screenshot. From a non-loopback origin, where the daemon
 *  does demand a key, it leads with a comment saying to add the header yourself. */
export function buildCurl(origin: string, endpoint: 'classify' | 'rerank' | 'systemone', body: object): string {
  const command = [
    `curl ${origin}/v1/${endpoint} \\`,
    '  -H "content-type: application/json" \\',
    `  -d '${shellQuoted(JSON.stringify(body))}'`,
  ]
  return (needsAuthHint(origin) ? [AUTH_HINT, ...command] : command).join('\n')
}

const AUTH_HINT = '# add -H "X-TurboLLM-Auth: <your key>"'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** An origin we cannot parse is treated as remote: an extra comment line costs nothing,
 *  a missing one leaves the user with a command that 401s and no idea why. */
function needsAuthHint(origin: string): boolean {
  try {
    return !LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return true
  }
}

/** A single quote inside the user's own text would close curl's -d argument, so it is
 *  written the only way POSIX shells accept inside single quotes: '\'' — end, escape, reopen. */
function shellQuoted(json: string): string {
  return json.replaceAll("'", "'\\''")
}

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
