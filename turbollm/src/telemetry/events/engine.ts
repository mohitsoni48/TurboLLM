/** Engine provisioning outcome (spec 23 §4, ADR-333). Promoted out of
 *  `onboarding_step`'s `step: 'engine_install'` into its own first-class event
 *  when `onboarding_step` was deleted (Phase 7) — the funnel derives "engine
 *  installed" from real `engine_installed{outcome:'ok'}` events instead of a
 *  step packed into one event's parameter space (the F1 rigidity ADR-333
 *  exists to fix). Not once-only: installing an engine is naturally
 *  infrequent on its own, unlike a hot path that needed a ledger guard. */

import { defineEvent, f } from '../core/define'
import { OUTCOMES, PROVISION_FAIL_REASONS, PROVISION_TRIGGERS } from '../core/enums'

export const engineInstalled = defineEvent({
  name: 'engine_installed',
  since: 2,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One engine provisioning attempt settled (success or failure).',
  payload: {
    outcome: f.enum(OUTCOMES),
    // What caused this attempt (2026-08-21 data-integrity audit). Optional so the
    // field can be added without the currently-deployed Worker rejecting events
    // from clients that predate it — the exact compatibility break that silently
    // killed `onboarding_step` for every already-shipped binary. Absent means
    // "an older client that could not tell us"; it must NOT be read as 'seed'.
    trigger: f.enum(PROVISION_TRIGGERS, { optional: true }),
    // Only ever sent on a failed attempt (classifyProvisionFailure) — same
    // convention onboarding_step's own failReason field used.
    failReason: f.enum(PROVISION_FAIL_REASONS, { optional: true }),
  },
})
