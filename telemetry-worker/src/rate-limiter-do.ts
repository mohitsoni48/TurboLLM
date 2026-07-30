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
 * counter below cannot race the way the per-isolate cache did. The
 * tradeoff is scale (~1000 req/s per object) and an extra storage hop —
 * both fine here, since no single rate-limit key should ever see traffic
 * anywhere near that volume.
 */
interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
  }
}

interface RateLimitWindow {
  count: number
  windowStart: number
}

export class RateLimiterDO {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const limit = Number(url.searchParams.get('limit'))
    const periodMs = Number(url.searchParams.get('period')) * 1000

    const now = Date.now()
    const existing = await this.state.storage.get<RateLimitWindow>('window')
    const inCurrentWindow = existing !== undefined && now - existing.windowStart < periodMs

    const next: RateLimitWindow = inCurrentWindow
      ? { count: existing.count + 1, windowStart: existing.windowStart }
      : { count: 1, windowStart: now }

    await this.state.storage.put('window', next)

    return new Response(JSON.stringify({ success: next.count <= limit }), {
      headers: { 'content-type': 'application/json' },
    })
  }
}
