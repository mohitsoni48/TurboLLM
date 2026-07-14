// Multi-GPU split-strategy selection for auto-tune (ADR-054). Covers pickSplitStrategies
// (which split modes the sweep tries, in order) and the split-aware overHeadroom budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickSplitStrategies, overHeadroom } from './bench'
import { deriveDefault } from '../models/profile'
import type { LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 8_000_000_000, sizeLabel: '8 GB', arch: 'llama', quant: 'Q4_K_M',
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, hasChatTemplate: true, embedding: false,
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

function base(s: SysInfo, over: Partial<LoadProfile> = {}): LoadProfile {
  return { ...deriveDefault(model(), s), ...over }
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
  // ~60 GB weights: overflows a single 24 GB card no matter the KV quant, but the summed pool is
  // its only hope — so single-GPU is not offered, layer-split is kept.
  const strats = pickSplitStrategies(model({ sizeBytes: 60_000_000_000 }), s, base(s), caps)
  assert.equal(strats.length, 1)
  assert.equal(strats[0].splitMode, 'layer')
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
