// turbollm/src/ext/routes.runs.ts
//
// The generating path (spec 27 §5.1, §6, §8).
//
// Order is load-bearing:
//   1. validate  2. persist user + placeholder  3. create the run  4. acquire the gate
//   5. generate  6. release  7. terminal write
// Persisting before touching the engine (§7.4) means a failed write costs zero GPU time, and
// releasing before the terminal write keeps adapter I/O outside the gate hold (§8.2). Note that
// steps 4/6/7 happen INSIDE the injected run body (generation.ts in production; the tests here
// inject a fake body) — this route never touches `d.gate` itself.
import type { Hono, Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps.js'
import type { Chat, ChatMessage } from '../chat/store/types.js'
import { requireScope, scopeFor } from './auth.js'
import { extError, mapStoreError } from './errors.js'
import { checkContextFits } from './context-limit.js'
import { loadFullHistory, buildGenerationCtx } from './generation.js'
import { PublicRunManager, type PublicRun, type RunBody } from './run-manager.js'
import { IdempotencyStore } from './idempotency.js'
import {
  TenantLimiter, DEFAULT_MAX_IN_FLIGHT_PER_TENANT, DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT,
  MAX_BODY_BYTES, MAX_ATTACHMENTS,
} from './limits.js'
import { AuditLog, auditMiddleware } from './audit.js'

const BASE = '/api/ext/v1'
/** Operation tag for `IdempotencyStore` (see idempotency.ts's own header comment): the store is
 *  shared with routes.chats.ts's `'chats:create'`, so this tag is what keeps a reused
 *  `Idempotency-Key` value from colliding across the two genuinely different operations — e.g.
 *  a client that reuses one key across "create the chat" and "send the first message". */
const IDEMPOTENCY_OP = 'runs:generate'

export interface RunDeps {
  /** Builds the body the manager drives. Injected so route tests need no model. */
  makeBody: (args: { chatId: string; messageId: string; scope: { tenant: string; owner: string } }) => RunBody
}

export interface ExtRouteDeps {
  idempotency: IdempotencyStore
  limiter: TenantLimiter
  audit?: AuditLog
}

/** What the idempotency store remembers for the generate path: enough to REATTACH to the
 *  already-created run, not a frozen response body — the true "result" of a generation is live
 *  and possibly still streaming, so a replay reconnects to the same run rather than replaying a
 *  stale snapshot (see the replay branch in the route below). */
interface GenerateReplay { runId: string; userMessageId: string; messageId: string }

function toRunDTO(r: PublicRun): Record<string, unknown> {
  return {
    id: r.id, chat_id: r.chatId, message_id: r.messageId, status: r.status,
    event_seq: r.eventSeq, error: r.error, created_at: r.createdAt, ended_at: r.endedAt,
  }
}

/** Emits the same `run` frame + live/replayed event stream a fresh SSE request gets, or the same
 *  202 JSON envelope — shared by both the just-created path and the idempotent-replay path so
 *  a retry that reattaches is indistinguishable on the wire from a client that reconnected on
 *  its own via GET .../stream. `fromSeq` lets a replay attempt a full-history replay (seq 0);
 *  `runs.canReplayFrom` is checked first so a replay that has aged out of the ring buffer fails
 *  with the same documented `replay_window_exceeded` conflict the dedicated reconnect endpoint
 *  already uses, instead of silently starting mid-stream or hanging. */
function respondWithRun(
  c: Context, runs: PublicRunManager, run: PublicRun, userMsgId: string, assistantMsgId: string,
) {
  if ((c.req.header('Accept') ?? '').includes('text/event-stream')) {
    if (!runs.canReplayFrom(run.id, 0)) {
      return extError(c, 'conflict', 'replay_window_exceeded',
        'That cursor has aged out of the replay buffer. Re-read the message, then attach at the run current event_seq.')
    }
    return streamSSE(c, async (stream) => {
      const sub = runs.subscribe(run.id, 0)
      stream.onAbort(() => { sub.close() })   // dropping the stream must NOT abort the run
      await stream.writeSSE({
        event: 'run',
        data: JSON.stringify({ run_id: run.id, user_message_id: userMsgId, message_id: assistantMsgId, event_seq: 0 }),
      })
      for await (const ev of sub) {
        await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
      }
    })
  }
  return c.json(toRunDTO(run), 202)
}

/** `ext` is optional for the same reason `routes.chats.ts`'s is: pre-existing test harnesses
 *  that construct this route set directly (without going through mount.ts) keep compiling and
 *  behaving exactly as before, with a private, generously-capped fallback instance. */
export function registerExtRunRoutes(app: Hono, d: Deps, runs: PublicRunManager, rd: RunDeps, ext?: ExtRouteDeps): void {
  /** One active run per chat, mirroring the internal `inflight` 409. */
  const inflight = new Map<string, string>()
  const idempotency = ext?.idempotency ?? new IdempotencyStore()
  const limiter = ext?.limiter ?? new TenantLimiter({
    maxInFlight: DEFAULT_MAX_IN_FLIGHT_PER_TENANT,
    ratePerMinute: DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT,
  })
  const audit = ext?.audit ?? new AuditLog(d.db)

  // auditMiddleware is registered BEFORE requireScope (here and on /runs/:id/cancel below) —
  // see routes.chats.ts's identical comment on why: `requireScope` returns early without
  // calling `next()` on a scope refusal, so an `auditMiddleware` registered after it would
  // never run for that refusal.
  app.post(`${BASE}/chats/:id/messages/generate`, auditMiddleware(audit, 'run.start'), requireScope('runs:write'), async (c) => {
    const chatId = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as {
      role?: 'user'; content?: string; owner?: string
      attachments?: string[]; metadata?: Record<string, unknown>
    }
    const scope = scopeFor(c, b.owner)
    const content = (b.content ?? '').trim()
    const attachments = b.attachments
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || undefined

    // Idempotent replay (spec §7.6), checked before ANY validation/persistence/limiter charge —
    // a cached key means a run for this exact request already exists, so we reattach to THAT
    // run instead of re-running any of the checks below.
    if (idempotencyKey) {
      const cached = idempotency.lookup(scope.tenant, IDEMPOTENCY_OP, idempotencyKey) as GenerateReplay | null
      if (cached) {
        const existing = runs.get(cached.runId)
        if (!existing || existing.tenant !== scope.tenant) {
          // PublicRunManager.prune() (server.ts, ~1h) retires ended runs well before the
          // idempotency entry's own TTL (24h default) expires — a replay CAN legitimately
          // outlive the run it points to. Failing closed here is deliberate: silently falling
          // through to create a fresh run would be the exact double-send this exists to
          // prevent, so an aged-out replay is refused rather than risked.
          return extError(c, 'conflict', 'idempotency_replay_expired',
            'The original run for this Idempotency-Key is no longer available to replay. If you intend to send a new message, retry with a new Idempotency-Key.',
            { status: 409, retryable: false })
        }
        // The real run id — this route's own `:id` param names the CHAT, not the run, and a
        // replay reattaches to an EXISTING run rather than starting a new one.
        c.set('auditTargetId', existing.id)
        return respondWithRun(c, runs, existing, cached.userMessageId, cached.messageId)
      }
    }

    // "Type a message OR attach a file" (spec 27 §3.2/§5.1) — content alone is no longer the
    // only way to satisfy this; an attachments-only message is legitimate and must not be
    // rejected just because `content` trims to empty.
    if (!content && !(attachments?.length)) return extError(c, 'invalid_request', 'invalid_input', 'Type a message or attach a file.', { param: 'content' })

    // Body/attachment caps (spec 27 §4.1), checked purely from the request body — before ANY
    // store I/O, the inflight reservation below, or the limiter charge — so an over-limit write
    // costs nothing and leaves nothing dangling, same discipline as every other pre-persistence
    // guard on this route. `MAX_BODY_BYTES`/`MAX_ATTACHMENTS` (limits.ts) are the exact numbers
    // `GET /capabilities` advertises — imported, not re-hardcoded, so the two can't drift.
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

    // Reserve the inflight slot SYNCHRONOUSLY — before ANY `await` below (`getChat`,
    // `loadFullHistory`, the persistence calls) — so two near-simultaneous generate requests for
    // the same chat cannot both observe an empty slot and both proceed (the TOCTOU this map
    // exists to prevent: JS only yields to another request's synchronous code at an `await`
    // point, so check-then-set with no `await` between them is atomic in practice). The
    // placeholder is replaced with the real run id once one exists, or removed again by
    // `releaseInflight()` on every failure path between here and `runs.start()` — a request that
    // reserves the slot but never actually starts a run (context overflow, a store failure, a
    // rate-limit refusal) must not leave the chat permanently blocked.
    if (inflight.has(chatId)) {
      return extError(c, 'conflict', 'generation_in_flight', 'A generation is already running for this chat.', { retryable: true })
    }
    const PENDING = ''   // never a real run id (`run_${uuid}`), so this can't collide
    inflight.set(chatId, PENDING)
    const releaseInflight = () => { if (inflight.get(chatId) === PENDING) inflight.delete(chatId) }

    let chat: Chat | null
    try {
      chat = await d.chatStore.getChat(scope, chatId)
    } catch (e) {
      releaseInflight()
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
    if (!chat) { releaseInflight(); return extError(c, 'not_found', 'not_found', 'Not found.') }

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) {
      releaseInflight()
      return extError(c, 'conflict', 'model_not_loaded', 'Load a model first.', { retryable: true })
    }

    // Context-window check (spec 27 §7.2), checked BEFORE any persistence and BEFORE the
    // limiter charges the tenant's concurrency slot — a request that cannot possibly generate
    // must not leave a user turn, a dangling assistant placeholder, or a held rate-limit slot
    // behind. v1 REFUSES an over-long history rather than silently truncating it: silent
    // truncation would mean the model answering from a history the integrator believes it sent.
    // Reuses generation.ts's `loadFullHistory` (pages via cursor until exhausted) and
    // `buildGenerationCtx` (prepends the system prompt, folds prior `reasoning` into `<think>`
    // blocks) — the SAME assembly the real generation path hands the engine moments later. A
    // single capped `listMessages(scope, chatId, { limit: 200 })` call would silently return only
    // the OLDEST page once a chat passes 200 stored messages (`SqliteChatStore.clampLimit`),
    // letting this check pass a conversation whose true full history overflows the window — see
    // `loadFullHistory`'s own header comment for the exact failure mode this avoids.
    let history: ChatMessage[]
    try {
      history = await loadFullHistory(d.chatStore, scope, chatId)
    } catch (e) {
      releaseInflight()
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }
    const ctx = buildGenerationCtx(chat, history)
    const prospective = [
      ...ctx.engineMessages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
      { role: 'user', content },
    ]
    const fit = checkContextFits(d, prospective)
    if (!fit.fits) {
      releaseInflight()
      return extError(c, 'engine', 'context_overflow',
        `This conversation is about ${fit.estimated} tokens, which exceeds the loaded model's ${fit.limit}-token window. Start a new chat or load a longer-context model.`,
        { status: 409 })
    }

    // Per-tenant concurrency cap (spec 27 §8.4), checked BEFORE any persistence — a refusal
    // here must leave nothing dangling: no user turn, no assistant placeholder, no run.
    if (!limiter.tryAcquire(scope.tenant)) {
      releaseInflight()
      return extError(c, 'capacity', 'rate_limited',
        'Too many concurrent generations for this tenant. Wait for one to finish and retry.',
        { status: 429, retryable: true, retryAfterMs: 5_000 })
    }

    // 2. Persist BEFORE the engine is touched. A failed write here costs no GPU time and
    //    leaves the caller with nothing dangling. Attachments/metadata are the USER turn's own —
    //    the assistant placeholder never receives them, it starts genuinely empty.
    let userMsgId: string
    let assistantMsgId: string
    try {
      const user = await d.chatStore.addMessage(scope, chatId, { role: 'user', content, attachments, metadata: b.metadata })
      const placeholder = await d.chatStore.addMessage(scope, chatId, { role: 'assistant', content: '', status: 'streaming' })
      userMsgId = user.id
      assistantMsgId = placeholder.id
    } catch (e) {
      limiter.release(scope.tenant)
      releaseInflight()
      const m = mapStoreError(e)
      return extError(c, m.type, m.code, m.message, { status: m.status, retryable: m.retryable })
    }

    const run = runs.start({
      scope, chatId, messageId: assistantMsgId,
      body: rd.makeBody({ chatId, messageId: assistantMsgId, scope }),
    })
    // The real created run id — again, this route's `:id` param names the CHAT, not the run.
    c.set('auditTargetId', run.id)
    // Commit point: immediately after the run is created, BEFORE any engine work starts (spec
    // §7.6 — this is the property that matters most for this whole feature). `runs.start()` has
    // already returned a live `PublicRun` at this line; the injected body's own first engine
    // fetch is still at least one microtask away. A retry that lands anywhere after this line
    // finds this entry and reattaches via the branch above instead of starting a second run.
    if (idempotencyKey) idempotency.remember(scope.tenant, IDEMPOTENCY_OP, idempotencyKey, { runId: run.id, userMessageId: userMsgId, messageId: assistantMsgId } satisfies GenerateReplay)
    // Upgrade the reservation to the real run id — the map has held `chatId` since before the
    // first `await` above, so this is never a fresh `.set()` racing anything.
    inflight.set(chatId, run.id)
    // Released when the run actually SETTLES, not when this HTTP response is sent — the route
    // itself never blocks on generation, so this is fire-and-forget off the manager's own
    // completion signal (Task 3's `runs.settled`).
    void runs.settled(run.id).finally(() => { inflight.delete(chatId); limiter.release(scope.tenant) })

    return respondWithRun(c, runs, run, userMsgId, assistantMsgId)
  })

  // Every run lookup below checks BOTH `tenant` and `owner` (spec 27 §3.1) — tenant alone is
  // not enough, since one tenant's API key is shared across an integrator's many end users.
  // `scopeFor` resolves owner the same way every other route on this surface does (defaulting to
  // 'default' when the request supplies none), so a caller that never sends `owner` still only
  // ever sees its own default-owner runs, never another owner's. The not-found response is
  // IDENTICAL whether the run belongs to another tenant, another owner, or doesn't exist at all —
  // distinguishing those would leak existence across owners the same way a 403-vs-404 split would
  // leak it across tenants (spec 27 §7.2's existing convention, just extended to `owner`).
  app.get(`${BASE}/runs`, requireScope('chats:read'), (c) => {
    const scope = scopeFor(c, c.req.query('owner'))
    return c.json({ data: runs.list(scope.tenant, scope.owner).map(toRunDTO) })
  })

  app.get(`${BASE}/runs/:id`, requireScope('chats:read'), (c) => {
    const scope = scopeFor(c, c.req.query('owner'))
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== scope.tenant || run.owner !== scope.owner) return extError(c, 'not_found', 'not_found', 'Not found.')
    runs.touch(run.id)   // a poll is liveness (spec §6.5) — without this the reaper kills pollers
    return c.json(toRunDTO(run))
  })

  app.get(`${BASE}/runs/:id/stream`, requireScope('chats:read'), (c) => {
    const scope = scopeFor(c, c.req.query('owner'))
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== scope.tenant || run.owner !== scope.owner) return extError(c, 'not_found', 'not_found', 'Not found.')
    const after = c.req.query('after') ? Number(c.req.query('after')) : 0
    if (!runs.canReplayFrom(run.id, after)) {
      return extError(c, 'conflict', 'replay_window_exceeded',
        'That cursor has aged out of the replay buffer. Re-read the message, then attach at the run current event_seq.')
    }
    return streamSSE(c, async (stream) => {
      const sub = runs.subscribe(run.id, after)
      stream.onAbort(() => { sub.close() })
      for await (const ev of sub) {
        await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) })
      }
    })
  })

  app.post(`${BASE}/runs/:id/cancel`, auditMiddleware(audit, 'run.cancel'), requireScope('runs:write'), (c) => {
    const scope = scopeFor(c, c.req.query('owner'))
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== scope.tenant || run.owner !== scope.owner) return extError(c, 'not_found', 'not_found', 'Not found.')
    const cancelled = runs.cancel(run.id)
    if (!cancelled) return extError(c, 'conflict', 'not_active', 'That run has already ended.')
    return c.json(toRunDTO(run))
  })
}
