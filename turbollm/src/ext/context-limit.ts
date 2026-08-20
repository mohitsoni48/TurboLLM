// turbollm/src/ext/context-limit.ts
//
// Spec 27 §7.2. This product's pitch is 200k contexts, so a long chat exceeding a smaller
// loaded model's window is an ordinary case, not an edge one. v1 refuses with
// `context_overflow` rather than truncating: silent truncation means the model answering from
// a history the integrator believes it sent, and no error to explain the difference.
import type { Deps } from '../deps.js'

/** Chars-per-token heuristic. Deliberately crude and deliberately CONSERVATIVE (a low
 *  divisor over-estimates), because a false "fits" wastes a whole generation while a false
 *  "does not fit" costs one clear, actionable error. */
const CHARS_PER_TOKEN = 3.5

/** Tokens held back for the reply. A prompt that exactly fills the window leaves no room to
 *  answer, which the engine reports as a far more confusing failure. */
const REPLY_HEADROOM = 512

export function estimateTokens(messages: Array<{ role: string; content: string }>): number {
  let chars = 0
  for (const m of messages) chars += m.content.length + m.role.length + 4
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function checkContextFits(
  d: Deps,
  messages: Array<{ role: string; content: string }>,
): { fits: boolean; estimated: number; limit: number } {
  const status = d.manager.status() as { contextSize?: number }
  const limit = status.contextSize ?? 0
  const estimated = estimateTokens(messages)
  // An unknown window is permissive: refusing a request because we could not READ the limit
  // would turn a missing field into an outage.
  if (!limit) return { fits: true, estimated, limit: 0 }
  return { fits: estimated + REPLY_HEADROOM <= limit, estimated, limit }
}
