// Jev (ADR-434 (c), (d), ADR-439): the playground's System One run, the daemon probe for what a
// load would interrupt, and the curl the playground hands the user for any of the three gateway
// endpoints a Jev model answers (classify, rerank and systemone).
//
// `request()` in api.ts is module-private, so every sibling API module (link-api.ts,
// code-api.ts, chat-api.ts, …) re-implements the same shape locally against the shared
// ApiError/authHeaders — this follows that convention rather than exporting it.
import { ApiError, authHeaders } from './api'
import type { SystemOneRequest, SystemOneResponse } from './systemone-types'
import type { ActiveWork } from './types'

/** Documentation mirror of MAX_JEV_INPUTS in src/gateway/jev-serving.ts: the batch cap of /v1/classify
 *  and /v1/rerank and the chunk size /v1/systemone splits its hypotheses into. Nothing in the web app
 *  reads it. */
export const MAX_JEV_INPUTS = 128

/** The daemon's playground run (src/api/systemone-job.ts): `idle` before any. `request` is the body the run answers,
 *  `response` /v1/systemone's own answer once `done`, `error` its refusal once `error`. */
export interface PlaygroundRun {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  id?: string
  request?: SystemOneRequest
  response?: SystemOneResponse
  error?: { code: string; message: string }
  startedAt?: string
  finishedAt?: string
}

// The playground runs as a daemon job, not as a /v1/systemone call of its own: that route lives as long as its client,
// so closing, reloading or leaving the screen mid-run threw the run away, and an answer lived only in its response.
// The job outlives the page; a page that comes back reads it here. The curl the playground shows still names
// /v1/systemone, the route an API client calls.
const PLAYGROUND_RUN_PATH = '/api/v1/jev/playground/run'

/** Starts a run of `req` and answers at once with it running. 409 `run_in_progress` while one already runs. */
export async function startPlaygroundRun(req: SystemOneRequest): Promise<PlaygroundRun> {
  return playgroundRunOf(await request<unknown>(PLAYGROUND_RUN_PATH, { method: 'POST', json: req }))
}

/** The run that is running, or the last one to end. */
export async function getPlaygroundRun(): Promise<PlaygroundRun> {
  return playgroundRunOf(await request<unknown>(PLAYGROUND_RUN_PATH))
}

/** Cancels the run `id` names, if it is still running (a later run is never cancelled by it). */
export async function cancelPlaygroundRun(id: string): Promise<PlaygroundRun> {
  return playgroundRunOf(await request<unknown>(`${PLAYGROUND_RUN_PATH}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

const NOT_A_SYSTEMONE_RESPONSE = 'The server answered, but not with a System One response.'

const NOT_A_PLAYGROUND_RUN = 'The server answered, but not with a text classification run.'

const RUN_STATES: ReadonlySet<unknown> = new Set(['idle', 'running', 'done', 'error', 'cancelled'])

/** A finished run is held to what the playground reads of its answer, as the /v1/systemone reply was. */
function playgroundRunOf(reply: unknown): PlaygroundRun {
  if (!isPlainRecord(reply) || !RUN_STATES.has(reply.state)) throw new ApiError('bad_response', NOT_A_PLAYGROUND_RUN, 200)
  if (reply.state === 'done' && !isSystemOneResponse(reply.response)) {
    throw new ApiError('bad_response', NOT_A_SYSTEMONE_RESPONSE, 200)
  }
  return reply as unknown as PlaygroundRun
}

/** `answers` and `usage` are what the playground reads without checking; the answers inside are
 *  still rendered defensively by AnswerCard. */
function isSystemOneResponse(reply: unknown): reply is SystemOneResponse {
  return isPlainRecord(reply) && isPlainRecord(reply.answers) && isPlainRecord(reply.usage)
    && typeof reply.usage.input_tokens === 'number'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
