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
 * agent is actually invoked in a turn).
 *
 * `research` is ALSO deliberately absent — but for a different reason: there is
 * no dedicated endpoint for it at all. `web_search` is a tool the agent invokes
 * INSIDE a `/api/v1/chat` turn's request body, and this module's whole point is
 * that only the path is ever inspected, never the body — so there is no path
 * this table could map without breaking that guarantee. */
const BY_SEGMENT: Record<string, string> = {
  // `chat` (bare) only covers `/api/v1/chat/stop` — the Stop-generation button. Real
  // chat traffic (sending a message, creating/loading a conversation) lives under
  // `/api/v1/conversations/*` instead (PR #105 review finding: `chat` alone was
  // silently under-counting the product's own core feature). `conversations` IS the
  // chat feature's own primary data endpoint, not a foreign feature fetched as a side
  // effect the way `/api/v1/skills`/`/api/v1/chat-agents` are (see the comment below) —
  // so, unlike those two, mapping it here doesn't risk corrupting an unrelated signal.
  chat: 'chat',
  conversations: 'chat',
  code: 'code',
  artifacts: 'artifacts',
  mcp: 'mcp',
  bench: 'autotune',
  // Covers install/uninstall (explicit user setup) AND acquire/release (pushed
  // by ComfyUI's OWN gate node when an actual generation runs, not polled by
  // our UI) — unlike skills/chat-agents, every hit here is real image-gen
  // activity, not a side effect of an unrelated screen loading.
  comfyui: 'image',
  // Turbo Link (ADR-376) admin surface — `/api/v1/links/*`, the user's own browser
  // minting/managing links on their own daemon.
  links: 'link',
}

/** The feature a request belongs to, or null if it is not an instrumented
 *  surface. Matches whole segments, so `/api/v1/codex` is not `code`.
 *
 *  `/api/link/v1/*` is Turbo Link's PEER-facing contract (link-routes.ts) — a
 *  different machine calling in, not `/api/v1/...`, so it needs its own check rather
 *  than falling out of the segment regex below. Both surfaces attribute to the same
 *  `link` feature: whichever side of a link a request arrives on, it's the same
 *  product surface being used. */
export function featureForPath(path: string): string | null {
  if (path === '/api/link/v1' || path.startsWith('/api/link/v1/')) return 'link'
  const m = /^\/api\/v1\/([^/?]+)/.exec(path)
  if (m === null) return null
  return BY_SEGMENT[m[1]] ?? null
}
