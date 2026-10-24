import { describe, expect, it } from 'vitest'
import { defaultGpu, defaultLitertLm, defaultVllm, type LoadProfile } from './types'
import { userSetPayload, userSetView, withUserGroupValue, withUserSet, withUserValue } from './user-set-profile'

function auto(): LoadProfile {
  return {
    ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvUnified: true, kvTypeK: 'f16', kvTypeV: 'f16',
    flashAttn: 'on', kvOffload: true, threads: 0, threadsBatch: 0, useMmproj: false, mmprojGpu: true,
    imageMaxTokens: 0, cacheReuse: 256, useJinja: true, chatTemplateFile: '', speculative: 'off',
    mtpHeadPath: '', draftModelPath: '',
    sampling: { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] },
    contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none', ropeFreqBase: 0, ropeFreqScale: 0,
    gpu: defaultGpu(), vllm: defaultVllm(), litertLm: defaultLitertLm(), extraArgs: [],
  }
}

describe('user-set-profile', () => {
  it('reads a profile an earlier build stored whole as the fields that differ from the automatic profile', () => {
    const whole = { ...auto(), ctx: 4096, sampling: { ...auto().sampling, topK: 20 }, litertLm: { backend: 'gpu' as const } }
    expect(userSetView(whole, auto())).toEqual({ ctx: 4096, sampling: { topK: 20 }, litertLm: { backend: 'gpu' } })
  })

  it('reads a marked profile as the user\'s in every field', () => {
    expect(userSetView({ ctx: 8192, sampling: { temp: 0.8 }, userSetOnly: true }, auto())).toEqual({ ctx: 8192, sampling: { temp: 0.8 } })
  })

  it('records a top-level and a grouped choice without touching the rest', () => {
    const u = withUserGroupValue(withUserValue({ ctx: 6000 }, 'flashAttn', 'off'), 'sampling', 'temp', 0.5)
    expect(u).toEqual({ ctx: 6000, flashAttn: 'off', sampling: { temp: 0.5 } })
  })

  it('shows the user\'s choices over the automatic profile, the groups key by key', () => {
    const p = withUserSet(auto(), { sampling: { temp: 0.3 }, ctx: 2048 })
    expect(p.ctx).toBe(2048)
    expect(p.sampling).toEqual({ ...auto().sampling, temp: 0.3 })
    expect(p.ngl).toBe(99)
  })

  it('marks what it sends', () => {
    expect(userSetPayload({ ctx: 6000 })).toEqual({ ctx: 6000, userSetOnly: true })
    expect(userSetPayload({})).toEqual({ userSetOnly: true })
  })
})
