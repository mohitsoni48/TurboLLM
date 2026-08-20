// turbollm/src/ext/routes.chats.ts
//
// Chat and message CRUD for /api/ext/v1 (spec 27). Every handler threads its Scope through
// `scopeFor(c, ownerFromBody)` — tenant always comes from the authenticated key (auth.ts),
// never from the request — and every not-found path returns 404, not 403, so one tenant
// can never use status codes to probe whether another tenant's id exists (spec 27 §7.2).
import type { Hono } from 'hono'
import type { Deps } from '../deps.js'
import { extAuth, requireScope, scopeFor } from './auth.js'
import { extError, mapStoreError } from './errors.js'
import { parseInclude, toChatDTO, toMessageDTO } from './dto.js'

const BASE = '/api/ext/v1'

async function body<T>(c: { req: { json(): Promise<unknown> } }): Promise<Partial<T>> {
  try { return (await c.req.json()) as Partial<T> } catch { return {} }
}

export function registerExtChatRoutes(app: Hono, d: Deps): void {
  app.use(`${BASE}/*`, extAuth(d))

  app.get(`${BASE}/capabilities`, (c) => c.json({
    capabilities: d.chatStore.capabilities,
    limits: { max_page_size: 200, max_body_bytes: 1_048_576, max_attachments: 4 },
  }))

  app.get(`${BASE}/chats`, requireScope('chats:read'), async (c) => {
    try {
      const page = await d.chatStore.listChats(scopeFor(c, c.req.query('owner')), {
        cursor: c.req.query('cursor'),
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        q: c.req.query('q'),
      })
      return c.json({ data: page.data.map(toChatDTO), has_more: page.hasMore, next_cursor: page.nextCursor })
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  app.post(`${BASE}/chats`, requireScope('chats:write'), async (c) => {
    const b = await body<{ title: string; model: string; system_prompt: string; sampling: Record<string, unknown>; metadata: Record<string, unknown>; owner: string }>(c)
    try {
      const chat = await d.chatStore.createChat(scopeFor(c, b.owner), {
        title: b.title, model: b.model, systemPrompt: b.system_prompt,
        sampling: b.sampling, metadata: b.metadata,
      })
      return c.json(toChatDTO(chat), 201)
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  app.get(`${BASE}/chats/:id`, requireScope('chats:read'), async (c) => {
    const chat = await d.chatStore.getChat(scopeFor(c, c.req.query('owner')), c.req.param('id'))
    // 404 rather than 403 for another tenant's chat: a 403 confirms the id exists (spec §7.2).
    if (!chat) return extError(c, 'not_found', 'not_found', 'Not found.')
    return c.json(toChatDTO(chat))
  })

  app.patch(`${BASE}/chats/:id`, requireScope('chats:write'), async (c) => {
    const b = await body<{ title: string; system_prompt: string; sampling: Record<string, unknown>; metadata: Record<string, unknown>; owner: string; if_version: number }>(c)
    try {
      const chat = await d.chatStore.updateChat(
        scopeFor(c, b.owner), c.req.param('id'),
        { title: b.title, systemPrompt: b.system_prompt, sampling: b.sampling, metadata: b.metadata },
        b.if_version,
      )
      if (!chat) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.json(toChatDTO(chat))
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  app.delete(`${BASE}/chats/:id`, requireScope('chats:write'), async (c) => {
    const gone = await d.chatStore.deleteChat(scopeFor(c, c.req.query('owner')), c.req.param('id'))
    if (!gone) return extError(c, 'not_found', 'not_found', 'Not found.')
    return c.body(null, 204)
  })

  app.get(`${BASE}/chats/:id/messages`, requireScope('chats:read'), async (c) => {
    const include = parseInclude(c.req.query('include'))
    try {
      const page = await d.chatStore.listMessages(scopeFor(c, c.req.query('owner')), c.req.param('id'), {
        cursor: c.req.query('cursor'),
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      })
      return c.json({ data: page.data.map((m) => toMessageDTO(m, include)), has_more: page.hasMore, next_cursor: page.nextCursor })
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  app.post(`${BASE}/chats/:id/messages`, requireScope('chats:write'), async (c) => {
    const b = await body<{ role: 'user' | 'assistant'; content: string; reasoning: string; owner: string; generate: boolean }>(c)
    const content = (b.content ?? '').trim()
    if (!content) return extError(c, 'invalid_request', 'invalid_input', 'Type a message or attach a file.', { param: 'content' })
    if (b.generate === false) {
      try {
        const msg = await d.chatStore.addMessage(scopeFor(c, b.owner), c.req.param('id'), {
          role: b.role ?? 'user', content, reasoning: b.reasoning,
        })
        return c.json(toMessageDTO(msg, parseInclude(c.req.query('include'))), 201)
      } catch (e) {
        const m = mapStoreError(e)
        return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
      }
    }
    // Generating path: Task 7.
    return extError(c, 'unsupported', 'not_supported', 'Generation lands in Task 7.')
  })

  app.get(`${BASE}/messages/:id`, requireScope('chats:read'), async (c) => {
    const msg = await d.chatStore.getMessage(scopeFor(c, c.req.query('owner')), c.req.param('id'))
    if (!msg) return extError(c, 'not_found', 'not_found', 'Not found.')
    return c.json(toMessageDTO(msg, parseInclude(c.req.query('include'))))
  })

  app.patch(`${BASE}/messages/:id`, requireScope('chats:write'), async (c) => {
    const b = await body<{ content: string; metadata: Record<string, unknown>; owner: string; if_version: number }>(c)
    try {
      const msg = await d.chatStore.updateMessage(
        scopeFor(c, b.owner), c.req.param('id'),
        { content: b.content, metadata: b.metadata, edited: true },
        b.if_version,
      )
      if (!msg) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.json(toMessageDTO(msg, parseInclude(c.req.query('include'))))
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  app.delete(`${BASE}/messages/:id`, requireScope('chats:write'), async (c) => {
    const gone = await d.chatStore.deleteMessage(scopeFor(c, c.req.query('owner')), c.req.param('id'))
    if (!gone) return extError(c, 'not_found', 'not_found', 'Not found.')
    return c.body(null, 204)
  })
}
