/**
 * A hard, exact rate limiter (ADR-299 follow-up to the native Rate Limiting
 * binding). Cloudflare's own docs describe that binding as "permissive,
 * eventually consistent, and intentionally designed to not be used as an
 * accurate accounting system" — verified against the live deployed Worker:
 * 65 rapid requests to the same key (sequential, then fully concurrent) were
 * ALL accepted against a configured 20/60s limit, because that binding keeps
 * a per-isolate cache that syncs asynchronously in the background rather
 * than a single source of truth.
 *
 * A Durable Object IS a single source of truth for a given key:
 * `idFromName(key)` always routes to the same object instance, and a
 * Durable Object serializes every request to itself, so the fixed-window
 * counter cannot race the way the per-isolate cache did. The window
 * arithmetic itself lives in `turbollm/src/telemetry/rate-limit-window.ts`
 * (imported below) rather than here, so it can be unit tested under the
 * daemon's existing test runner — this repo has no test framework capable of
 * simulating a real Durable Object, and this exact class of bug has already
 * shipped twice this cycle.
 *
 * Pre-release review (before this shipped) also found:
 *   1. A missing/malformed `limit`/`period`/`amount` must fail CLOSED, not
 *      open — this class' entire history is "silently enforces nothing."
 *   2. Every key ever seen creates a Durable Object; without an expiry, that
 *      object is billed forever (Cloudflare's pricing docs: storage is
 *      billed until removed, and nothing else here would ever remove it).
 *      The `alarm()` below restores the self-cleaning property the old KV
 *      version had via `expirationTtl`.
 */
import { evaluateWindow, type RateLimitWindow } from '../../turbollm/src/telemetry/rate-limit-window'

interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    deleteAll(): Promise<void>
    setAlarm(scheduledTime: number): Promise<void>
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

export class RateLimiterDO {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const limit = Number(url.searchParams.get('limit'))
    const periodMs = Number(url.searchParams.get('period')) * 1000
    const amount = Number(url.searchParams.get('amount'))

    const paramsValid =
      Number.isFinite(limit) && limit > 0 && Number.isFinite(periodMs) && periodMs > 0 && Number.isFinite(amount) && amount >= 0
    if (!paramsValid) return json({ success: false })

    const now = Date.now()
    const existing = await this.state.storage.get<RateLimitWindow>('window')
    const { next, success } = evaluateWindow(existing, now, periodMs, amount, limit)

    if (next !== null) {
      await this.state.storage.put('window', next)
      // Self-expire `periodMs` after the LAST write to this key. A key that
      // keeps receiving traffic just keeps pushing this forward (harmless —
      // the window logic above already governs enforcement); a key that goes
      // idle gets its storage reclaimed instead of billing forever.
      await this.state.storage.setAlarm(now + periodMs)
    }

    return json({ success })
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}
