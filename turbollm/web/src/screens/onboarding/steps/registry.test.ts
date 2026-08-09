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
    const ctx = { profile: 'casual' as const, downloadDone: false, isT0: false, recommendationKind: 'entry' as const, expectedModelKey: null, payoffDestination: null, loadCompletedOnce: false }
    expect(REGISTRY.find((s) => s.id === 'welcome')!.appliesTo(ctx)).toBe(true)
    expect(REGISTRY.find((s) => s.id === 'payoff')!.appliesTo(ctx)).toBe(true)
  })
})
