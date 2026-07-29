/**
 * Maps an API path to the product surface it belongs to (ADR-299
 * `feature_first_use`).
 *
 * Deliberately ONE table rather than a `firstUse()` call sprinkled through nine
 * route files: a call site that someone forgets to add is a feature that looks
 * undiscovered forever, and that silent gap is indistinguishable in the data
 * from "nobody uses it". A table is auditable at a glance.
 *
 * Only the path is ever inspected — never the body, never the query string.
 */

/** Route segment → feature. Keys are the segment straight after `/api/v1/`. */
const BY_SEGMENT: Record<string, string> = {
  chat: 'chat',
  code: 'code',
  artifacts: 'artifacts',
  mcp: 'mcp',
  skills: 'skills',
  'chat-agents': 'agents',
  bench: 'autotune',
}

/** The feature a request belongs to, or null if it is not an instrumented
 *  surface. Matches whole segments, so `/api/v1/codex` is not `code`. */
export function featureForPath(path: string): string | null {
  const m = /^\/api\/v1\/([^/?]+)/.exec(path)
  if (m === null) return null
  return BY_SEGMENT[m[1]] ?? null
}
