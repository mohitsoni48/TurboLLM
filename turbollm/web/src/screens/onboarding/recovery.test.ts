import { describe, it, expect } from 'vitest'
import { recoveryFor, recoveryForUnexpectedModel, LOAD_FAILURES, PROVISION_FAILURES } from './recovery'

describe('recovery map', () => {
  it('gives every load failure at least one action — no dead ends', () => {
    for (const f of LOAD_FAILURES) {
      expect(recoveryFor(f).length, `${f} has no recovery`).toBeGreaterThan(0)
    }
  })

  it('gives every provision failure at least one action — no dead ends', () => {
    for (const f of PROVISION_FAILURES) {
      expect(recoveryFor(f).length, `${f} has no recovery`).toBeGreaterThan(0)
    }
  })

  it('every failure has exactly one primary action', () => {
    for (const f of [...LOAD_FAILURES, ...PROVISION_FAILURES]) {
      expect(recoveryFor(f).filter((a) => a.primary).length, `${f}`).toBe(1)
    }
  })

  it('oom leads with a lower-quant retry — the highest-volume case', () => {
    const primary = recoveryFor('oom').find((a) => a.primary)
    expect(primary?.id).toBe('lower-quant-retry')
  })

  it('cancelled is treated as a choice, offering resume rather than a fix', () => {
    expect(recoveryFor('cancelled').find((a) => a.primary)?.id).toBe('resume')
  })

  // A model loads only on the engine the user selected, and nothing may suggest another one. unsupported_arch led with
  // "Try an engine that supports it", which opened Engines to pick one.
  it('unsupported_arch leads with a different model and suggests no other engine', () => {
    const actions = recoveryFor('unsupported_arch')
    expect(actions.find((a) => a.primary)?.label).toBe('Choose a different model')
    expect(actions.map((a) => a.id)).not.toContain('alt-engine')
    expect(actions.map((a) => a.label)).toEqual(['Choose a different model', 'Check for an engine update'])
  })

  // A model the engine is not expected to run fails with that engine's error, whatever it classifies as: a .litertlm
  // file on llama.cpp reads as a bad GGUF, but the file is fine and re-downloading it changes nothing.
  it('a model the engine is not expected to load gets no engine advice and no re-download', () => {
    const actions = recoveryForUnexpectedModel()
    expect(actions.map((a) => a.label)).toEqual(['Choose a different model', 'Retry'])
    expect(actions.filter((a) => a.primary)).toHaveLength(1)
  })
})
