import { describe, it, expect } from 'vitest'
import { deriveSteps, reduce, resumeAt, type MachineState } from './machine'
import { STEP_IDS } from './steps/registry'
import type { StepContext } from './steps/define'

const ctx = (p: Partial<StepContext> = {}): StepContext =>
  ({ profile: 'casual', downloadDone: false, isT0: false, recommendationKind: 'entry', expectedModelKey: null, expectedDownloadId: null, loadCompletedOnce: false, ...p })

describe('deriveSteps', () => {
  it('drops the download-shadow steps once the model is present', () => {
    const ids = deriveSteps(ctx({ downloadDone: true })).map((s) => s.id)
    expect(ids).not.toContain('personalize')
    expect(ids).not.toContain('profile-extra')
  })

  it('casual never gets the profile-extra step', () => {
    expect(deriveSteps(ctx({ profile: 'casual' })).map((s) => s.id)).not.toContain('profile-extra')
  })

  it('enthusiast never gets profile-extra either — their only extra content is tune-offer', () => {
    expect(deriveSteps(ctx({ profile: 'enthusiast' })).map((s) => s.id)).not.toContain('profile-extra')
  })

  it('developer and pro DO get profile-extra while a download is in flight', () => {
    expect(deriveSteps(ctx({ profile: 'developer' })).map((s) => s.id)).toContain('profile-extra')
    expect(deriveSteps(ctx({ profile: 'pro' })).map((s) => s.id)).toContain('profile-extra')
  })

  it('suppresses the auto-tune offer on T0 for EVERY profile, including pro', () => {
    for (const profile of ['casual', 'developer', 'enthusiast', 'pro'] as const) {
      const ids = deriveSteps(ctx({ profile, isT0: true })).map((s) => s.id)
      expect(ids, `${profile} on T0 must not be offered auto-tune`).not.toContain('tune-offer')
    }
  })

  it('always yields at least welcome and payoff', () => {
    const ids = deriveSteps(ctx({ profile: null })).map((s) => s.id)
    expect(ids).toContain('welcome')
    expect(ids).toContain('payoff')
  })
})

describe('reduce', () => {
  const start = (c = ctx()): MachineState => ({ currentId: 'welcome', ctx: c })

  it('next advances through the derived sequence, not the raw registry', () => {
    const s = reduce(start(ctx({ downloadDone: true, profile: 'casual' })), { type: 'next' })
    expect(s.currentId).toBe('profile')
  })

  it('next at the last step is a no-op rather than an out-of-range id', () => {
    const s = reduce({ currentId: 'payoff', ctx: ctx() }, { type: 'next' })
    expect(s.currentId).toBe('payoff')
  })

  it('a ctx patch that removes the current step relocates to a valid step', () => {
    const s = reduce({ currentId: 'personalize', ctx: ctx() }, { type: 'ctx', patch: { downloadDone: true } })
    expect(STEP_IDS).toContain(s.currentId!)
    expect(deriveSteps(s.ctx).map((x) => x.id)).toContain(s.currentId!)
  })
})

describe('resumeAt', () => {
  it('returns the saved step when it is still applicable', () => {
    expect(resumeAt('model', ctx())).toBe('model')
  })

  it('falls back to the first applicable step when the saved id no longer exists', () => {
    expect(resumeAt('a-step-removed-in-a-later-release', ctx())).toBe('welcome')
  })

  it('falls back when the saved step is no longer applicable in this context', () => {
    expect(resumeAt('personalize', ctx({ downloadDone: true }))).toBe('welcome')
  })
})
