// Code launchpad API client — mirrors chat-api.ts's conventions (req() helper, the
// hand-rolled SSE line parser) against turbollm/src/code/code-routes.ts.
import type { Conversation } from './chat-types'
import type { CodeSession, CodeSessionFilter, CodeStats, CodeStatsRange, CodeStreamEvent, CreateCodeSessionParams } from './code-types'
import { ApiError, authHeaders } from './api'
import { markCodeAuthNeeded, clearCodeAuthNeeded } from './auth-signal'

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(), ...((init?.headers as Record<string, string>) ?? {}) }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json) }
  const res = await fetch(path, { ...init, headers, body })
  // Code always requires a key from a non-host device (auth.ts's codeAuth), independent of
  // whether the rest of the app is open — App.tsx's own key prompt only watches the global
  // /status poll, which never 401s for this gate, so surface it via a shared signal instead.
  if (res.status === 401) markCodeAuthNeeded()
  else if (res.ok) clearCodeAuthNeeded()
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  return data as T
}

export function createCodeSession(params: CreateCodeSessionParams): Promise<{ sessionId: string; convId: string }> {
  return req('/api/v1/code/sessions', { method: 'POST', json: params })
}

export function listCodeSessions(filter: CodeSessionFilter = 'active'): Promise<{ sessions: CodeSession[] }> {
  return req(`/api/v1/code/sessions?filter=${filter}`)
}

/** Launchpad "Coding activity" real stats — replaces code-mock.ts's CODE_STATS/mockSessionDays. */
export function getCodeStats(range: CodeStatsRange = 'all'): Promise<CodeStats> {
  return req(`/api/v1/code/stats?range=${range}`)
}

/** Archives (or unarchives) a session — it stays fully intact, just hidden from the default
 *  (active) sidebar list. */
export function archiveCodeSession(id: string, archived: boolean): Promise<{ ok: true; archived: boolean }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', json: { archived } })
}

/** Permanently deletes a session — messages, working doc, and the session record. */
export function deleteCodeSession(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** `/clear` — hides the conversation so far (repo/worktree/branch untouched, nothing deleted).
 *  Rejects with code 'nothing_to_clear' (400) when there's nothing to clear or it's already
 *  cleared up to the latest message. */
export function clearCodeSession(id: string): Promise<{ ok: true; clearedUpToMessageId: string }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/clear`, { method: 'POST', json: {} })
}

/** `/resume` — undoes a /clear, restoring the full conversation. Rejects with code
 *  'not_cleared' (400) when the session hasn't been cleared. */
export function resumeCodeSession(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST', json: {} })
}

/** Reverts the transcript to just before `messageId` — reuses the same clear/resume mechanism
 *  (nothing is deleted; /resume still un-hides it), and returns the message's ORIGINAL text so
 *  the caller can refill the composer with it verbatim. `revertFiles`, when true, ALSO
 *  reverse-applies every edit-tool patch recorded for the discarded messages (revert.ts) —
 *  `revertedFiles`/`failedFiles` report which paths actually changed vs. couldn't be reverted
 *  cleanly (drifted, missing, or outside the repo). Rejects 409 while a run is active. */
export function revertCodeSession(
  id: string,
  messageId: string,
  revertFiles?: boolean,
): Promise<{ ok: true; clearedUpToMessageId: string; revertText: string; revertedFiles: string[]; failedFiles: string[] }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/revert`, { method: 'POST', json: { messageId, revertFiles } })
}

export interface CodeSessionDetail {
  session: CodeSession
  conversation: Conversation
  doc: string | null
  /** True when a run is live in the daemon right now — the frontend reconnects the stream when
   *  this is set on load, instead of assuming a fresh page has nothing in flight. */
  running: boolean
  /** Tasks waiting behind the active turn (server-side queue) — restores the "Queued" chips
   *  after a reload/reconnect. */
  queued: string[]
}
export function getCodeSession(id: string): Promise<CodeSessionDetail> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}`)
}

export function stopCodeSession(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST', json: {} })
}

/** Changes a session's mode (auto/plan/ask) for its NEXT run — the mode picker is
 *  editable at any stage (launchpad AND mid-session), not just at creation. */
export function updateCodeSessionMode(id: string, mode: string): Promise<{ ok: true; mode: string }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/mode`, { method: 'PATCH', json: { mode } })
}

/** Renames a session's title — mirrors the chat conversation rename endpoint. */
export function updateCodeSessionTitle(id: string, title: string): Promise<{ ok: true; title: string }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/title`, { method: 'PATCH', json: { title } })
}

/** Manually summarizes history-so-far into one summary (the `/compact` composer command) so
 *  future turns replay the summary instead of every raw message. Blocked (409) while a run is
 *  active. Rejects with code 'nothing_to_compact' (400) when history is already short enough
 *  that pi found nothing worth summarizing. */
export function compactCodeSession(id: string, instructions?: string): Promise<{ ok: true; summary: string; upToMessageId: string; tokensBefore: number }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(id)}/compact`, { method: 'POST', json: { instructions } })
}

/** Start (or queue) a turn. Returns immediately — the run is owned by the daemon, NOT by this
 *  request, so it keeps executing even if this fetch's connection is dropped. An empty `content`
 *  runs the seeded task (first turn); a non-empty one is a follow-up. `queued` is true when the
 *  turn had to wait behind an already-active run. Watch the run via {@link streamCodeSession}.
 *  `promptOverride`, when given, is what actually gets PROMPTED to the model this turn — `content`
 *  is still what's stored/shown verbatim as the user's message. Used to steer the model toward
 *  invoke_skill from the "/skillid task" composer shorthand without altering the founder's own
 *  typed message (see CodeSessionScreen.tsx's skill picker — it used to rewrite `content` itself,
 *  which the founder explicitly asked to stop). `contextFiles`, when given, are absolute paths
 *  picked via the composer's "Add context" file browser — stored as attachment chips on the
 *  message, folded server-side into a "read this file" nudge for this turn's prompt. */
export async function startCodeRun(
  sessionId: string,
  content: string,
  thinkingBudget?: number,
  promptOverride?: string,
  contextFiles?: string[],
): Promise<{ ok: true; queued: boolean; userMessageId: string }> {
  return req(`/api/v1/code/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    json: {
      content: content || undefined,
      promptOverride: promptOverride || undefined,
      contextFiles: contextFiles?.length ? contextFiles : undefined,
      thinkingBudget: thinkingBudget !== undefined && thinkingBudget !== -1 ? thinkingBudget : undefined,
    },
  })
}

/** (Re)connect to a session's run stream from `fromSeq` (the last ring-buffer seq already seen;
 *  0 for a fresh load). The daemon replays buffer.since(fromSeq) then live-tails. Dropping this
 *  connection (abort/navigate) does NOT abort the run — that's the whole point. Each yielded
 *  event carries its `seq` (from the SSE `id:` field) so the caller can reconnect from where it
 *  left off. Same hand-rolled SSE line parser as chat-api.ts, extended to read `id:`. */
export async function* streamCodeSession(
  sessionId: string,
  fromSeq: number,
  signal: AbortSignal,
): AsyncGenerator<CodeStreamEvent> {
  const res = await fetch(`/api/v1/code/sessions/${encodeURIComponent(sessionId)}/stream?fromSeq=${fromSeq}`, {
    method: 'GET',
    headers: { ...authHeaders() },
    signal,
  })
  if (res.status === 401) markCodeAuthNeeded()
  else if (res.ok) clearCodeAuthNeeded()
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    const env = (() => { try { return JSON.parse(text) } catch { return undefined } })() as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      let event = ''
      let seq: number | undefined
      for (const line of lines) {
        if (line.startsWith('event: ')) { event = line.slice(7).trim() }
        else if (line.startsWith('id: ')) { const n = Number.parseInt(line.slice(4).trim(), 10); seq = Number.isFinite(n) ? n : undefined }
        else if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim()
          try {
            const data = JSON.parse(raw)
            if (event) yield { event, data, seq } as CodeStreamEvent
          } catch { /* skip malformed */ }
          event = ''
          seq = undefined
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
