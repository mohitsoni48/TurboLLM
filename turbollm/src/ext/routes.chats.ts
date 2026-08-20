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
import { IdempotencyStore } from './idempotency.js'
import { TenantLimiter, DEFAULT_MAX_IN_FLIGHT_PER_TENANT, DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT } from './limits.js'

const BASE = '/api/ext/v1'

async function body<T>(c: { req: { json(): Promise<unknown> } }): Promise<Partial<T>> {
  try { return (await c.req.json()) as Partial<T> } catch { return {} }
}

export interface ExtRouteDeps {
  idempotency: IdempotencyStore
  limiter: TenantLimiter
}

/** `ext` is optional so every pre-existing test/caller that constructs this route set without
 *  it (mount.ts always supplies a shared instance in production; only ad-hoc test harnesses
 *  omit it) keeps compiling and behaving exactly as before — a private, generously-capped
 *  instance is created here as the fallback rather than making callers thread it through for
 *  tests that don't care about idempotency or rate limiting at all. */
export function registerExtChatRoutes(app: Hono, d: Deps, ext?: ExtRouteDeps): void {
  const idempotency = ext?.idempotency ?? new IdempotencyStore()
  const limiter = ext?.limiter ?? new TenantLimiter({
    maxInFlight: DEFAULT_MAX_IN_FLIGHT_PER_TENANT,
    ratePerMinute: DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT,
  })

  app.use(`${BASE}/*`, extAuth(d))
  // Per-tenant request budget (spec 27 §8.4) covering the WHOLE surface, including routes
  // registered later by registerExtRunRoutes — Hono matches `app.use` middleware by path
  // pattern against every route under it regardless of which function registered the route,
  // as long as this runs before the app starts serving (mount.ts always registers chat routes
  // first). Runs after extAuth so `extTenant` is already resolved; a request that failed auth
  // never counts against the tenant's budget (there is no tenant to charge it to).
  app.use(`${BASE}/*`, async (c, next) => {
    const tenant = c.get('extTenant') as string
    if (!limiter.tryRequest(tenant)) {
      return extError(c, 'capacity', 'rate_limited',
        'Too many requests for this tenant. Slow down and retry shortly.',
        { status: 429, retryable: true, retryAfterMs: 60_000 })
    }
    await next()
  })

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
    const tenant = c.get('extTenant') as string
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || undefined

    // Idempotent replay (spec §7.6): a cached key means THIS chat was already created by an
    // earlier attempt of the same request — return that frozen result rather than creating a
    // second chat. Checked before any store write, so a retry never even reaches createChat.
    if (idempotencyKey) {
      const cached = idempotency.lookup(tenant, idempotencyKey)
      if (cached) return c.json(cached, 201)
    }

    try {
      const chat = await d.chatStore.createChat(scopeFor(c, b.owner), {
        title: b.title, model: b.model, systemPrompt: b.system_prompt,
        sampling: b.sampling, metadata: b.metadata,
      })
      const dto = toChatDTO(chat)
      // Commit point is immediately after creation succeeds (spec §7.6) — there is no engine
      // work in chat creation at all, so "before the engine is touched" is satisfied trivially;
      // what matters is that this runs before returning, so a race between two identical
      // concurrent retries still can't both observe a miss (the second's `createChat` may still
      // create a duplicate chat under a true race — see idempotency.ts's own residual-window
      // note — but a SEQUENTIAL retry, the actual reported failure mode, is fully covered).
      if (idempotencyKey) idempotency.remember(tenant, idempotencyKey, dto)
      return c.json(dto, 201)
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  app.get(`${BASE}/chats/:id`, requireScope('chats:read'), async (c) => {
    try {
      const chat = await d.chatStore.getChat(scopeFor(c, c.req.query('owner')), c.req.param('id'))
      // 404 rather than 403 for another tenant's chat: a 403 confirms the id exists (spec §7.2).
      if (!chat) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.json(toChatDTO(chat))
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
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
    try {
      const gone = await d.chatStore.deleteChat(scopeFor(c, c.req.query('owner')), c.req.param('id'))
      if (!gone) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.body(null, 204)
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
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
    // Generating path: forward to the dedicated run route (routes.runs.ts) so both share this
    // same content validator instead of duplicating it. That route re-derives scope from the
    // forwarded Authorization header — never from this request's already-resolved scope — so
    // its own tenant/owner checks stay the single source of truth.
    return app.fetch(new Request(new URL(`${BASE}/chats/${c.req.param('id')}/messages/generate`, c.req.url), {
      method: 'POST',
      headers: c.req.raw.headers,
      body: JSON.stringify({ ...b, content }),
    }))
  })

  app.get(`${BASE}/messages/:id`, requireScope('chats:read'), async (c) => {
    try {
      const msg = await d.chatStore.getMessage(scopeFor(c, c.req.query('owner')), c.req.param('id'))
      if (!msg) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.json(toMessageDTO(msg, parseInclude(c.req.query('include'))))
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
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
    try {
      const gone = await d.chatStore.deleteMessage(scopeFor(c, c.req.query('owner')), c.req.param('id'))
      if (!gone) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.body(null, 204)
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })
}
