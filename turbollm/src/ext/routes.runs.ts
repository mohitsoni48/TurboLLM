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
import { requireScope, scopeFor } from './auth.js'
import { extError, mapStoreError } from './errors.js'
import { PublicRunManager, type PublicRun, type RunBody } from './run-manager.js'
import { IdempotencyStore } from './idempotency.js'
import { TenantLimiter, DEFAULT_MAX_IN_FLIGHT_PER_TENANT, DEFAULT_REQUESTS_PER_MINUTE_PER_TENANT } from './limits.js'
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
    const b = await c.req.json().catch(() => ({})) as { role?: 'user'; content?: string; owner?: string }
    const scope = scopeFor(c, b.owner)
    const content = (b.content ?? '').trim()
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

    if (!content) return extError(c, 'invalid_request', 'invalid_input', 'Type a message or attach a file.', { param: 'content' })

    const chat = await d.chatStore.getChat(scope, chatId)
    if (!chat) return extError(c, 'not_found', 'not_found', 'Not found.')

    if (inflight.has(chatId)) {
      return extError(c, 'conflict', 'generation_in_flight', 'A generation is already running for this chat.', { retryable: true })
    }

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) {
      return extError(c, 'conflict', 'model_not_loaded', 'Load a model first.', { retryable: true })
    }

    // Per-tenant concurrency cap (spec 27 §8.4), checked BEFORE any persistence — a refusal
    // here must leave nothing dangling: no user turn, no assistant placeholder, no run.
    if (!limiter.tryAcquire(scope.tenant)) {
      return extError(c, 'capacity', 'rate_limited',
        'Too many concurrent generations for this tenant. Wait for one to finish and retry.',
        { status: 429, retryable: true, retryAfterMs: 5_000 })
    }

    // 2. Persist BEFORE the engine is touched. A failed write here costs no GPU time and
    //    leaves the caller with nothing dangling.
    let userMsgId: string
    let assistantMsgId: string
    try {
      const user = await d.chatStore.addMessage(scope, chatId, { role: 'user', content })
      const placeholder = await d.chatStore.addMessage(scope, chatId, { role: 'assistant', content: '', status: 'streaming' })
      userMsgId = user.id
      assistantMsgId = placeholder.id
    } catch (e) {
      limiter.release(scope.tenant)
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
    inflight.set(chatId, run.id)
    // Released when the run actually SETTLES, not when this HTTP response is sent — the route
    // itself never blocks on generation, so this is fire-and-forget off the manager's own
    // completion signal (Task 3's `runs.settled`).
    void runs.settled(run.id).finally(() => { inflight.delete(chatId); limiter.release(scope.tenant) })

    return respondWithRun(c, runs, run, userMsgId, assistantMsgId)
  })

  app.get(`${BASE}/runs`, requireScope('chats:read'), (c) =>
    c.json({ data: runs.list(c.get('extTenant') as string).map(toRunDTO) }))

  app.get(`${BASE}/runs/:id`, requireScope('chats:read'), (c) => {
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== c.get('extTenant')) return extError(c, 'not_found', 'not_found', 'Not found.')
    runs.touch(run.id)   // a poll is liveness (spec §6.5) — without this the reaper kills pollers
    return c.json(toRunDTO(run))
  })

  app.get(`${BASE}/runs/:id/stream`, requireScope('chats:read'), (c) => {
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== c.get('extTenant')) return extError(c, 'not_found', 'not_found', 'Not found.')
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
    const run = runs.get(c.req.param('id'))
    if (!run || run.tenant !== c.get('extTenant')) return extError(c, 'not_found', 'not_found', 'Not found.')
    const cancelled = runs.cancel(run.id)
    if (!cancelled) return extError(c, 'conflict', 'not_active', 'That run has already ended.')
    return c.json(toRunDTO(run))
  })
}
