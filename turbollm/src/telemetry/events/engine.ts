/** Engine provisioning outcome (spec 23 §4, ADR-333). Promoted out of
 *  `onboarding_step`'s `step: 'engine_install'` into its own first-class event
 *  when `onboarding_step` was deleted (Phase 7) — the funnel derives "engine
 *  installed" from real `engine_installed{outcome:'ok'}` events instead of a
 *  step packed into one event's parameter space (the F1 rigidity ADR-333
 *  exists to fix). Not once-only: installing an engine is naturally
 *  infrequent on its own, unlike a hot path that needed a ledger guard. */

import { defineEvent, f } from '../core/define'
import { OUTCOMES, PROVISION_FAIL_REASONS } from '../core/enums'

export const engineInstalled = defineEvent({
  name: 'engine_installed',
  since: 2,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One engine provisioning attempt settled (success or failure).',
  payload: {
    outcome: f.enum(OUTCOMES),
    // Only ever sent on a failed attempt (classifyProvisionFailure) — same
    // convention onboarding_step's own failReason field used.
    failReason: f.enum(PROVISION_FAIL_REASONS, { optional: true }),
  },
})
