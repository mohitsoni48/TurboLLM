/** CI guard — no step without a tracked skip (spec 25 §3.1, ADR-340).

 * Mirrors the daemon's UI_ACTIONS additions. Duplicated on purpose: web must
 * not import from the daemon's telemetry module. Drift here is caught by this
 * test failing, which is the point. */

import { describe, it, expect } from 'vitest'
import { REGISTRY, STEP_IDS } from './registry'

/** One skip action per registered step — where people bail is the entire
 * diagnostic value of the funnel. */
const TRACKED_SKIPS = [
  'skip_onboarding_welcome', 'skip_onboarding_profile', 'skip_onboarding_model',
  'skip_onboarding_personalize', 'skip_onboarding_profile_extra', 'skip_onboarding_load',
  'skip_onboarding_payoff', 'skip_onboarding_tune_offer', 'skip_onboarding_done',
] as const

const actionFor = (id: string) => `skip_onboarding_${id.replace(/-/g, '_')}`

describe('skip coverage', () => {
  it('every registered step is skippable', () => {
    for (const s of REGISTRY) expect(s.skippable, `${s.id}`).toBe(true)
  })

  it('every registered step has a tracked skip action', () => {
    for (const id of STEP_IDS) {
      expect(TRACKED_SKIPS,
        `step "${id}" has no skip action - add ${actionFor(id)} to UI_ACTIONS`,
      ).toContain(actionFor(id))
    }
  })

  it('there are no orphaned skip actions for steps that no longer exist', () => {
    const expected = STEP_IDS.map(actionFor)
    for (const a of TRACKED_SKIPS) expect(expected, `orphaned action ${a}`).toContain(a)
  })
})
