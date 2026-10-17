/**
 * Pure fixed-window rate-limit arithmetic (ADR-299 follow-up). Lives here,
 * not in `telemetry-worker/`, for the same reason `ingest.ts`/`schema.ts` do:
 * this repo's test runner only covers `turbollm/src/**`, and this exact class
 * of bug — a rate limiter that silently enforces nothing — has already
 * shipped twice this cycle (a KV counter, then Cloudflare's native Rate
 * Limiting binding, both verified live to never reject a real burst). The
 * Durable Object in `telemetry-worker/src/rate-limiter-do.ts` imports this
 * function rather than reimplementing it.
 */

export interface RateLimitWindow {
  count: number
  windowStart: number
}

// Both must clear MAX_BATCH (ingest.ts): uploader.ts sends a client's ENTIRE
// queue in one unbatched request, so a limit smaller than a single legitimate
// worst-case flush deadlocks that client forever (a rejected flush leaves
// events queued for retry, and every retry is the same size or larger).
// MACHINE_LIMIT is exactly 2x MAX_BATCH; IP_LIMIT keeps the original 1:5
// machine:IP ratio. Exported (not left as a duplicated literal in index.ts
// and the test) so the two can never drift apart again the way the
// request-scale limits (20/100) silently did after charging switched to
// event count (found in pre-release review).
export const MACHINE_LIMIT = 1000
export const IP_LIMIT = 5000

// IP_LIMIT bounds a minute, not a day: one IP (or IPv6 /64) holding it for a
// day writes 7.2M D1 rows, quarantined ones included, of up to MAX_EVENT_BYTES
// (4 KB) each, ~29 GB, which fills a D1 database (10 GB at most) within
// hours, after which storing real events fails silently. This caps the day
// at 20 full queue drains (MAX_BATCH), so a machine catching up or a shared
// NAT keeps room, and one key's worst case is ~40 MB a day.
export const IP_DAILY_LIMIT = 10_000

/** The IP tiers the Worker charges, in order, each on its own rate-limiter
 *  key (`<key>:<ip hash>`) with accepted plus quarantined events, at least 1.
 *  Exported, like the limits above, so the regression test runs the Worker's
 *  own tiers rather than a copy of them. */
export const IP_TIERS: readonly { key: string; limit: number; periodSeconds: number }[] = [
  { key: 'ip', limit: IP_LIMIT, periodSeconds: 60 },
  { key: 'ipday', limit: IP_DAILY_LIMIT, periodSeconds: 86_400 },
]

export interface RateLimitCheck {
  /** The window state to persist, or `null` if nothing should be written. */
  next: RateLimitWindow | null
  success: boolean
}

/**
 * One honest caveat, inherent to any fixed window (not specific to this
 * implementation — GitHub's and Stripe's public rate limiters use the same
 * shape): a caller can burst up to ~2x the limit across a window boundary
 * (e.g. `limit` requests at t=59s plus `limit` more at t=61s). Accepted here,
 * not a defect — closing it needs a sliding-window log, which costs more
 * storage per key for a threat model that only needs "a flood stays noisy,
 * not expensive."
 */
export function evaluateWindow(
  existing: RateLimitWindow | undefined,
  now: number,
  periodMs: number,
  amount: number,
  limit: number,
): RateLimitCheck {
  // A zero-event batch (e.g. one that validated to nothing) consumes no
  // capacity — always allow it, and don't bother writing.
  if (amount === 0) return { next: null, success: true }

  const inCurrentWindow = existing !== undefined && now - existing.windowStart < periodMs
  const currentCount = inCurrentWindow ? existing.count : 0

  if (currentCount >= limit) {
    // Already over limit for this window: reject without paying for another
    // storage write. A sustained flood against one key should not cost
    // anything beyond the first rejection.
    return { next: null, success: false }
  }

  const next: RateLimitWindow = inCurrentWindow
    ? { count: existing.count + amount, windowStart: existing.windowStart }
    : { count: amount, windowStart: now }

  return { next, success: next.count <= limit }
}

/**
 * What the IP tier is keyed on. An IPv6 host normally controls a whole /64
 * (2^64 source addresses), so keying on the full address hands an attacker a
 * fresh IP_LIMIT per address; key on the /64 instead. IPv4, an IPv6 address
 * with an embedded IPv4 tail (::ffff:1.2.3.4, whose /64 is shared by every
 * such address) and anything unparseable keep the whole string, as before.
 */
export function ipRateLimitSubject(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip
  const halves = ip.toLowerCase().split('::')
  if (halves.length > 2) return ip
  const split = (s: string): string[] => (s ? s.split(':') : [])
  const head = split(halves[0])
  const tail = halves.length === 2 ? split(halves[1]) : []
  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (zeros < 0) return ip
  const groups = [...head, ...Array<string>(zeros).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip
  // parseInt drops leading zeros, so every spelling of one /64 yields one key.
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}
