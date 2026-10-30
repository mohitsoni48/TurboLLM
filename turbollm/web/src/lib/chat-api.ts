import type { Conversation, Folder, Message, ChatFrame, MemoryFact } from './chat-types'
import { ApiError, authHeaders } from './api'
import { markHostKeyNeeded } from './auth-signal'
import { readSseStream } from './sse'
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from '../components/ReasoningEffortSelect'

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(), ...((init?.headers as Record<string, string>) ?? {}) }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json) }
  const res = await fetch(path, { ...init, headers, body })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    // "Always Allow" refused for want of a valid key: ask for one (auth-signal.ts).
    if (res.status === 403 && env?.error?.code === 'api_key_required') markHostKeyNeeded()
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  return data as T
}

export interface SysInfoGpu { name: string; vramMb: number }
export interface SysInfo { gpus: SysInfoGpu[]; ramMB: number; cpu: string; os: string; cores: number }
export function fetchSysInfo(): Promise<SysInfo> { return req<SysInfo>('/api/v1/sysinfo') }

export function listConversations(q?: string): Promise<{ conversations: Conversation[] }> {
  return req(`/api/v1/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`)
}

export function createConversation(partial?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'toolPolicy' | 'skillIds' | 'allowedTools' | 'sampling' | 'preserveThinking'>>): Promise<Conversation> {
  return req('/api/v1/conversations', { method: 'POST', json: partial ?? {} })
}

export function getConversation(id: string): Promise<Conversation> {
  return req(`/api/v1/conversations/${encodeURIComponent(id)}`)
}

export function updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'sampling' | 'skillIds' | 'preserveThinking'>>): Promise<Conversation> {
  return req(`/api/v1/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch })
}

export function deleteConversation(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Stops the reply `messageId` of the chat, if it still holds the chat (`stopped: false` when it does not: it ended,
 *  or another tab or device stopped it, or a newer reply runs there now). Without `messageId`, whatever runs there.
 *  Stop is what stops a reply: closing or leaving the page only stops following it. */
export function stopGeneration(conversationId: string, messageId?: string): Promise<{ ok: true; stopped?: boolean }> {
  return req('/api/v1/chat/stop', { method: 'POST', json: { conversationId, messageId } })
}

// ── folders (v10) ─────────────────────────────────────────────────────────────

export function listFolders(): Promise<{ folders: Folder[] }> {
  return req('/api/v1/folders')
}

export function createFolder(name: string): Promise<Folder> {
  return req('/api/v1/folders', { method: 'POST', json: { name } })
}

export function renameFolder(id: string, name: string): Promise<Folder> {
  return req(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'PATCH', json: { name } })
}

export function deleteFolder(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Move a conversation into a folder, or out of any folder when folderId is null. */
export function moveConversationToFolder(convId: string, folderId: string | null): Promise<Conversation> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/folder`, { method: 'PATCH', json: { folderId } })
}

export function editMessage(convId: string, msgId: string, content: string): Promise<{ messages: Message[] }> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}`, { method: 'PUT', json: { content } })
}

export function deleteMessage(convId: string, msgId: string): Promise<{ ok: true }> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' })
}

export function regenerate(convId: string): Promise<{ ok: true }> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/regenerate`, { method: 'POST', json: {} })
}

// ── Compaction (ADR-420) ─────────────────────────────────────────────────────

export function compactConversation(id: string, model?: string): Promise<Conversation> {
  return req(`/api/v1/conversations/${encodeURIComponent(id)}/compact`, { method: 'POST', json: model ? { model } : {} })
}

export function undoCompaction(id: string): Promise<Conversation> {
  return req(`/api/v1/conversations/${encodeURIComponent(id)}/compact`, { method: 'DELETE' })
}

// ── Auto-memory (Release 3) ─────────────────────────────────────────────────────

export function listMemoryFacts(): Promise<{ facts: MemoryFact[] }> {
  return req('/api/v1/memory')
}

export function deleteMemoryFact(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Chat branching (GitHub #52) ────────────────────────────────────────────────

/** All siblings (active + inactive) sharing a message's variant_group, oldest first —
 *  for the ‹ 1/2 › branch switcher. Only meaningful when message.variantGroup is set. */
export function getMessageVariants(convId: string, msgId: string): Promise<{ variants: Message[] }> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}/variants`)
}

/** Switch which sibling in a variant group is active/shown. */
export function activateVariant(convId: string, msgId: string): Promise<{ messages: Message[] }> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}/activate`, { method: 'POST', json: {} })
}

// ── Tool-call approval gate ───────────────────────────────────────────────────

/** Respond to a tool call awaiting interactive approval. Throws (via `req`'s
 *  ApiError convention) on non-2xx — e.g. 404 if the approval already timed out
 *  or was resolved by another client. */
export function respondToolApproval(
  convId: string,
  toolCallId: string,
  toolName: string,
  decision: 'allow' | 'deny' | 'allow_chat' | 'always_allow',
): Promise<void> {
  return req(`/api/v1/conversations/${encodeURIComponent(convId)}/tool-calls/${encodeURIComponent(toolCallId)}/approve`, {
    method: 'POST',
    json: { toolName, decision },
  })
}

/** The tool catalog available to the model, for the Tool Permissions settings UI. */
export function fetchAvailableTools(): Promise<Array<{ name: string; description: string }>> {
  return req<{ tools: Array<{ name: string; description: string }> }>('/api/v1/tools').then((r) => r.tools)
}

/** Streaming send — returns an async generator that yields typed SSE events. */
export async function* sendMessage(
  convId: string,
  content: string,
  signal: AbortSignal,
  images?: string[],
  docContext?: string,
  textAttachments?: string[],
  thinkingBudget?: number,
  reasoningEffort?: ReasoningEffort,
  /** Turbo Link (ADR-376): the id the model picker selected. Sent ONLY when it names
   *  another machine — a qualified `<machine>/<model>` id. Absent means "whatever this
   *  machine has loaded", which is what every send did before Turbo Link and still does. */
  model?: string,
  /** Runs once the daemon has answered 200: from then on the turn exists (followChatTurn). */
  onAccepted?: () => void,
): AsyncGenerator<ChatFrame> {
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content, images: images?.length ? images : undefined, docContext: docContext || undefined, textAttachments: textAttachments?.length ? textAttachments : undefined, thinkingBudget: thinkingBudget !== undefined && thinkingBudget !== -1 ? thinkingBudget : undefined, reasoningEffort: reasoningEffort !== undefined && reasoningEffort !== DEFAULT_REASONING_EFFORT ? reasoningEffort : undefined, model: model || undefined }),
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    const env = (() => { try { return JSON.parse(text) } catch { return undefined } })() as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  onAccepted?.()
  yield* chatSseEvents(res.body)
}

/** Typed chat events off a turn's SSE body, each with its seq (the frame's `id:`) when it has one — unnamed or
 *  malformed (non-JSON) messages skipped. */
async function* chatSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatFrame> {
  for await (const msg of readSseStream(body)) {
    if (!msg.event) continue
    let data: unknown
    try { data = JSON.parse(msg.data) } catch { continue /* skip malformed */ }
    const seq = msg.id !== undefined && /^\d+$/.test(msg.id) ? Number(msg.id) : undefined
    yield { event: msg.event, data, seq } as ChatFrame
  }
}

/** The frames of the chat's running reply, as GET /api/v1/conversations/:id/stream serves them: without `run`, the
 *  reply that holds the chat now (an empty stream when none does); with `run` (a reply's id) and `fromSeq`, the rest
 *  of that reply from the cursor, while the daemon still has it. Errors as {@link sendMessage}'s. */
export async function* streamConversation(convId: string, cursor: { run?: string; fromSeq?: number }, signal: AbortSignal): AsyncGenerator<ChatFrame> {
  const q = new URLSearchParams()
  if (cursor.run) q.set('run', cursor.run)
  if (cursor.fromSeq !== undefined) q.set('fromSeq', String(cursor.fromSeq))
  const qs = q.toString()
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/stream${qs ? `?${qs}` : ''}`, {
    headers: { Accept: 'text/event-stream', ...authHeaders() },
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    const env = (() => { try { return JSON.parse(text) } catch { return undefined } })() as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  yield* chatSseEvents(res.body)
}

/** How often followChatTurn reconnects after a dropped connection before it gives up, and how long it waits before
 *  each try: Code's budget (code-session-client.ts). */
const RESUME_ATTEMPTS = 6
const resumeDelay = (attempt: number) => Math.min(500 * attempt, 3000)

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
    const t = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** A page following one chat turn to its end. The daemon runs the turn (closing or leaving the page does not stop it),
 *  so a dropped connection is only this view's: it resumes by GET, never by sending again.
 *  - `first`: the POST that starts a turn (sendMessage, continueConversation), given the callback it runs once the
 *    daemon answered 200; null attaches to the reply that runs now (a page opened, reloaded or switched to the chat).
 *  - The cursor is the seq after the last numbered frame, with the reply's id from its `meta`. A connection that
 *    drops (a throw that is not an abort) resumes with `?run=<reply>&fromSeq=<cursor>`, up to 6 times in a row with
 *    Code's backoff; one the daemon dropped for falling behind (`lagged`) resumes at once. A 4xx other than 408/429
 *    is thrown at once.
 *  - A drop before the daemon answered the POST is thrown unchanged: the send may not have been stored, and the
 *    caller puts the text back. A drop after the 200 and before the meta resumes with a fresh GET: the turn exists.
 *  - `reset` is yielded before the first numbered frame of a connection whose seq is not the cursor it asked for (the
 *    daemon replays from the start of what it still has: a reply longer than it keeps, or a cursor it no longer
 *    has), and before the first numbered frame of a fresh attach, so the view starts the reply over rather than
 *    doubling or skipping text.
 *  - It returns after `done` or `error`, or when the daemon ends a stream cleanly: the turn is over, or there is no
 *    turn to follow. */
export async function* followChatTurn(
  convId: string,
  first: ((onAccepted: () => void) => AsyncGenerator<ChatFrame>) | null,
  signal: AbortSignal,
): AsyncGenerator<ChatFrame> {
  let run: string | undefined
  let next = 0
  let accepted = first === null
  let attempt = 0
  let source = first ? first(() => { accepted = true }) : streamConversation(convId, {}, signal)
  /** The cursor this connection asked for; null for a fresh attach. */
  let asked: number | null = first ? 0 : null
  for (;;) {
    let firstNumbered = true
    let lagged = false
    try {
      for await (const f of source) {
        if ((f.event as string) === 'lagged') { lagged = true; break }
        if (f.event === 'meta') { run = f.data.assistantMessageId; accepted = true }
        if (f.seq !== undefined) {
          if (firstNumbered) {
            firstNumbered = false
            if (asked === null || f.seq !== asked) yield { event: 'reset', data: {} }
          }
          next = f.seq + 1
          attempt = 0
        }
        yield f
        if (f.event === 'done' || f.event === 'error') return
      }
      if (!lagged) return
      if (++attempt > RESUME_ATTEMPTS) throw new Error('The reply could not be followed: its stream kept falling behind.')
    } catch (e) {
      if (signal.aborted || (e as Error)?.name === 'AbortError') throw e
      if (!accepted) throw e
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e
      if (++attempt > RESUME_ATTEMPTS) throw e
      await sleep(resumeDelay(attempt), signal)
    }
    source = streamConversation(convId, run ? { run, fromSeq: next } : {}, signal)
    asked = run ? next : null
  }
}

/**
 * Streaming continue — regenerates a fresh assistant response for the conversation's
 * existing last user message, WITHOUT adding a new user message. Used by retry/edit.
 */
export async function* continueConversation(
  convId: string,
  signal: AbortSignal,
  thinkingBudget?: number,
  reasoningEffort?: ReasoningEffort,
  /** See {@link sendMessage}. */
  model?: string,
  /** Regenerate the reply with this id, the one shown last: the daemon sets it aside as a
   *  sibling version, and only once the turn can run (a refused turn leaves it in place). It
   *  answers 409 stale_message when that reply is no longer the last one (the chat changed in
   *  another tab or device), rather than replacing a reply this view never showed. */
  regenerateId?: string,
  /** Save & Resend: give this question a new version (its later turns kept on the old one) and
   *  answer it, in this one request, so the daemon branches only once the turn can run. A
   *  refused turn changes nothing; a question no longer on the shown branch is 409
   *  stale_message. */
  edit?: { messageId: string; content: string },
  /** See {@link sendMessage}. */
  onAccepted?: () => void,
): AsyncGenerator<ChatFrame> {
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ thinkingBudget: thinkingBudget !== undefined && thinkingBudget !== -1 ? thinkingBudget : undefined, reasoningEffort: reasoningEffort !== undefined && reasoningEffort !== DEFAULT_REASONING_EFFORT ? reasoningEffort : undefined, model: model || undefined, regenerate: regenerateId ? true : undefined, messageId: regenerateId || undefined, edit }),
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    const env = (() => { try { return JSON.parse(text) } catch { return undefined } })() as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  onAccepted?.()
  yield* chatSseEvents(res.body)
}
