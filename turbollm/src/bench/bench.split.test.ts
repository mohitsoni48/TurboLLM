// Multi-GPU split-strategy selection for auto-tune (ADR-054). Covers pickSplitStrategies
// (which split modes the sweep tries, in order) and the split-aware overHeadroom budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withBalancedSplit, pickSplitStrategies, overHeadroom } from './bench'
import { deriveDefault, deriveTensorSplit, estimateVramPerGpu } from '../models/profile'
import type { LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 8_000_000_000, sizeLabel: '8 GB', arch: 'llama', quant: 'Q4_K_M',
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '', ...over,
  }
}

function sys(gpus: number[]): SysInfo {
  return {
    os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
    gpus: gpus.map((vramMb, i) => ({ name: `gpu${i}`, vramMb, vendor: 'nvidia' as const })),
  }
}

// Empty flags = graceful-degrade → all flags allowed (a probed engine that supports split).
const caps = { kvTypes: ['f16', 'q8_0', 'turbo4'], flags: [] as string[] }

function base(s: SysInfo, over: Partial<LoadProfile> = {}, m: ModelEntry = model()): LoadProfile {
  return { ...deriveDefault(m, s), ...over }
}

// ---- pickSplitStrategies ----------------------------------------------------

test('single-GPU box → exactly one strategy (the profile default, unchanged behavior)', () => {
  const s = sys([24000])
  const strats = pickSplitStrategies(model(), s, base(s), caps)
  assert.equal(strats.length, 1)
  assert.equal(strats[0].splitMode, 'layer')
})

test('split-incapable engine → one strategy even on a multi-GPU box', () => {
  const s = sys([24000, 24000])
  const limited = { kvTypes: [], flags: ['-ngl', '--parallel'] } // no --split-mode / --main-gpu
  const strats = pickSplitStrategies(model(), s, base(s), limited)
  assert.equal(strats.length, 1)
  assert.equal(strats[0].splitMode, 'layer')
})

test('multi-GPU, model fits one card → single-GPU FIRST, then layer-split, then row', () => {
  const s = sys([24000, 24000])
  const strats = pickSplitStrategies(model({ sizeBytes: 8_000_000_000 }), s, base(s), caps)
  assert.deepEqual(strats.map((g) => g.splitMode), ['none', 'layer', 'row'])
  assert.equal(strats[0].mainGpu, 0) // single-GPU tried first — the likely winner
})

test('multi-GPU, model too big for one card even at smallest KV → the two split modes, no single-GPU', () => {
  const s = sys([24000, 24000])
  // ~60 GB weights: even fully on CPU (ngl=0) plus KV/overhead this barely clears one 24 GB card,
  // and any real GPU residency overflows it fast — so single-GPU is well under 50% and skipped.
  // Both MULTI-GPU geometries remain: layer (the default) and row (tensor-parallel).
  const strats = pickSplitStrategies(model({ sizeBytes: 60_000_000_000 }), s, base(s), caps)
  assert.deepEqual(strats.map((g) => g.splitMode), ['layer', 'row'])
})

test('row (tensor-parallel) is offered on every multi-GPU box, and always LAST', () => {
  // Auto-tune could not previously express `--split-mode row` at all, so it was structurally
  // incapable of finding the best dual-GPU config — a layer split is a sequential pipeline, and row
  // is the only mode where both cards work the same layer at once. It goes last so that a sweep
  // truncated by the global deadline still returns the layer-split default.
  const s = sys([24000, 24000])
  for (const bytes of [8_000_000_000, 60_000_000_000]) {
    const strats = pickSplitStrategies(model({ sizeBytes: bytes }), s, base(s), caps)
    assert.equal(strats.at(-1)?.splitMode, 'row', `row should be last for ${bytes} bytes`)
    assert.deepEqual(strats.at(-1)?.tensorSplit, [], 'row starts from an even, unpinned split')
  }
})

test('row is NOT offered when the user pinned a single GPU — that is a hardware choice, not a geometry', () => {
  const s = sys([24000, 24000])
  const pinned = base(s, { gpu: { splitMode: 'none', tensorSplit: [], mainGpu: 0, tensorParallelSize: 1 } })
  assert.ok(!pickSplitStrategies(model(), s, pinned, caps).some((g) => g.splitMode === 'row'))
})

test('multi-GPU, model just barely exceeds one card at FULL offload → single-GPU still offered (GitHub #62)', () => {
  // 15 GB weights on a 16 GB card: doesn't fit at ngl=32 (full offload) but easily fits at a
  // partial ngl (CPU covering only the tail) — the search should get a shot at that, instead of
  // being forced straight into a slower cross-GPU layer-split the way GitHub #62 reported (a model
  // that easily fit fully split across two cards, with VRAM to spare, was never tried on one card
  // alone even though the vast majority of it would sit there fine).
  const s = sys([16000, 16000])
  const strats = pickSplitStrategies(model({ sizeBytes: 15_000_000_000, blockCount: 32, nativeCtx: 8192 }), s, base(s, { ctx: 8192 }), caps)
  assert.ok(strats.some((g) => g.splitMode === 'none'), 'single-GPU strategy should be offered')
  assert.equal(strats[0].splitMode, 'none', 'tried first — the likely winner')
})

test('single-GPU is offered thanks to the smallest-KV fit estimate (turbo4), not the base f16', () => {
  const s = sys([16000, 16000])
  // ~13.5 GB weights + a big f16 KV would overflow one 16 GB card, but turbo4 shrinks the KV enough
  // to fit — pickSplitStrategies must estimate with the smallest quality KV so this branch appears.
  const big = model({ sizeBytes: 13_500_000_000, blockCount: 48, headCountKv: 8, nativeCtx: 8192 })
  const strats = pickSplitStrategies(big, s, base(s, { ctx: 8192 }), caps)
  assert.ok(strats.some((g) => g.splitMode === 'none'), 'single-GPU strategy should be offered')
})

test('user already pinned single-GPU → deduped to one strategy', () => {
  const s = sys([24000, 24000])
  const pinned = base(s, { gpu: { splitMode: 'none', tensorSplit: [], mainGpu: 0, tensorParallelSize: 1 } })
  const strats = pickSplitStrategies(model(), s, pinned, caps)
  assert.equal(strats.length, 1)
  assert.equal(strats[0].splitMode, 'none')
})

// ---- overHeadroom: budget-aware (per-GPU for single, summed for split) -------

test('overHeadroom judges against the given budget, not a fixed pool', () => {
  // 14.5 GB used is over one 15.36 GB card's 1 GB-headroom edge…
  assert.equal(overHeadroom(14500, 15360, 1024), true)
  // …but comfortably within the summed 30.72 GB pool of two cards.
  assert.equal(overHeadroom(14500, 30720, 1024), false)
  // Right under a single card's edge → fits.
  assert.equal(overHeadroom(14000, 15360, 1024), false)
})

test('overHeadroom never blocks on unknown VRAM or zero budget', () => {
  assert.equal(overHeadroom(null, 15360, 1024), false)
  assert.equal(overHeadroom(14000, 0, 1024), false)
})

// ---- withBalancedSplit ------------------------------------------------------
// Ground truth: dual Tesla T4 (2x15360 MB) running Qwen3.6-35B-A3B. See deploy/kaggle/README.md.

const MOE40 = { blockCount: 40, moe: true, expertCount: 128, arch: 'qwen3moe' } as Partial<ModelEntry>
const t4x2 = sys([15360, 15360])

test('offload that strands a card gets a byte-balanced tensor-split', () => {
  const m = model({ sizeBytes: 36_903_140_320, ...MOE40 })   // Q8_0, needs offload on 2x16 GB
  const p = { ...base(t4x2, { ctx: 8192, nCpuMoe: 24, ngl: 99 }, m) }
  const out = withBalancedSplit(p, m, t4x2)
  assert.ok(out.gpu.tensorSplit.length === 2, 'a split should be derived')
  assert.ok(out.gpu.tensorSplit[0] > out.gpu.tensorSplit[1], 'the expert-stripped head is cheap, so GPU0 takes more layers')
})

test('no offload → left alone (even layers are already even bytes)', () => {
  const m = model({ sizeBytes: 22_853_663_008, ...MOE40 })   // Q4_K_XL fits both cards at nCpuMoe 0
  const p = base(t4x2, { ctx: 8192, nCpuMoe: 0, ngl: 99 }, m)
  assert.deepEqual(withBalancedSplit(p, m, t4x2).gpu.tensorSplit, [])
})

test('dense model → left alone (uniform layers cannot be imbalanced)', () => {
  const m = model({ sizeBytes: 40_000_000_000, moe: false, blockCount: 40 })
  const p = base(t4x2, { ctx: 8192, ngl: 99 }, m)
  assert.deepEqual(withBalancedSplit(p, m, t4x2).gpu.tensorSplit, [])
})

// Auto-tune owns the split (founder call, 2026-08-22): a pinned tensorSplit caps the offload
// search at whatever placement it encodes, so the sweep discards it and decides for itself.
test("a split the user pinned is replaced by auto-tune's own placement", () => {
  const m = model({ sizeBytes: 36_903_140_320, ...MOE40 })
  const p = base(t4x2, { ctx: 8192, nCpuMoe: 24, ngl: 99 }, m)
  const pinned = { ...p, gpu: { ...p.gpu, tensorSplit: [1, 1] } }
  const out = withBalancedSplit(pinned, m, t4x2).gpu.tensorSplit
  assert.notDeepEqual(out, [1, 1], 'the pinned split must not survive the sweep')
  assert.deepEqual(out, withBalancedSplit(p, m, t4x2).gpu.tensorSplit, 'same result as an unpinned profile')
})

// The override is unconditional, not just "when balancing wins": a pinned split on a profile
// that fits comfortably is still dropped, so the sweep starts from the even baseline.
test('a pinned split is dropped even when nothing overflows', () => {
  const m = model({ sizeBytes: 8_000_000_000, ...MOE40 })
  const p = base(t4x2, { ctx: 8192, nCpuMoe: 4, ngl: 99 }, m)
  const pinned = { ...p, gpu: { ...p.gpu, tensorSplit: [3, 1] } }
  assert.deepEqual(withBalancedSplit(pinned, m, t4x2).gpu.tensorSplit, [])
})

// deriveTensorSplit balances bytes; it does NOT promise the result fits. At nCpuMoe=4 the
// 36.9 GB model needs ~34 GB of a 30.7 GB pool, and the balanced split lands both cards at
// ~110% of their VRAM. withBalancedSplit must decline it rather than hand the search a config
// that cannot load — balancing is only ever worth applying when it actually resolves the overflow.
test('a balanced split that still overflows is declined, not applied', () => {
  const m = model({ sizeBytes: 36_903_140_320, ...MOE40 })
  const p = base(t4x2, { ctx: 8192, nCpuMoe: 4, ngl: 99 }, m)
  const ts = deriveTensorSplit(p, m, t4x2)
  assert.ok(ts.length === 2, 'precondition: a split is derivable')
  const balanced = estimateVramPerGpu({ ...p, gpu: { ...p.gpu, tensorSplit: ts } }, m, t4x2)
  assert.equal(balanced.verdict, 'overflow', 'precondition: balancing does not rescue this offload')
  assert.deepEqual(withBalancedSplit(p, m, t4x2).gpu.tensorSplit, [], 'must be left untouched')
})

test('single-GPU box → left alone', () => {
  const one = sys([15360])
  const m = model({ sizeBytes: 36_903_140_320, ...MOE40 })
  const p = base(one, { ctx: 8192, nCpuMoe: 24, ngl: 99 }, m)
  assert.deepEqual(withBalancedSplit(p, m, one).gpu.tensorSplit, [])
})

// ---- ADR-379: the single-GPU gate judges the KV that will actually run ------------------
// Live failure this fixes, 2x Tesla T4 (2x15360 MB), dense Qwen3.8-27B Q4_0 16.1 GB at
// ctx 188416 with the user's q8_0 KV. The gate used to measure feasibility with the SMALLEST KV
// the engine offers, so it opened a single-GPU branch whose real ceiling was ngl 28/65 = 0.43.
// Bench log: probe ngl=32 oom, then 15/23/27/29/28 ok, then "bench ngl=28 -> TIMEOUT", then it
// finally moved to the layer-split. ~13 minutes and a timeout for a branch that never could work.

const T4x2_REAL = sys([15360, 15360])
const DENSE_27B = { sizeBytes: 16_056_478_688, moe: false, blockCount: 65, arch: 'qwen3' } as Partial<ModelEntry>

test('ADR-379: a dense model that needs both cards is NOT offered single-GPU', () => {
  const m = model(DENSE_27B)
  const p = base(T4x2_REAL, { ctx: 188416, ngl: 99, kvTypeK: 'q8_0', kvTypeV: 'q8_0' }, m)
  const strats = pickSplitStrategies(m, T4x2_REAL, p, caps)
  assert.ok(!strats.some((g) => g.splitMode === 'none'), 'single-GPU must not be offered')
  // Only the multi-GPU geometries remain, layer (the default) first.
  assert.deepEqual(strats.map((g) => g.splitMode), ['layer', 'row'])
})

test('ADR-379: the verdict is not changed by a smaller KV the run will never use', () => {
  // The old gate swapped in turbo4 here and flipped the answer. The engine still OFFERS turbo4 --
  // caps is unchanged -- so this pins that offering it is no longer enough to open the branch.
  const m = model(DENSE_27B)
  const p = base(T4x2_REAL, { ctx: 188416, ngl: 99, kvTypeK: 'q8_0', kvTypeV: 'q8_0' }, m)
  assert.ok(caps.kvTypes.includes('turbo4'), 'precondition: a smaller KV type is available')
  assert.ok(!pickSplitStrategies(m, T4x2_REAL, p, caps).some((g) => g.splitMode === 'none'))
})

test('ADR-379: a dense model that comfortably fits one card still gets single-GPU (GitHub #62)', () => {
  const m = model({ sizeBytes: 8_000_000_000, moe: false, blockCount: 32, arch: 'qwen3' })
  const p = base(T4x2_REAL, { ctx: 4096, ngl: 99 }, m)
  const strats = pickSplitStrategies(m, T4x2_REAL, p, caps)
  assert.equal(strats[0].splitMode, 'none', 'tried first -- the likely winner')
})

test('ADR-379: GitHub #62 still gets its shot after ADR-384 raised the DENSE bar', () => {
  // Originally guarded the flat 0.5 bar. ADR-384 raised the bar for DENSE models only, so what
  // this now pins is that #62 clears the higher one too — it computes 0.875 (4 of 32 blocks on
  // CPU), nowhere near the 0.5–0.6 band ADR-384 closes. Note ADR-379 estimated this case at
  // ~0.72; the fixture actually computes 0.875. The KV type (ADR-379) still separates #62 from
  // the 0.43 case; the bar is what separates it from the half-on-CPU case.
  const m = model({ sizeBytes: 15_000_000_000, blockCount: 32, nativeCtx: 8192 })
  const s16 = sys([16000, 16000])
  const strats = pickSplitStrategies(m, s16, base(s16, { ctx: 8192 }, m), caps)
  assert.equal(strats[0].splitMode, 'none')
})

// ---- ADR-384: a dense model may not be tried single-GPU with half its layers on CPU --------
// Ground truth pulled live off the Kaggle 2x T4 box: Qwen3.8-27B UD-Q4_K_XL, dense, 65 blocks,
// 17,923,394,624 bytes, headCountKv 4, headDim 256, nativeCtx 262144.
//
// ADR-379 fixed the KV type the gate judges with, which correctly closed the deep end (ctx 188k+
// computes 0.000). It left a band open in the middle: at ctx 32768/q8_0 the gate computes 0.523,
// clears the flat 0.5 bar, and opens a single-GPU branch that parks 31 of 65 DENSE layers on the
// CPU. Every one of those layers is touched on every token, so it cannot beat a layer-split that
// holds the whole model — it just costs a bench slot (up to the 10-minute timeout) to prove it.
// This is the band ADR-381 saw as "the branch that actually burns budget is single-GPU".

const QWEN38_REAL = {
  sizeBytes: 17_923_394_624, arch: 'qwen35', quant: 'Q4_K_XL', nativeCtx: 262144,
  blockCount: 65, headCountKv: 4, headDim: 256, moe: false, nextnLayers: 1,
} as Partial<ModelEntry>

test('ADR-384: a dense model with ~half its layers on CPU is NOT offered single-GPU', () => {
  const m = model(QWEN38_REAL)
  const p = base(T4x2_REAL, { ctx: 32768, ngl: 99, kvTypeK: 'q8_0', kvTypeV: 'q8_0' }, m)
  const strats = pickSplitStrategies(m, T4x2_REAL, p, caps)
  assert.ok(!strats.some((g) => g.splitMode === 'none'), 'single-GPU must not be offered at 0.523')
})

test('ADR-384: the same model at a shallower ctx keeps its single-GPU shot', () => {
  // ctx 8192 computes 0.708 — only 19 of 65 blocks on CPU. This is the shape GitHub #62 is about,
  // and it must survive the higher bar, so the fix cannot just be "skip whenever it needs CPU".
  const m = model(QWEN38_REAL)
  const p = base(T4x2_REAL, { ctx: 8192, ngl: 99, kvTypeK: 'q8_0', kvTypeV: 'q8_0' }, m)
  assert.equal(pickSplitStrategies(m, T4x2_REAL, p, caps)[0].splitMode, 'none')
})

test('ADR-384: MoE is untouched — partial residency is cheap when experts are idle', () => {
  // 20 GB MoE at ctx 8192 computes 0.550 — inside the band the dense bar now rejects. It must
  // still be offered: an offloaded expert is only read when the router picks it, so half a MoE
  // on CPU is nothing like half a dense model on CPU. The bar is dense-only for that reason.
  const m = model({ sizeBytes: 20_000_000_000, blockCount: 40, moe: true, expertCount: 128, arch: 'qwen3moe' })
  const p = base(T4x2_REAL, { ctx: 8192, ngl: 99 }, m)
  assert.ok(
    pickSplitStrategies(m, T4x2_REAL, p, caps).some((g) => g.splitMode === 'none'),
    'MoE single-GPU must still be offered inside the 0.5–0.6 band',
  )
})
