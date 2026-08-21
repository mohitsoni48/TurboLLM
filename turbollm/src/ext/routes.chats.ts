// turbollm/src/ext/routes.chats.ts
//
// Chat and message CRUD for /api/ext/v1 (spec 27). Every handler threads its Scope through
// `scopeFor(c, ownerFromBody)` — tenant always comes from the authenticated key (auth.ts),
// never from the request — and every not-found path returns 404, not 403, so one tenant
// can never use status codes to probe whether another tenant's id exists (spec 27 §7.2).
import type { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { requestId as requestIdMiddleware } from 'hono/request-id'
import type { Deps } from '../deps.js'
import type { Scope } from '../chat/store/types.js'
import { extAuth, requireScope, scopeFor } from './auth.js'
import { extError, mapStoreError, requestId as makeRequestId } from './errors.js'
import { parseInclude, toChatDTO, toMessageDTO } from './dto.js'
import { IdempotencyStore } from './idempotency.js'
import {
  TenantLimiter, DEFAULT_MAX_IN_FLIGHT_PER_TENANT, DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT,
  MAX_BODY_BYTES, MAX_ATTACHMENTS,
} from './limits.js'
import { AuditLog, auditMiddleware, recordRateLimitRefusal, toAuditDTO } from './audit.js'
import type { PublicRunManager } from './run-manager.js'

const BASE = '/api/ext/v1'
/** Operation tag for `IdempotencyStore` (see idempotency.ts's own header comment on why this
 *  exists): the store is shared with routes.runs.ts's `'runs:generate'`, so this tag is what
 *  keeps a reused `Idempotency-Key` value from colliding across the two genuinely different
 *  operations. */
const IDEMPOTENCY_OP = 'chats:create'

async function body<T>(c: { req: { json(): Promise<unknown> } }): Promise<Partial<T>> {
  try { return (await c.req.json()) as Partial<T> } catch { return {} }
}

export interface ExtRouteDeps {
  idempotency: IdempotencyStore
  limiter: TenantLimiter
  audit?: AuditLog
}

/** Spec 27 §7.2: mutating a chat/message while a generation is in flight for that chat must
 *  409 `run_active` rather than let the mutation race the run's own terminal write (see C2's
 *  fix in generation.ts — a mid-stream flush now exists, but a delete/edit racing it is still
 *  a genuine correctness problem, not just a cosmetic one). `runs` is optional for the same
 *  reason `ext` is (below): a pre-existing test harness that constructs this route set with no
 *  run manager at all (nothing here needs one to compile or to exercise the chat/message CRUD
 *  surface in isolation) must keep working exactly as before — undefined ⇒ never refuse a
 *  mutation on this ground, which is exactly what happened before this fix existed.
 *
 *  Delegates entirely to `runs.isChatActive` (N4, final-gate fix round) rather than reading
 *  `runs.list()` directly, as an earlier version of this function did. That earlier version only
 *  saw a chat as active once a real `PublicRun` record existed — which routes.runs.ts's generate
 *  handler only creates several real `await`s after it has already synchronously reserved the
 *  chat (I5's TOCTOU fix). A mutation racing that window saw `hasActiveRun` return false and was
 *  wrongly admitted (live-reproduced: a `DELETE` succeeded with 204 in that window, and the
 *  racing generate call then 404'd on its own vanished chat). `isChatActive` is the SAME
 *  authoritative answer routes.runs.ts's own admission check (`reserveChat`) now consults, so the
 *  two can never disagree again. */
function hasActiveRun(runs: PublicRunManager | undefined, scope: Scope, chatId: string): boolean {
  if (!runs) return false
  return runs.isChatActive(scope, chatId)
}

/** `ext` is optional so every pre-existing test/caller that constructs this route set without
 *  it (mount.ts always supplies a shared instance in production; only ad-hoc test harnesses
 *  omit it) keeps compiling and behaving exactly as before — a private, generously-capped
 *  instance is created here as the fallback rather than making callers thread it through for
 *  tests that don't care about idempotency or rate limiting at all. `audit` similarly falls
 *  back to a private instance over the SAME connection (`d.db`) rather than forcing every
 *  ad-hoc test harness to construct one just to compile. `runs` is optional/undocumented here
 *  by the same convention — see `hasActiveRun`'s own comment just above. */
export function registerExtChatRoutes(app: Hono, d: Deps, ext?: ExtRouteDeps, runs?: PublicRunManager): void {
  const idempotency = ext?.idempotency ?? new IdempotencyStore()
  const limiter = ext?.limiter ?? new TenantLimiter({
    maxInFlight: DEFAULT_MAX_IN_FLIGHT_PER_TENANT,
    ratePerMinute: DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT,
  })
  const audit = ext?.audit ?? new AuditLog(d.db)
  // N7 (final-gate fix round): marks a request as the internal forward `POST
  // /chats/:id/messages` makes to `.../messages/generate` below, so the blanket rate limiter
  // (registered just below) can recognize and NOT re-charge it — `app.fetch(new Request(...))`
  // re-enters this app's entire middleware stack as a brand-new top-level dispatch, so without
  // this the forward silently consumed a SECOND rate-limit unit for one client-visible call.
  // Generated fresh per registration (once per mounted app/process) rather than being a fixed
  // string, and NEVER echoed back in any response this app sends — an external caller cannot
  // learn it, so a request that presents this exact header/value pair can only be this route's
  // own forward, never a spoofed direct call trying to dodge the budget. The forwarding branch
  // always OVERWRITES this header with the real token right before forwarding (`fwdHeaders.set`),
  // so even a client that guesses the header NAME and sends its own value on the outer request
  // has that value replaced before the inner dispatch ever sees it.
  const internalForwardToken = randomUUID()
  const INTERNAL_FORWARD_HEADER = 'X-Ext-Internal-Forward'

  // Request-id FIRST — ahead of extAuth, rate-limiting, and every route. Honors an inbound
  // `X-Request-Id` request header when the caller sends one (validated: non-empty, ≤255
  // chars, `\w`/`-`/`=` only — matching hono/request-id's own validation), otherwise
  // generates one in the same `req_<uuid>` shape errors.ts's error envelope already uses, so
  // one id can correlate a support report across an error RESPONSE and an audit trail ROW for
  // the exact same request. `auditMiddleware`/`recordRateLimitRefusal` (audit.ts) both read it
  // via `c.get('requestId')` — never from a response header, which is one-way (the client's
  // OWN request id would never be picked up that way) and was never actually set by anything
  // in this codebase in the first place.
  app.use(`${BASE}/*`, requestIdMiddleware({ generator: () => makeRequestId() }))
  app.use(`${BASE}/*`, extAuth(d))
  // Per-tenant request budget (spec 27 §8.4) covering the WHOLE surface, including routes
  // registered later by registerExtRunRoutes — Hono matches `app.use` middleware by path
  // pattern against every route under it regardless of which function registered the route,
  // as long as this runs before the app starts serving (mount.ts always registers chat routes
  // first). Runs after extAuth so `extTenant` is already resolved; a request that failed auth
  // never counts against the tenant's budget (there is no tenant to charge it to).
  //
  // This is a BLANKET `app.use`, so it runs ahead of every route-specific middleware —
  // including `auditMiddleware`, no matter how that is ordered on any individual route. A 429
  // refused here would otherwise vanish from the audit trail entirely (confirmed live: a
  // tenant with an exhausted budget got the expected 429, and the audit log came back empty),
  // so this records the refusal itself via `recordRateLimitRefusal` before returning it —
  // passing `429` explicitly rather than reading `c.res.status` (see that function's own doc
  // comment on why `c.res` isn't populated yet at this point in the middleware).
  //
  // N7 (final-gate fix round): skips the `tryRequest` charge — but still runs `next()` as
  // normal, so auth/scope/route logic are untouched — for the internal forward the default
  // `POST /chats/:id/messages` path makes to `.../messages/generate` (see
  // `internalForwardToken`'s own comment above for why the header can't be spoofed). Before this
  // fix, one client-visible call to the documented primary endpoint silently consumed TWO
  // budget units, since the forward is a fresh top-level dispatch through this exact middleware.
  app.use(`${BASE}/*`, async (c, next) => {
    const tenant = c.get('extTenant') as string
    const isInternalForward = c.req.header(INTERNAL_FORWARD_HEADER) === internalForwardToken
    if (!isInternalForward && !limiter.tryRequest(tenant)) {
      await recordRateLimitRefusal(audit, c, 429)
      return extError(c, 'capacity', 'rate_limited',
        'Too many requests for this tenant. Slow down and retry shortly.',
        { status: 429, retryable: true, retryAfterMs: 60_000 })
    }
    await next()
  })

  app.get(`${BASE}/capabilities`, (c) => c.json({
    capabilities: d.chatStore.capabilities,
    // MAX_BODY_BYTES/MAX_ATTACHMENTS (limits.ts) are the single source of truth — imported, not
    // re-hardcoded, so what this advertises can never drift from what is actually enforced below
    // and on the generate route (routes.runs.ts).
    limits: { max_page_size: 200, max_body_bytes: MAX_BODY_BYTES, max_attachments: MAX_ATTACHMENTS },
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

  // auditMiddleware is registered BEFORE requireScope on every mutating route (here and
  // below) — not after, as an earlier version of this file had it. `requireScope` returns
  // early via `extError` (no `next()` call) when the key lacks the scope, so an `auditMiddleware`
  // registered AFTER it would simply never run for a scope refusal — confirmed live: a
  // `chats:read`-only key POSTing here got the expected 403, and the audit log came back
  // empty. `auditMiddleware` already runs `next()` first and records the REAL final status
  // (see its own doc comment), so putting it first here still correctly captures the 403.
  app.post(`${BASE}/chats`, auditMiddleware(audit, 'chat.create'), requireScope('chats:write'), async (c) => {
    const b = await body<{ title: string; model: string; system_prompt: string; sampling: Record<string, unknown>; metadata: Record<string, unknown>; owner: string }>(c)
    // Resolved once, up front — both the idempotency lookup below and the createChat call use
    // the SAME scope, so they can never disagree about which owner this request is for.
    const scope = scopeFor(c, b.owner)
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || undefined

    // Idempotent replay (spec §7.6): a cached key means THIS chat was already created by an
    // earlier attempt of the same request — return that frozen result rather than creating a
    // second chat. Checked before any store write, so a retry never even reaches createChat.
    // `owner` is part of the cache key (N1, final-gate fix round) — a tenant's API key is
    // shared across an integrator's many end users (spec 27 §3.1), so without this a different
    // owner reusing the same Idempotency-Key value would replay THIS owner's chat verbatim,
    // private metadata included (live-reproduced in the review this fixes).
    if (idempotencyKey) {
      const cached = idempotency.lookup(scope.tenant, scope.owner, IDEMPOTENCY_OP, idempotencyKey) as { id?: string } | null
      if (cached) {
        // Route has no `:id` param to fall back on (this is POST /chats) — without this, the
        // audit row for a replay would carry a null targetId even though the real chat id is
        // sitting right here in the cached DTO.
        if (cached.id) c.set('auditTargetId', cached.id)
        return c.json(cached, 201)
      }
    }

    try {
      const chat = await d.chatStore.createChat(scope, {
        title: b.title, model: b.model, systemPrompt: b.system_prompt,
        sampling: b.sampling, metadata: b.metadata,
      })
      // The real created-resource id, for auditMiddleware — POST /chats has no `:id` route
      // param at all, so without this every chat.create audit row would carry targetId: null.
      c.set('auditTargetId', chat.id)
      const dto = toChatDTO(chat)
      // Commit point is immediately after creation succeeds (spec §7.6) — there is no engine
      // work in chat creation at all, so "before the engine is touched" is satisfied trivially;
      // what matters is that this runs before returning, so a race between two identical
      // concurrent retries still can't both observe a miss (the second's `createChat` may still
      // create a duplicate chat under a true race — see idempotency.ts's own residual-window
      // note — but a SEQUENTIAL retry, the actual reported failure mode, is fully covered).
      if (idempotencyKey) idempotency.remember(scope.tenant, scope.owner, IDEMPOTENCY_OP, idempotencyKey, dto)
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

  app.patch(`${BASE}/chats/:id`, auditMiddleware(audit, 'chat.update'), requireScope('chats:write'), async (c) => {
    const b = await body<{ title: string; system_prompt: string; sampling: Record<string, unknown>; metadata: Record<string, unknown>; owner: string; if_version: number }>(c)
    const scope = scopeFor(c, b.owner)
    const chatId = c.req.param('id')
    // Spec §7.2: a chat with an active generation must refuse mutation with 409 run_active
    // rather than let this race the run's own terminal write (see hasActiveRun's own comment).
    if (hasActiveRun(runs, scope, chatId)) {
      return extError(c, 'conflict', 'run_active', 'A generation is currently running for this chat.', { retryable: true })
    }
    try {
      const chat = await d.chatStore.updateChat(
        scope, chatId,
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

  app.delete(`${BASE}/chats/:id`, auditMiddleware(audit, 'chat.delete'), requireScope('chats:write'), async (c) => {
    const scope = scopeFor(c, c.req.query('owner'))
    const chatId = c.req.param('id')
    if (hasActiveRun(runs, scope, chatId)) {
      return extError(c, 'conflict', 'run_active', 'A generation is currently running for this chat.', { retryable: true })
    }
    try {
      const gone = await d.chatStore.deleteChat(scope, chatId)
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

  app.post(`${BASE}/chats/:id/messages`, auditMiddleware(audit, 'message.create'), requireScope('chats:write'), async (c) => {
    const b = await body<{
      role: 'user' | 'assistant'; content: string; reasoning: string; owner: string; generate: boolean
      attachments?: string[]; metadata?: Record<string, unknown>
    }>(c)
    // Runtime shape guard (round-3 review finding, "N5/N6's byte-size checks crash..."):
    // `body<T>()` above is a bare `as Partial<T>` cast, not a schema check, so a client can send
    // `content: 999999`, `attachments: [12345]`, or `attachments: {...}` (non-array) and hit
    // `.trim()` / `Buffer.byteLength` / `.reduce` on a non-string value a few lines below — each
    // throws a synchronous TypeError BEFORE this route's own try/catch, which Hono's default
    // handler (no `app.onError` registered anywhere in this app) turns into a bare, non-JSON
    // "Internal Server Error" at 500 instead of the required structured error envelope. Checked
    // here, before ANY operation that assumes `content`/`attachments` are already the right
    // shape — including the `.trim()` call two lines down, not just the byte-size checks further
    // below, since `.trim()` on a non-string throws just as readily as `Buffer.byteLength` does.
    if (b.content !== undefined && typeof b.content !== 'string') {
      return extError(c, 'invalid_request', 'invalid_input', '`content` must be a string.', { param: 'content' })
    }
    if (b.attachments !== undefined && (!Array.isArray(b.attachments) || !b.attachments.every((a) => typeof a === 'string'))) {
      return extError(c, 'invalid_request', 'invalid_input', '`attachments` must be an array of strings.', { param: 'attachments' })
    }
    const content = (b.content ?? '').trim()
    const attachments = b.attachments
    // "Type a message OR attach a file" (spec 27 §3.2/§5.1) — content alone is no longer the
    // only way to satisfy this; an attachments-only message is legitimate and must not be
    // rejected just because `content` trims to empty. Mirrors the generate route's identical
    // check (routes.runs.ts) so both message-creation paths honor the same rule.
    if (!content && !(attachments?.length)) return extError(c, 'invalid_request', 'invalid_input', 'Type a message or attach a file.', { param: 'content' })

    // Body/attachment caps (spec 27 §4.1), checked purely from the request body — before ANY
    // store I/O — same discipline and the SAME imported constants (limits.ts) the generate
    // route (routes.runs.ts) enforces, so the two routes' behavior is identical and neither can
    // drift from what GET /capabilities advertises.
    const bodyBytes = Buffer.byteLength(content, 'utf8')
    if (bodyBytes > MAX_BODY_BYTES) {
      return extError(c, 'invalid_request', 'payload_too_large',
        `Message content is ${bodyBytes} bytes, exceeding the ${MAX_BODY_BYTES}-byte limit.`,
        { status: 413, param: 'content' })
    }
    if (attachments && attachments.length > MAX_ATTACHMENTS) {
      return extError(c, 'invalid_request', 'payload_too_large',
        `Message has ${attachments.length} attachments, exceeding the ${MAX_ATTACHMENTS}-attachment limit.`,
        { status: 413, param: 'attachments' })
    }
    // N5 (final-gate fix round): attachment COUNT alone doesn't bound total SIZE — each
    // attachment is a base64 data-URI string that can be arbitrarily large on its own. Sum of
    // byte lengths is a reasonable proxy for decoded size without base64-decoding each one.
    // Mirrors the generate route's identical check (routes.runs.ts); see that file's comment on
    // why this reuses `MAX_BODY_BYTES` rather than a dedicated attachment-bytes constant.
    if (attachments) {
      const attachmentBytes = attachments.reduce((sum, a) => sum + Buffer.byteLength(a, 'utf8'), 0)
      if (attachmentBytes > MAX_BODY_BYTES) {
        return extError(c, 'invalid_request', 'payload_too_large',
          `Attachments total ${attachmentBytes} bytes, exceeding the ${MAX_BODY_BYTES}-byte limit.`,
          { status: 413, param: 'attachments' })
      }
    }
    // `metadata` had no size check at all — an integrator could smuggle an unbounded blob
    // through this field alone even with `content`/`attachments` both small.
    if (b.metadata) {
      const metadataBytes = Buffer.byteLength(JSON.stringify(b.metadata), 'utf8')
      if (metadataBytes > MAX_BODY_BYTES) {
        return extError(c, 'invalid_request', 'payload_too_large',
          `metadata is ${metadataBytes} bytes, exceeding the ${MAX_BODY_BYTES}-byte limit.`,
          { status: 413, param: 'metadata' })
      }
    }

    if (b.generate === false) {
      try {
        const msg = await d.chatStore.addMessage(scopeFor(c, b.owner), c.req.param('id'), {
          role: b.role ?? 'user', content, reasoning: b.reasoning, attachments, metadata: b.metadata,
        })
        // The real created message id — this route's own `:id` param names the CHAT, not the
        // message just created, so without this the audit row would point at the parent.
        c.set('auditTargetId', msg.id)
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
    //
    // Headers are cloned (not passed through as-is) so `X-Request-Id` can be pinned to THIS
    // request's own resolved id (`c.get('requestId')` — set by the request-id middleware above,
    // from an inbound header or freshly generated) before the forward. Passing
    // `c.req.raw.headers` straight through only carries the id when the CLIENT itself supplied
    // one; when it didn't, hono/request-id mints a fresh id for the re-entered forwarded
    // request too, so the `message.create` row here and the `run.start` row the generate route
    // writes end up with two different, uncorrelated request ids for one logical call — the
    // audit trail's whole point is per-request correlation, so this is what keeps that intact.
    // N7 (final-gate fix round): overwrites (never trusts a client-supplied value of) the
    // internal-forward marker so the blanket rate limiter above recognizes this SPECIFIC
    // outbound request as the one logical call's own forward and doesn't charge it a second
    // budget unit — see `internalForwardToken`'s own comment near the top of this function for
    // why an external caller cannot forge this.
    const fwdHeaders = new Headers(c.req.raw.headers)
    fwdHeaders.set('X-Request-Id', c.get('requestId'))
    fwdHeaders.set(INTERNAL_FORWARD_HEADER, internalForwardToken)
    const fwdRes = await app.fetch(new Request(new URL(`${BASE}/chats/${c.req.param('id')}/messages/generate`, c.req.url), {
      method: 'POST',
      headers: fwdHeaders,
      body: JSON.stringify({ ...b, content }),
    }))
    // N7: the forwarded call is a SEPARATE Hono dispatch with its own Context — the id of the
    // message it actually created (the USER turn, not the assistant placeholder the JSON body's
    // `message_id` field carries) never reaches THIS context on its own. Without this, the
    // `message.create` audit row `auditMiddleware` writes for THIS route falls back to
    // `c.req.param('id')`, which names the CHAT, not the message just created. The generate
    // route echoes the real id back via a response header for exactly this purpose (see
    // routes.runs.ts's `respondWithRun`).
    const forwardedUserMessageId = fwdRes.headers.get('X-Ext-User-Message-Id')
    if (forwardedUserMessageId) c.set('auditTargetId', forwardedUserMessageId)
    return fwdRes
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

  app.patch(`${BASE}/messages/:id`, auditMiddleware(audit, 'message.update'), requireScope('chats:write'), async (c) => {
    const b = await body<{ content: string; metadata: Record<string, unknown>; owner: string; if_version: number }>(c)
    const scope = scopeFor(c, b.owner)
    const id = c.req.param('id')
    // Runtime shape guard (round-3 review finding — see the identical comment in the POST
    // /chats/:id/messages handler above for the full explanation): `body<T>()` is a bare cast,
    // so a PATCH with `content: 999999` would otherwise reach `Buffer.byteLength(b.content, ...)`
    // just below with a non-string value and crash with a bare, non-JSON 500 before this route's
    // own try/catch. Checked before the byte-size check, not inside it.
    if (b.content !== undefined && typeof b.content !== 'string') {
      return extError(c, 'invalid_request', 'invalid_input', '`content` must be a string.', { param: 'content' })
    }
    // N6 (final-gate fix round): both message-CREATION routes enforce MAX_BODY_BYTES before
    // persistence; this EDIT path called `updateMessage` directly with no size check at all —
    // a client could bypass the cap entirely by creating a small message, then PATCHing it to
    // unbounded size. Checked purely off the request body, before any store I/O, same
    // discipline as every other guard on this surface. `MessagePatch` (chat/store/types.ts) has
    // no `attachments` field, so only `content`/`metadata` need a check here.
    if (b.content !== undefined) {
      const bodyBytes = Buffer.byteLength(b.content, 'utf8')
      if (bodyBytes > MAX_BODY_BYTES) {
        return extError(c, 'invalid_request', 'payload_too_large',
          `Message content is ${bodyBytes} bytes, exceeding the ${MAX_BODY_BYTES}-byte limit.`,
          { status: 413, param: 'content' })
      }
    }
    if (b.metadata) {
      const metadataBytes = Buffer.byteLength(JSON.stringify(b.metadata), 'utf8')
      if (metadataBytes > MAX_BODY_BYTES) {
        return extError(c, 'invalid_request', 'payload_too_large',
          `metadata is ${metadataBytes} bytes, exceeding the ${MAX_BODY_BYTES}-byte limit.`,
          { status: 413, param: 'metadata' })
      }
    }
    try {
      // A message's `:id` names the message, not its parent chat, so the active-run check
      // (spec §7.2) needs a lookup first to learn which chat this message even belongs to —
      // unlike the /chats/:id routes above, which already have the chat id from the URL.
      const existing = await d.chatStore.getMessage(scope, id)
      if (!existing) return extError(c, 'not_found', 'not_found', 'Not found.')
      if (hasActiveRun(runs, scope, existing.chatId)) {
        return extError(c, 'conflict', 'run_active', 'A generation is currently running for this chat.', { retryable: true })
      }
      const msg = await d.chatStore.updateMessage(
        scope, id,
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

  app.delete(`${BASE}/messages/:id`, auditMiddleware(audit, 'message.delete'), requireScope('chats:write'), async (c) => {
    const scope = scopeFor(c, c.req.query('owner'))
    const id = c.req.param('id')
    try {
      const existing = await d.chatStore.getMessage(scope, id)
      if (!existing) return extError(c, 'not_found', 'not_found', 'Not found.')
      if (hasActiveRun(runs, scope, existing.chatId)) {
        return extError(c, 'conflict', 'run_active', 'A generation is currently running for this chat.', { retryable: true })
      }
      const gone = await d.chatStore.deleteMessage(scope, id)
      if (!gone) return extError(c, 'not_found', 'not_found', 'Not found.')
      return c.body(null, 204)
    } catch (e) {
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
  })

  // The tenant's own audit trail (spec 27 §10). Read-only — never audited itself
  // (auditMiddleware is not attached here) — and scoped to `extTenant` exactly like every
  // other read on this surface, so one tenant can never see another's mutation history.
  app.get(`${BASE}/audit`, requireScope('chats:read'), (c) => {
    const tenant = c.get('extTenant') as string
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    const rows = audit.list(tenant, { limit, since: c.req.query('since') })
    return c.json({ data: rows.map(toAuditDTO) })
  })
}
