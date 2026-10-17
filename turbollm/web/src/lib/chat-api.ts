import type { Conversation, Folder, Message, ChatSseEvent, MemoryFact } from './chat-types'
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

export function stopGeneration(conversationId: string): Promise<{ ok: true }> {
  return req('/api/v1/chat/stop', { method: 'POST', json: { conversationId } })
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
): AsyncGenerator<ChatSseEvent> {
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

  yield* chatSseEvents(res.body)
}

/** Typed chat events off a turn's SSE body — unnamed or malformed (non-JSON) messages skipped. */
async function* chatSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatSseEvent> {
  for await (const msg of readSseStream(body)) {
    if (!msg.event) continue
    let data: unknown
    try { data = JSON.parse(msg.data) } catch { continue /* skip malformed */ }
    yield { event: msg.event, data } as ChatSseEvent
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
): AsyncGenerator<ChatSseEvent> {
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
  yield* chatSseEvents(res.body)
}
