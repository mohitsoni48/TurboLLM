import type { Conversation, Folder, Message, ChatSseEvent, MemoryFact } from './chat-types'
import { ApiError, authHeaders } from './api'

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
  disableThinking?: boolean,
): AsyncGenerator<ChatSseEvent> {
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content, images: images?.length ? images : undefined, docContext: docContext || undefined, textAttachments: textAttachments?.length ? textAttachments : undefined, disableThinking: disableThinking || undefined }),
    signal,
  })
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
      for (const line of lines) {
        if (line.startsWith('event: '))      { event = line.slice(7).trim() }
        else if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim()
          try {
            const data = JSON.parse(raw)
            if (event) yield { event, data } as ChatSseEvent
          } catch { /* skip malformed */ }
          event = ''
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Streaming continue — regenerates a fresh assistant response for the conversation's
 * existing last user message, WITHOUT adding a new user message. Used by retry/edit.
 */
export async function* continueConversation(
  convId: string,
  signal: AbortSignal,
  disableThinking?: boolean,
): AsyncGenerator<ChatSseEvent> {
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(convId)}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ disableThinking: disableThinking || undefined }),
    signal,
  })
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
      for (const line of lines) {
        if (line.startsWith('event: ')) { event = line.slice(7).trim() }
        else if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim()
          try { const data = JSON.parse(raw); if (event) yield { event, data } as ChatSseEvent } catch { /* skip */ }
          event = ''
        }
      }
    }
  } finally { reader.releaseLock() }
}
