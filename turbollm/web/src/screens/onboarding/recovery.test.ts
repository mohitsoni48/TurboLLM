import { describe, it, expect } from 'vitest'
import { recoveryFor, LOAD_FAILURES, PROVISION_FAILURES } from './recovery'

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
})
