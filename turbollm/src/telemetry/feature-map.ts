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

/** Route segment → feature. Keys are the segment straight after `/api/v1/`.
 *
 * `skills` and `chat-agents` are DELIBERATELY absent, despite being real
 * features. Found live, clicking through the running app: the chat compose
 * screen fetches both endpoints unconditionally to populate its persona/agent
 * picker, on every single chat visit — before a user has ever opened
 * Customize -> Skills/Agents, let alone used one. A path-based check cannot
 * tell "populating a picker" apart from "the user opened this feature", since
 * both hit the identical endpoint. Mapping them would mark every user as
 * having discovered Skills and Agents on day one, silently corrupting the
 * exact signal this system exists to produce — worse than not measuring it.
 * Left out until a front-end-driven signal exists instead of this blanket
 * path heuristic (e.g. fired from Customize's own tab mount, or when a skill/
 * agent is actually invoked in a turn). */
const BY_SEGMENT: Record<string, string> = {
  chat: 'chat',
  code: 'code',
  artifacts: 'artifacts',
  mcp: 'mcp',
  bench: 'autotune',
}

/** The feature a request belongs to, or null if it is not an instrumented
 *  surface. Matches whole segments, so `/api/v1/codex` is not `code`. */
export function featureForPath(path: string): string | null {
  const m = /^\/api\/v1\/([^/?]+)/.exec(path)
  if (m === null) return null
  return BY_SEGMENT[m[1]] ?? null
}
