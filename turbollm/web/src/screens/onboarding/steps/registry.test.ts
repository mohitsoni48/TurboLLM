import { describe, it, expect } from 'vitest'
import { REGISTRY, STEP_IDS } from './registry'

describe('step registry', () => {
  it('every step is skippable — no step can trap the user', () => {
    for (const s of REGISTRY) expect(s.skippable, `${s.id} must be skippable`).toBe(true)
  })

  it('step ids are unique and stable strings', () => {
    expect(new Set(STEP_IDS).size).toBe(STEP_IDS.length)
    for (const id of STEP_IDS) expect(typeof id).toBe('string')
  })

  it('every step has a non-empty title', () => {
    for (const s of REGISTRY) expect(s.title.length, `${s.id}`).toBeGreaterThan(0)
  })

  it('welcome and payoff apply to every profile', () => {
    const ctx = { profile: 'casual' as const, downloadDone: false, isT0: false, recommendationKind: 'entry' as const, expectedModelKey: null, expectedDownloadId: null, loadCompletedOnce: false }
    expect(REGISTRY.find((s) => s.id === 'welcome')!.appliesTo(ctx)).toBe(true)
    expect(REGISTRY.find((s) => s.id === 'payoff')!.appliesTo(ctx)).toBe(true)
  })

  // Founder-reported live: auto-tune must be offered BEFORE the user tries chat/Code, not
  // after — tuning the config before proving it works, not after. Regression-guards the
  // registry ORDER directly (not just membership), for every profile tune-offer applies to.
  it('tune-offer comes before payoff whenever both apply (non-T0)', () => {
    for (const profile of ['developer', 'enthusiast', 'pro'] as const) {
      const ctx = { profile, downloadDone: true, isT0: false, recommendationKind: 'entry' as const, expectedModelKey: null, expectedDownloadId: null, loadCompletedOnce: false }
      const ids = REGISTRY.filter((s) => s.appliesTo(ctx)).map((s) => s.id)
      const tuneIdx = ids.indexOf('tune-offer')
      const payoffIdx = ids.indexOf('payoff')
      expect(tuneIdx, `${profile}: tune-offer must apply`).toBeGreaterThanOrEqual(0)
      expect(payoffIdx, `${profile}: payoff must apply`).toBeGreaterThanOrEqual(0)
      expect(tuneIdx, `${profile}: tune-offer must precede payoff`).toBeLessThan(payoffIdx)
    }
  })

  it('tune-offer never applies on T0 hardware, for any profile', () => {
    for (const profile of ['casual', 'developer', 'enthusiast', 'pro'] as const) {
      const ctx = { profile, downloadDone: true, isT0: true, recommendationKind: 'entry' as const, expectedModelKey: null, expectedDownloadId: null, loadCompletedOnce: false }
      expect(REGISTRY.find((s) => s.id === 'tune-offer')!.appliesTo(ctx), profile).toBe(false)
    }
  })
})
