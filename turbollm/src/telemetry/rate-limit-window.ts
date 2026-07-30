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
