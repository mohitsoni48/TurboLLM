// turbollm/src/ext/dto.ts
//
// Store types → public wire shapes (spec 27 §3.2). This boundary is the whole reason the
// public contract can stay stable while the internal row model keeps moving: nothing
// TurboLLM-internal has a path onto the wire unless it is named here.
import type { Chat, ChatMessage } from '../chat/store/types.js'

export const HEAVY_FIELDS = ['reasoning', 'attachments', 'tool_calls', 'usage', 'metadata'] as const
export type HeavyField = (typeof HEAVY_FIELDS)[number]

export function parseInclude(raw: string | undefined): Set<HeavyField> {
  if (!raw) return new Set()
  const wanted = raw.split(',').map((s) => s.trim())
  return new Set(HEAVY_FIELDS.filter((f) => wanted.includes(f)))
}

export function toChatDTO(c: Chat): Record<string, unknown> {
  // `tenant` is deliberately absent: a caller only ever sees its own tenant's data, so
  // echoing it is noise — and omitting it removes a class of cross-tenant leak.
  return {
    id: c.id, owner: c.owner, title: c.title, model: c.model,
    system_prompt: c.systemPrompt, sampling: c.sampling, metadata: c.metadata,
    message_count: c.messageCount, last_message_at: c.lastMessageAt, version: c.version,
    created_at: c.createdAt, updated_at: c.updatedAt,
  }
}

export function toMessageDTO(m: ChatMessage, include: Set<HeavyField>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: m.id, chat_id: m.chatId, seq: m.seq, role: m.role, content: m.content,
    status: m.status, version: m.version, created_at: m.createdAt, edited: m.edited,
  }
  if (include.has('reasoning')) base.reasoning = m.reasoning
  if (include.has('attachments')) base.attachments = m.attachments
  if (include.has('tool_calls')) base.tool_calls = m.toolCalls
  if (include.has('usage')) base.usage = m.usage
  if (include.has('metadata')) base.metadata = m.metadata
  return base
}
