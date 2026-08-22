/** Gateway volume + harness identity (spec 23 §3.5, ADR-333). Read-only
 *  aggregation over the existing `api_usage` table (`ConversationStore.
 *  gatewayDailyStats`) — no new write on the gateway's own hot request path.
 *
 *  `harness` is classified from the request's `User-Agent` header
 *  (`classify.ts`'s `classifyHarness`, Phase 5) at the two gateway entry
 *  points (`gateway.ts`) and persisted onto `api_usage.harness`, so this
 *  daily rollup and `harness_first_seen` below both read a real per-client
 *  value instead of the `'unknown'` placeholder every row emitted before
 *  Phase 5 shipped (the gateway read zero request headers until then).
 *
 *  `errors` (spec 23 §3.5's original sketch) is not included: `api_usage`
 *  has no outcome/error column today, so there is nothing to aggregate
 *  without new write-path instrumentation — a separate, tracked follow-up
 *  (TODO.md), not fabricated here. */

import { defineEvent, f } from '../core/define'

export const HARNESSES = [
  'claude_code', 'opencode', 'kilo', 'hermes', 'openclaw', 'pi', 'continue',
  'cline', 'zed', 'vscode', 'cursor', 'aider', 'roo', 'turbollm_ui', 'other', 'unknown',
  // DeepSeek Harness (`@deepseek-ai/dsh`, MIT, first published 2026-08-13). Appended rather than
  // inserted in place: this list's ORDER is part of the event schema, so slotting a new value in
  // the middle would silently reinterpret every already-collected row.
  'deepseek',
] as const

export const gatewayDaily = defineEvent({
  name: 'gateway_daily',
  since: 2,
  consent: 'full',
  lifecycle: 'daily-rollup',
  description: "Yesterday's gateway request volume for this machine, grouped by protocol and harness.",
  payload: {
    /** Whole days back from this event's `ts` that these counters describe —
     *  see `chat.ts` for the full rationale. */
    daysAgo: f.int({ min: 0, max: 366, optional: true }),
    harness: f.enum(HARNESSES),
    protocol: f.enum(['anthropic', 'openai']),
    requests: f.int(),
    promptTokens: f.int(),
    genTokens: f.int(),
    distinctModels: f.int(),
  },
})

/** The first time this machine's gateway is ever seen talking to a given
 *  harness (spec 23 §3.5) — parametrized once-per-value, the same shape as
 *  `feature_first_use` but keyed on `harness` instead of a feature name
 *  (`Emitter.harnessFirstSeen`). Fires even for `'unknown'`: per spec Gap C's
 *  own fallback plan, real-world `unknown` volume is the intended signal for
 *  which client `classifyHarness` still needs to learn to recognise, not
 *  something to suppress. */
export const harnessFirstSeen = defineEvent({
  name: 'harness_first_seen',
  since: 2,
  consent: 'full',
  lifecycle: 'once-by-key',
  description: 'The first time this machine is seen talking to the gateway via a given harness.',
  payload: {
    harness: f.enum(HARNESSES),
    protocol: f.enum(['anthropic', 'openai']),
  },
})
