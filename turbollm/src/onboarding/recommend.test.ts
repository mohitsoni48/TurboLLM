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

// The RAM guard must DEGRADE, not delete the recommendation. Spec 25 §5.4: "If detected RAM is
// lower, resolve to C-LOW-A." An earlier revision of this suite asserted `hf-search` here and
// described that as proof the guard worked — it was not. It proved the guard fires and then drops
// the user, because the bands are non-overlapping and nothing else can match once C-LOW-B is out.
// 12 GB and 14 GB cards with 16 GB of system RAM (3060 12GB, 4070 12GB — very common builds) got
// no blessed model at all, which is the exact experience this feature exists to remove.
test('RAM guard degrades to C-LOW-A rather than dropping the user (spec 25 §5.4)', () => {
  for (const vram of [12 * 1024, 14 * 1024]) {
    const r = recommend('developer', hw(vram, 16384))
    assert.equal(r.kind === 'entry' && r.entry.id, 'C-LOW-A', `${vram}MB card / 16GB RAM`)
  }
})

test('RAM guard: the same cards with 32 GB system RAM still get C-LOW-B', () => {
  for (const vram of [12 * 1024, 14 * 1024]) {
    const r = recommend('developer', hw(vram, 32768))
    assert.equal(r.kind === 'entry' && r.entry.id, 'C-LOW-B', `${vram}MB card / 32GB RAM`)
  }
})

// The single edge the founder specified explicitly, and the one the tier tables are most likely to
// drift on. Spec 25 §5.4 splits the coder family at "≤ 16 GB → 35B-A3B" / "> 16 GB → 27B", and §7
// states the RAM case outright. Before the fix, exactly 16 GB escaped C-LOW-B's half-open band and
// landed on C-T3 — the DENSE 27B at 15.66 GiB on a 16 GB card, with no RAM guard behind it.
test('boundary: exactly 16 GB is the MoE side of the coder split, not the dense side', () => {
  const withRam = recommend('developer', hw(16 * 1024, 32768))
  assert.equal(withRam.kind === 'entry' && withRam.entry.id, 'C-LOW-B', 'exactly 16GB + 32GB RAM')

  // Spec 25 §7, verbatim: "a 16 GB card with 16 GB system RAM must resolve to C-LOW-A, never
  // C-LOW-B". Both halves of that sentence are asserted here.
  const lowRam = recommend('developer', hw(16 * 1024, 16384))
  assert.equal(lowRam.kind === 'entry' && lowRam.entry.id, 'C-LOW-A', 'exactly 16GB + 16GB RAM')
})

test('boundary: just over 16 GB crosses to the dense 27B', () => {
  const r = recommend('developer', hw(16 * 1024 + 1, 32768))
  assert.equal(r.kind === 'entry' && r.entry.id, 'C-T3')
})

test('pass 2 never hands an oversized model to a card below its minimum', () => {
  // A 2 GB card asking for the coder role: every coder entry needs ≥8 GB, so dropping the UPPER
  // band edge must not make one match. Falling through to HF search is the correct answer here.
  const r = recommend('developer', hw(2048, 16384))
  assert.equal(r.kind, 'hf-search')
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
