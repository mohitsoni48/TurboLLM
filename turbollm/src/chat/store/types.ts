// Wire types for the pluggable chat store (spec 27 §3.2, §4.1).
//
// These are the PUBLIC shapes an adapter round-trips — deliberately NOT the internal
// row model in ../db.ts, which carries TurboLLM internals (expertMode, agentId,
// readScope, skillIds, allowedTools, toolOverrides, kind) that must never become
// external compatibility surface (spec 27 §3.2).

/** Tenant + owner, threaded positionally through every store call so an unscoped
 *  query is impossible to write by omission (spec 27 §3.1). */
export interface Scope {
  /** The integrating application. Derived from the API key, never from a request body. */
  tenant: string
  /** The integrator's end user. Opaque to TurboLLM. */
  owner: string
}

export type MessageRole = 'user' | 'assistant'

/** `pending`/`streaming`/`failed`/`aborted` are only reachable via the public API's
 *  run machinery (Phase 3). Rows written by the existing UI path are always
 *  `complete` — see SqliteChatStore's status derivation. */
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'aborted'

export interface Chat {
  id: string
  owner: string
  title: string
  model: string
  systemPrompt: string
  sampling: Record<string, unknown>
  metadata: Record<string, unknown>
  messageCount: number
  lastMessageAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  chatId: string
  seq: number
  role: MessageRole
  content: string
  status: MessageStatus
  version: number
  createdAt: string
  edited: boolean
  reasoning: string
  attachments: string[]
  toolCalls: unknown[]
  usage: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface ChatInput {
  title?: string
  model?: string
  systemPrompt?: string
  sampling?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ChatPatch {
  title?: string
  model?: string
  systemPrompt?: string
  sampling?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface MessageInput {
  role: MessageRole
  content: string
  status?: MessageStatus
  reasoning?: string
  attachments?: string[]
  toolCalls?: unknown[]
  usage?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface MessagePatch {
  content?: string
  status?: MessageStatus
  reasoning?: string
  toolCalls?: unknown[]
  usage?: Record<string, unknown>
  metadata?: Record<string, unknown>
  edited?: boolean
}

export interface ListOpts {
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string
  /** 1–200; defaults to 50. */
  limit?: number
  /** Full-text query. Only honoured when the store declares the `search` capability. */
  q?: string
}

export interface Page<T> {
  data: T[]
  hasMore: boolean
  nextCursor: string | null
}
