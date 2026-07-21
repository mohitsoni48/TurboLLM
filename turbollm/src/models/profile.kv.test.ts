// KV-cache sizing (ADR-216 addendum 2, ADR-223). The expected element counts below are
// GROUND TRUTH derived from metadata dumped out of real GGUF files on the dev box — not
// from re-running the implementation — so these tests fail if the math drifts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateVram, deriveDefault, kvCacheElems, ssmStateElems } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

const CTX = 32768

const base: ModelEntry = {
  key: 'k', name: 'n', path: 'x.gguf', dir: '.', format: 'gguf',
  sizeBytes: 1e9, sizeLabel: '', arch: 'llama', quant: 'Q4_K_M', nativeCtx: 262144,
  blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0, nextnLayers: 0,
  vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
  embedding: false, incomplete: false, parseError: null, loaded: false, hasProfile: false,
  benchTps: null, mtime: '',
}

/** Repeat one period of a per-layer pattern out to `n` layers, the way the GGUF's own
 *  per-layer arrays are laid out. */
const cycle = <T>(period: T[], n: number): T[] =>
  Array.from({ length: n }, (_, i) => period[i % period.length])

// ── The four real models, exactly as their GGUF headers declare them ────────────────

// arch qwen35 (yes, even for a 3.6 model); 64 blocks / interval 4 = 16 full-attn layers.
const qwen36_27b: ModelEntry = {
  ...base, name: 'Qwen3.6-27B', arch: 'qwen35',
  blockCount: 64, headCountKv: 4, headDim: 256, fullAttentionInterval: 4,
  ssmInnerSize: 6144, ssmStateSize: 128, ssmConvKernel: 4,
}

const qwen35_9b: ModelEntry = {
  ...base, name: 'Qwen3.5-9B', arch: 'qwen35',
  blockCount: 32, headCountKv: 4, headDim: 256, fullAttentionInterval: 4,
  ssmInnerSize: 4096, ssmStateSize: 128, ssmConvKernel: 4,
}

// Gemma 4 declares head_count_kv as a per-layer ARRAY (8 on sliding, 2 on global) and a
// separate, smaller head dim for the sliding layers. 30 blocks = 25 sliding + 5 global.
const gemma4_26b: ModelEntry = {
  ...base, name: 'Gemma-4-26B-A4B', arch: 'gemma4', moe: true, expertCount: 8,
  blockCount: 30, headCountKv: 8, headDim: 512, headDimSwa: 256, slidingWindow: 1024,
  slidingWindowPattern: cycle([true, true, true, true, true, false], 30),
  headCountKvPerLayer: cycle([8, 8, 8, 8, 8, 2], 30),
}

// Same family, scalar head count: 42 blocks = 35 sliding + 7 global.
const gemma4_e4b: ModelEntry = {
  ...base, name: 'Gemma-4-E4B', arch: 'gemma4',
  blockCount: 42, headCountKv: 2, headDim: 512, headDimSwa: 256, slidingWindow: 512,
  slidingWindowPattern: cycle([true, true, true, true, true, false], 42),
}

// Hybrid EVIDENCE (ssm.* present) but the layer layout is UNDECLARED — no
// full_attention_interval key exists in this GGUF.
const qwen3next_undeclared: ModelEntry = {
  ...base, name: 'Qwen3-Coder-Next', arch: 'qwen3next',
  blockCount: 48, headCountKv: 2, headDim: 256,
  ssmInnerSize: 4096, ssmStateSize: 128, ssmConvKernel: 4,
}

// A plain dense model declaring none of the layout keys — the common case.
const dense: ModelEntry = { ...base, blockCount: 32, headCountKv: 8, headDim: 128 }

const legacyElems = (m: ModelEntry, ctx: number) =>
  2 * (m.blockCount || 1) * ctx * (m.headCountKv || 8) * (m.headDim || 128)

// ── Ground truth ────────────────────────────────────────────────────────────────────

test('kvCacheElems: Qwen3.6-27B counts only its 16 full-attention layers', () => {
  assert.equal(kvCacheElems(qwen36_27b, CTX), 1_073_741_824)
  // The bug this fixes: the all-layer formula over-counts this model exactly 4x.
  assert.equal(legacyElems(qwen36_27b, CTX), 1_073_741_824 * 4)
})

test('kvCacheElems: Qwen3.5-9B counts only its 8 full-attention layers', () => {
  assert.equal(kvCacheElems(qwen35_9b, CTX), 536_870_912)
})

test('kvCacheElems: Gemma-4-26B-A4B sizes sliding and global layers separately', () => {
  // 5 global (2 heads × dim 512 × full ctx) + 25 sliding (8 heads × dim 256 × 1024 tok).
  assert.equal(kvCacheElems(gemma4_26b, CTX), 440_401_920)
  // ~18x smaller than the all-layer formula — the worst over-count measured.
  assert.ok(legacyElems(gemma4_26b, CTX) / kvCacheElems(gemma4_26b, CTX) > 17)
})

test('kvCacheElems: Gemma-4-E4B (scalar KV heads) sizes 35 sliding + 7 global layers', () => {
  assert.equal(kvCacheElems(gemma4_e4b, CTX), 488_112_128)
})

// ── Safe degradation ────────────────────────────────────────────────────────────────

test('kvCacheElems: a plain dense model is bit-for-bit the old formula', () => {
  for (const ctx of [512, 8192, CTX, 131072]) {
    assert.equal(kvCacheElems(dense, ctx), legacyElems(dense, ctx))
  }
})

test('kvCacheElems: undeclared head dim / head count keep the old fallback constants', () => {
  const bare: ModelEntry = { ...base, blockCount: 40, headCountKv: 0, headDim: 0 }
  assert.equal(kvCacheElems(bare, CTX), 2 * 40 * CTX * 8 * 128)
})

test('kvCacheElems: hybrid evidence WITHOUT a declared interval keeps the legacy estimate', () => {
  // Qwen3-Coder-Next really is hybrid, but nothing in the file says which layers are
  // full-attention. Guessing an interval would under-count; over-counting is the safe
  // failure, so it must land on the legacy number exactly.
  assert.equal(kvCacheElems(qwen3next_undeclared, CTX), legacyElems(qwen3next_undeclared, CTX))
  // …and it must not pick up a phantom recurrent-state term either.
  assert.equal(ssmStateElems(qwen3next_undeclared), 0)
})

test('kvCacheElems: a per-layer array that does not cover every layer is ignored', () => {
  // A truncated array must degrade to the scalar, never be read past its end.
  const short: ModelEntry = { ...gemma4_e4b, slidingWindowPattern: [true, false] }
  assert.equal(kvCacheElems(short, CTX), legacyElems(short, CTX))
  const shortHeads: ModelEntry = { ...qwen36_27b, headCountKvPerLayer: [1, 1] }
  assert.equal(kvCacheElems(shortHeads, CTX), 1_073_741_824)
})

test('kvCacheElems: a sliding pattern with no declared window is not actionable', () => {
  const noWindow: ModelEntry = { ...gemma4_e4b, slidingWindow: 0 }
  assert.equal(kvCacheElems(noWindow, CTX), legacyElems(noWindow, CTX))
})

// ── Scaling behaviour ───────────────────────────────────────────────────────────────

test('kvCacheElems: sliding layers stop growing past the window; only globals scale', () => {
  const small = kvCacheElems(gemma4_26b, 8192)
  const large = kvCacheElems(gemma4_26b, 131072)
  const slidingTerm = 2 * 25 * 1024 * 8 * 256 // capped at the 1024-token window in both
  assert.equal(small - slidingTerm, 2 * 5 * 8192 * 2 * 512)
  assert.equal(large - slidingTerm, 2 * 5 * 131072 * 2 * 512)
  // i.e. the two contexts differ ONLY in the global-layer term.
  assert.equal(large - small, 2 * 5 * (131072 - 8192) * 2 * 512)
})

test('kvCacheElems: below the window, sliding layers are just ctx-sized', () => {
  const ctx = 256 // < Gemma-4-E4B's 512-token window, so min(ctx, window) === ctx
  const globals = 2 * 7 * ctx * 2 * 512
  const sliding = 2 * 35 * ctx * 2 * 256 // still the SWA head dim, just uncapped
  assert.equal(kvCacheElems(gemma4_e4b, ctx), globals + sliding)
})

// ── Constant recurrent state ────────────────────────────────────────────────────────

test('ssmStateElems: Qwen3.6-27B holds ~77 MB of constant state, independent of ctx', () => {
  // 48 linear layers × inner 6144 × (state 128 + conv 4 - 1).
  assert.equal(ssmStateElems(qwen36_27b), 48 * 6144 * 131)
  assert.equal(ssmStateElems(qwen36_27b), 38_633_472)
  const mb = (ssmStateElems(qwen36_27b) * 2) / 1e6
  assert.ok(mb > 70 && mb < 85, `expected ~77 MB at f16, got ${mb}`)
})

test('ssmStateElems: zero for every model without SSM metadata', () => {
  assert.equal(ssmStateElems(dense), 0)
  assert.equal(ssmStateElems(gemma4_26b), 0)
})

// ── End-to-end through estimateVram ─────────────────────────────────────────────────

const sys: SysInfo = {
  os: 'win32/x64', cpu: 'Test CPU', cores: 16, ramMB: 65536,
  gpus: [{ name: 'Test GPU', vramMb: 16000, vendor: 'nvidia' }],
}

test('estimateVram: the dense path is unchanged end-to-end', () => {
  const p = { ...deriveDefault(dense, sys), ctx: CTX, ngl: 99 }
  const weightsMb = dense.sizeBytes / 1e6
  const kvMb = (legacyElems(dense, CTX) * 2) / 1e6
  assert.equal(estimateVram(p, dense, sys).estMb, Math.round(weightsMb + kvMb + 800))
})

test('estimateVram: Qwen3.6-27B no longer reads as an overflow at 32k', () => {
  const p = { ...deriveDefault(qwen36_27b, sys), ctx: CTX, ngl: 99 }
  const fit = estimateVram(p, qwen36_27b, sys)
  // 1 GB of weights + ~2.15 GB KV + ~155 MB SSM state + 800 MB ≈ 4.1 GB of 16 GB.
  assert.equal(fit.verdict, 'fits')
  const kvMb = (1_073_741_824 * 2) / 1e6
  // f32 (4 bytes): llama.cpp keeps recurrent state unquantized, and over-counting is the safe
  // direction for a number that also gates auto-tune's headroom.
  const ssmMb = (38_633_472 * 4) / 1e6
  assert.equal(fit.estMb, Math.round(1000 + kvMb + ssmMb + 800))
})

test('estimateVram: --no-kv-offload still zeroes the KV term, recurrent state included', () => {
  const p = { ...deriveDefault(qwen36_27b, sys), ctx: CTX, ngl: 99, kvOffload: false }
  assert.equal(estimateVram(p, qwen36_27b, sys).estMb, Math.round(1000 + 800))
})

test('kvCacheElems: an interval that no layer can satisfy must NOT zero the KV cache', () => {
  // Regression: `hybrid` used to be gated on `interval > 1` alone. When the stride
  // exceeds the block count, NO layer satisfies (i+1) % interval === 0, so the loop
  // counted zero layers and reported a KV cache of ZERO — an unbounded under-count that
  // flips a real `overflow` verdict to `fits`. The dangerous part is that it needs no
  // malformed interval to trigger: `blocks` falls back to 1 when block_count is missing,
  // and 1 is below every real interval.
  for (const [blocks, interval] of [[32, 999], [64, 65], [1, 4], [0, 4], [2, 4]]) {
    const m: ModelEntry = { ...base, blockCount: blocks, headCountKv: 4, headDim: 256, fullAttentionInterval: interval }
    assert.equal(kvCacheElems(m, CTX), legacyElems(m, CTX), `blocks=${blocks} interval=${interval}`)
    assert.ok(kvCacheElems(m, CTX) > 0, `blocks=${blocks} interval=${interval} produced a zero KV cache`)
  }
  // interval === blocks is legitimate: exactly one full-attention layer (the last).
  const edge: ModelEntry = { ...base, blockCount: 64, headCountKv: 4, headDim: 256, fullAttentionInterval: 64 }
  assert.equal(kvCacheElems(edge, CTX), 2 * 1 * CTX * 4 * 256)
})

test('ssmStateElems: a rejected interval yields no recurrent-state term either', () => {
  // The KV term and the SSM term must agree on whether a layout is usable, or a model
  // can end up with a recurrent-state charge for layers the KV math counted as full.
  const m: ModelEntry = {
    ...base, blockCount: 1, headCountKv: 4, headDim: 256, fullAttentionInterval: 4,
    ssmInnerSize: 6144, ssmStateSize: 128, ssmConvKernel: 4,
  }
  assert.equal(ssmStateElems(m), 0)
  assert.equal(kvCacheElems(m, CTX), legacyElems(m, CTX))
})
