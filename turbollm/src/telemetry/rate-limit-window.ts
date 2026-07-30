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
