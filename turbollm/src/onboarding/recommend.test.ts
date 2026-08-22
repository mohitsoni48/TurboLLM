import test from 'node:test'
import assert from 'node:assert/strict'
import { recommend, type HardwareFacts } from './recommend'
import { PROFILE_IDS, type ProfileId } from './state'

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

// ── The joint-pool constraint: ONE PHYSICAL POOL MUST BE SPENT ONCE (GitHub #164) ─────────────
//
// On an iGPU-only box, sysinfo.ts hands the iGPU 50% of system RAM (ADR-189's shared-memory
// heuristic, kept deliberately) and tags it `unified: true`. `usableVramMb` and `systemRamMb` are
// then the SAME physical bytes. `fits()` used to check the VRAM floor and the RAM floor
// independently — correct for a discrete card, a double-spend here — so an impossible box got a
// GREENER verdict than a real 16 GB card. The fix does NOT remove the unified budget (that would
// revert ADR-189 and re-open the raised APU budget of GitHub #85); it only adds the missing joint
// requirement.

/** The #164 box, verbatim: a single AMD iGPU, `unified: true`, on 33.5 GB of system RAM. The
 *  32.768 GB variant is the one that lands inside C-LOW-B's VRAM band, where the double-spend is
 *  actually reachable through `recommend()`. */
const igpuOnly164: HardwareFacts = { usableVramMb: 16750, systemRamMb: 33500, unifiedMemory: true }

test('#164: a unified box is never handed an entry whose VRAM floor + RAM floor exceed its one pool', () => {
  const boxes: HardwareFacts[] = [
    igpuOnly164,
    { usableVramMb: 16384, systemRamMb: 32768, unifiedMemory: true }, // 32 GB iGPU-only laptop
    { usableVramMb: 12288, systemRamMb: 24576, unifiedMemory: true }, // 24 GB iGPU-only laptop
    { usableVramMb: 8192, systemRamMb: 16384, unifiedMemory: true }, // 16 GB iGPU-only laptop
  ]
  for (const hwFacts of boxes) {
    for (const p of PROFILE_IDS) {
      const r = recommend(p, hwFacts) as any
      if (r.kind !== 'entry') continue
      const demand = (r.entry.minVramMb ?? 0) + (r.entry.minSystemRamMb ?? 0)
      assert.ok(
        demand <= hwFacts.systemRamMb,
        `${p} on ${hwFacts.usableVramMb}MB unified / ${hwFacts.systemRamMb}MB RAM got ${r.entry.id}, ` +
          `which demands ${demand}MB from a single ${hwFacts.systemRamMb}MB pool`,
      )
    }
  }
})

// The one band where the double-spend is reachable end-to-end, asserted BOTH ways on identical
// numbers. C-LOW-B wants 12 GB of VRAM AND 32 GB of system RAM: two pools on a discrete box
// (satisfiable), one pool on an iGPU-only box (45 GB of demand against 32 GB of memory).
test('#164: C-LOW-B is rejected on a unified 32 GB box and still accepted on a discrete one', () => {
  const unified = recommend('developer', { usableVramMb: 16384, systemRamMb: 32768, unifiedMemory: true }) as any
  const discrete = recommend('developer', { usableVramMb: 16384, systemRamMb: 32768, unifiedMemory: false }) as any

  assert.equal(discrete.kind, 'entry')
  assert.equal(discrete.entry.id, 'C-LOW-B', 'a real 16 GB card with 32 GB of RAM is physically fine — do not regress this')

  assert.equal(unified.kind, 'entry', 'the constraint must DEGRADE, not drop the user into hf-search')
  assert.notEqual(unified.entry.id, 'C-LOW-B', '12 GB VRAM + 32 GB RAM cannot come out of one 32 GB pool')
  assert.equal(unified.entry.id, 'C-LOW-A', 'degrade to the largest sibling that fits the single pool')
})

// The pass-2 hole. The RAM-guard fallback deliberately drops the upper band edge and re-matches;
// with the constraint in `fits()` alone it re-admitted the very entry pass 1 had just rejected,
// because on this box no other coder band matches at all. Guarding only `fits()` is not a fix.
test('#164: the pass-2 RAM-guard fallback cannot re-admit a joint-pool violation', () => {
  const r = recommend('developer', { usableVramMb: 16384, systemRamMb: 32768, unifiedMemory: true }) as any
  assert.equal(r.kind, 'entry')
  assert.notEqual(r.entry.id, 'C-LOW-B', 'pass 2 must apply the joint constraint too')
})

// ── The boundary that matters most: genuinely-unified AND genuinely-usable memory ─────────────
//
// Apple Silicon and Strix Halo (GitHub #85) are unified, but their pool is large enough that every
// entry's two floors fit inside it — so the constraint must be a NO-OP there. If any of these
// change, the fix has over-reached and is regressing #85 / Apple, which is the failure mode the
// ADRs explicitly warn against.
test('#164 regression: unified memory changes nothing when the single pool is genuinely big enough', () => {
  const cases: Array<[string, number, number]> = [
    ['Apple M3 Max 36 GB', 27648, 36864],
    ['Apple M-series 32 GB', 24576, 32768],
    ['Apple M-series 16 GB', 12288, 16384],
    ['Strix Halo 128 GB (GitHub #85)', 117037, 131072],
    ['Strix Halo 64 GB', 55296, 65536],
  ]
  for (const [label, vram, ram] of cases) {
    for (const p of PROFILE_IDS) {
      const unified = recommend(p, { usableVramMb: vram, systemRamMb: ram, unifiedMemory: true }) as any
      const discrete = recommend(p, { usableVramMb: vram, systemRamMb: ram, unifiedMemory: false }) as any
      assert.equal(unified.kind, discrete.kind, `${label} / ${p}: kind changed`)
      assert.equal(
        unified.kind === 'entry' ? unified.entry.id : null,
        discrete.kind === 'entry' ? discrete.entry.id : null,
        `${label} / ${p}: the unified flag must not change the recommendation here`,
      )
    }
  }
})

test('#164 regression: Strix Halo still resolves the top tier of its role, not a downgrade', () => {
  const halo: HardwareFacts = { usableVramMb: 117037, systemRamMb: 131072, unifiedMemory: true }
  assert.equal((recommend('developer', halo) as any).entry.id, 'C-T4')
  assert.equal((recommend('casual', halo) as any).entry.id, 'G-T4')
})

// No discrete-GPU box may move at all: `jointMemoryOk` short-circuits on `unifiedMemory === false`.
test('#164 regression: every discrete-GPU resolution is byte-identical to before the fix', () => {
  const expected: Array<[ProfileId, number, number, string]> = [
    ['casual', 6144, 16384, 'G-T1'],
    ['casual', 12288, 32768, 'G-T2'],
    ['casual', 16384, 32768, 'G-T3'],
    ['casual', 24576, 65536, 'G-T4'],
    ['developer', 8192, 32768, 'C-LOW-A'],
    ['developer', 12288, 32768, 'C-LOW-B'],
    ['developer', 12288, 16384, 'C-LOW-A'],
    ['developer', 20480, 32768, 'C-T3'],
    ['developer', 24576, 65536, 'C-T4'],
    ['casual', 0, 16384, 'T0-A'],
    ['casual', 0, 4096, 'T0-B'],
  ]
  for (const [p, vram, ram, id] of expected) {
    const r = recommend(p, { usableVramMb: vram, systemRamMb: ram, unifiedMemory: false }) as any
    assert.equal(r.entry.id, id, `${p} / ${vram}MB VRAM / ${ram}MB RAM`)
  }
})
