import test from 'node:test'
import assert from 'node:assert/strict'
import { recommend, type HardwareFacts } from './recommend'
import { PROFILE_IDS } from './state'

const hw = (usableVramMb: number, systemRamMb = 32768, unifiedMemory = false): HardwareFacts =>
  ({ usableVramMb, systemRamMb, unifiedMemory })

test('pro resolves the Discover handoff at every tier, including T0', () => {
  for (const vram of [0, 4096, 12288, 16384, 24576, 49152]) {
    const r = recommend('pro', hw(vram))
    assert.equal(r.kind, 'discover', `pro at ${vram}MB must hand off, got ${r.kind}`)
  }
})

test('RAM guard: 14 GB card with only 16 GB system RAM falls to hf-search, not C-LOW-B', () => {
  // C-LOW-A max is 12 GB, so it is too small for 14 GB VRAM.
  // C-LOW-B fits VRAM (12–16 GB) but the RAM guard blocks it (needs 32 GB).
  // C-T3 needs ≥16 GB VRAM, so it is too large. No candidate survives → hf-search.
  // This proves the guard works — the same VRAM at 32 GB RAM picks C-LOW-B.
  const rLow = recommend('developer', hw(14336, 16384))
  assert.equal(rLow.kind, 'hf-search')
})

test('RAM guard: same 14 GB card with 32 GB system RAM gets C-LOW-B', () => {
  const rHigh = recommend('developer', hw(14336, 32768))
  assert.equal(rHigh.kind === 'entry' && rHigh.entry.id, 'C-LOW-B')
})

test('T0: CPU-only resolves E4B, by system RAM', () => {
  assert.equal((recommend('casual', hw(0, 16384)) as any).entry.id, 'T0-A')
  assert.equal((recommend('casual', hw(0, 4096)) as any).entry.id, 'T0-B')
})

test('enthusiast takes one quant step up from casual on identical hardware', () => {
  const c = recommend('casual', hw(12288)) as any
  const e = recommend('enthusiast', hw(12288)) as any
  assert.notEqual(c.entry.id, e.entry.id)
  assert.ok(e.entry.bytes > c.entry.bytes, 'enthusiast must get the larger quant')
})

test('every non-pro resolution carries speculative off and a non-MTP file', () => {
  for (const p of PROFILE_IDS.filter((x) => x !== 'pro')) {
    const r = recommend(p, hw(12288)) as any
    assert.equal(r.speculative, 'off')
    assert.ok(!r.entry.file.includes('mmproj'))
  }
})
