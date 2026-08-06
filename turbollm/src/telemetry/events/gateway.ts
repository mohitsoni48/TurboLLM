/** Gateway volume + harness identity (spec 23 §3.5, ADR-333). Read-only
 *  aggregation over the existing `api_usage` table (`ConversationStore.
 *  gatewayDailyStats`) — no new write on the gateway's own hot request path.
 *
 *  `harness` is defined here as the real closed enum spec 23 §3.5 wants, but
 *  Phase 3 cannot populate it yet: the gateway reads zero request headers
 *  today, so every row emits `'unknown'` until Phase 5's client-detection
 *  work ships. Shipping the field now, even unpopulated, means Phase 5 only
 *  has to enrich an existing event rather than introduce a new one and lose
 *  whatever protocol-level volume history had already accumulated.
 *
 *  `errors` (spec 23 §3.5's original sketch) is not included: `api_usage`
 *  has no outcome/error column today, so there is nothing to aggregate
 *  without new write-path instrumentation — a separate, tracked follow-up
 *  (TODO.md), not fabricated here. */

import { defineEvent, f } from '../core/define'

export const HARNESSES = [
  'claude_code', 'opencode', 'kilo', 'hermes', 'openclaw', 'pi', 'continue',
  'cline', 'zed', 'vscode', 'cursor', 'aider', 'roo', 'turbollm_ui', 'other', 'unknown',
] as const

export const gatewayDaily = defineEvent({
  name: 'gateway_daily',
  since: 2,
  consent: 'full',
  lifecycle: 'daily-rollup',
  description: "Yesterday's gateway request volume for this machine, grouped by protocol (and harness once Phase 5 ships client detection).",
  payload: {
    harness: f.enum(HARNESSES),
    protocol: f.enum(['anthropic', 'openai']),
    requests: f.int(),
    promptTokens: f.int(),
    genTokens: f.int(),
    distinctModels: f.int(),
  },
})
