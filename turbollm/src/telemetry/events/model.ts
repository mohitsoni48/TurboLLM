/**
 * Model-load events (spec 24, ADR-333). `model_first_load` is unchanged from
 * ADR-299 Decision 6 — Phase 2 (spec 23 §3.3) adds `model_load`, the
 * per-run event with the full resolved config, alongside it in this same
 * file before `model_first_load` is retired.
 */

import { defineEvent, f } from '../core/define'
import { FAIL_REASONS, OUTCOMES } from '../core/enums'

export const modelFirstLoad = defineEvent({
  name: 'model_first_load',
  since: 1,
  consent: 'anon',
  lifecycle: 'once-with-payload',
  description: "The outcome of this install's first-ever model load attempt (including a failed one).",
  payload: {
    outcome: f.enum(OUTCOMES),
    failReason: f.enum(FAIL_REASONS, { optional: true }),
  },
})
