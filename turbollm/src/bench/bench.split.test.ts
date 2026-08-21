// Multi-GPU split-strategy selection for auto-tune (ADR-054). Covers pickSplitStrategies
// (which split modes the sweep tries, in order) and the split-aware overHeadroom budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withBalancedSplit, pickSplitStrategies, overHeadroom } from './bench'
import { deriveDefault } from '../models/profile'
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

test('multi-GPU, model fits one card → single-GPU FIRST, then layer-split', () => {
  const s = sys([24000, 24000])
  const strats = pickSplitStrategies(model({ sizeBytes: 8_000_000_000 }), s, base(s), caps)
  assert.equal(strats.length, 2)
  assert.equal(strats[0].splitMode, 'none') // tried first — the likely winner
  assert.equal(strats[0].mainGpu, 0)
  assert.equal(strats[1].splitMode, 'layer')
})

test('multi-GPU, model too big for one card even at smallest KV → layer-split only', () => {
  const s = sys([24000, 24000])
  // ~60 GB weights: even fully on CPU (ngl=0) plus KV/overhead this barely clears one 24 GB card,
  // and any real GPU residency overflows it fast — so single-GPU is well under 50% and skipped.
  const strats = pickSplitStrategies(model({ sizeBytes: 60_000_000_000 }), s, base(s), caps)
  assert.equal(strats.length, 1)
  assert.equal(strats[0].splitMode, 'layer')
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

test('a split the user pinned is never overwritten', () => {
  const m = model({ sizeBytes: 36_903_140_320, ...MOE40 })
  const p = base(t4x2, { ctx: 8192, nCpuMoe: 24, ngl: 99 }, m)
  const pinned = { ...p, gpu: { ...p.gpu, tensorSplit: [1, 1] } }
  assert.deepEqual(withBalancedSplit(pinned, m, t4x2).gpu.tensorSplit, [1, 1])
})

test('single-GPU box → left alone', () => {
  const one = sys([15360])
  const m = model({ sizeBytes: 36_903_140_320, ...MOE40 })
  const p = base(one, { ctx: 8192, nCpuMoe: 24, ngl: 99 }, m)
  assert.deepEqual(withBalancedSplit(p, m, one).gpu.tensorSplit, [])
})
