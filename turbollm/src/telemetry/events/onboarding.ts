/**
 * `onboarding_step` (spec 24, ADR-333) — unchanged from ADR-299 Decision 6,
 * amended by ADR-323 and the telemetry-review follow-through (`failReason`).
 *
 * TEMPORARY. Spec 23 §4 deletes this event entirely — onboarding becomes a
 * PostHog funnel derived from real events instead of steps packed into one
 * event's parameter space, which is exactly the F1 rigidity this whole
 * redesign exists to fix (ADR-333). Kept in its own file, unmodified, so its
 * eventual removal (Phase 7) is a clean single-file deletion rather than a
 * surgical edit inside a file other events still depend on.
 */

import { defineEvent, f } from '../core/define'
import { ONBOARDING_STEPS, OUTCOMES, PROVISION_FAIL_REASONS } from '../core/enums'

export const onboardingStep = defineEvent({
  name: 'onboarding_step',
  since: 1,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One step of the install -> first-load journey. See TODO.md for the Phase 7 removal plan.',
  payload: {
    step: f.enum(ONBOARDING_STEPS),
    outcome: f.enum(OUTCOMES),
    // Only ever sent for step: 'engine_install' today (classifyProvisionFailure)
    // — not step-conditional at the schema level, enforced by convention at
    // the one call site that sends it, same as the original schema.ts.
    failReason: f.enum(PROVISION_FAIL_REASONS, { optional: true }),
  },
})
