/** Cross-cutting events (spec 24, ADR-333): crash diagnostics and the
 *  consent ping. Both unchanged from ADR-299. */

import { defineEvent, f } from '../core/define'
import { CONSENT_LEVELS, ERROR_FINGERPRINTS } from '../core/enums'

export const errorEvent = defineEvent({
  name: 'error',
  since: 1,
  consent: 'full',
  lifecycle: 'per-action',
  description: 'An engine crash or load failure, fingerprinted. Every occurrence, not just the first.',
  payload: {
    fingerprint: f.enum(ERROR_FINGERPRINTS),
  },
})

/**
 * `consent_choice` (ADR-299 Decision 5) — the one event an opted-OUT machine
 * still sends, and the most sensitive thing in this module. Deliberately
 * has NO `payload` field here: its envelope is not the standard one at all
 * (no `ts`/`machineId`/`app`/`hw`/`payload`, just `schema`/`event`/`level`),
 * so `level` is validated as an envelope-level special case in
 * `schema.ts`'s `validateEvent`, exactly as it always was — not something
 * this registry entry's `payload` spec could express even if it tried.
 * `consent: 'always'` documents that its gating is bespoke
 * (`telemetry/consent.ts`), never the standard `Emitter.canSend` check.
 */
export const consentChoice = defineEvent({
  name: 'consent_choice',
  since: 1,
  consent: 'always',
  lifecycle: 'once',
  description: 'The user\'s telemetry level choice. Carries nothing else, ever — see ADR-299 Decision 5.',
})

/** Real values for `consent_choice.level`. Not part of `consentChoice`'s
 *  (nonexistent) `payload` — re-exported here purely so callers reach for
 *  this file rather than reaching past it into `core/enums` for the one
 *  enum this file's own event actually uses. */
export { CONSENT_LEVELS }
