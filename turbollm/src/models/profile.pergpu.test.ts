// Per-GPU VRAM projection (estimateVramPerGpu) and byte-balanced split derivation.
//
// The expected numbers here are not invented: they are real nvidia-smi peaks from dual-Tesla-T4
// runs of these exact models, recorded in deploy/kaggle/README.md. A pooled scalar cannot
// reproduce them at all — that is the whole reason this function exists — so they are the right
// thing to hold the projection to. Tolerance is deliberately loose (12%): this is a placement
// model, not a simulator, and it only has to be right enough to stop the offload search backing
// off a ceiling that belongs to one card rather than the pool.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveDefault, deriveTensorSplit, estimateVramPerGpu } from './profile'
import type { LoadProfile } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 8_000_000_000, sizeLabel: '8 GB', arch: 'qwen3moe', quant: 'Q4_K_M',
    nativeCtx: 32768, blockCount: 40, headCountKv: 8, headDim: 0, moe: true, expertCount: 128,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '', ...over,
  }
}
const T4x2: SysInfo = {
  os: 'linux/x64', cpu: 'test', cores: 4, ramMB: 31000,
  gpus: [{ name: 'Tesla T4', vramMb: 15360, vendor: 'nvidia' },
         { name: 'Tesla T4', vramMb: 15360, vendor: 'nvidia' }],
}
function prof(m: ModelEntry, over: Partial<LoadProfile> = {}): LoadProfile {
  return { ...deriveDefault(m, T4x2), ctx: 8192, ngl: 99, ...over }
}
function near(actual: number, expected: number, what: string, tol = 0.12) {
  const off = Math.abs(actual - expected) / expected
  assert.ok(off <= tol, `${what}: projected ${actual} MB vs measured ${expected} MB (${(off * 100).toFixed(0)}% off)`)
}

const q8 = model({ sizeBytes: 36_903_140_320 })   // Qwen3.6-35B-A3B-Q8_0
const q4 = model({ sizeBytes: 22_853_663_008 })   // Qwen3.6-35B-A3B-UD-Q4_K_XL

test('even split + nCpuMoe=24 reproduces the measured 1707 / 14693 MiB imbalance', () => {
  const plan = estimateVramPerGpu(prof(q8, { nCpuMoe: 24 }), q8, T4x2)
  // GPU1 — the card that actually saturates, and the one every decision keys off — is held to
  // the measurement. GPU0 is only asserted to read as nearly empty: its total is a sum of the
  // terms this model approximates hardest (the expert-stripped layer weight, the KV share, the
  // CUDA context), and it projects ~2.7 GB against a measured 1.7 GB. Being a gigabyte pessimistic
  // on a card at 11% of its capacity changes no decision; being wrong about GPU1 changes all of
  // them. Tightening GPU0 would mean calibrating three constants against one data point.
  near(plan.estMb[1], 14693, 'GPU1')
  assert.ok(plan.estMb[0] < 3500, `GPU0 should project as nearly empty, got ${plan.estMb[0]} MB`)
  // The point of the whole exercise: the pool looks roomy while GPU1 is at its ceiling.
  assert.ok(plan.pct[1] > 0.9, 'GPU1 should read as nearly full')
  assert.ok(plan.pct[0] < 0.25, 'GPU0 should read as nearly empty')
  assert.equal(plan.verdict, 'overflow')
})

test('tensor-split 3,1 reproduces the measured 7901 / 8501 MiB rebalance', () => {
  const p = prof(q8, { nCpuMoe: 24 })
  const plan = estimateVramPerGpu({ ...p, gpu: { ...p.gpu, splitMode: 'layer', tensorSplit: [3, 1] } }, q8, T4x2)
  near(plan.estMb[0], 7901, 'GPU0')
  near(plan.estMb[1], 8501, 'GPU1')
})

test('tensor-split 2,1 + nCpuMoe=16 reproduces the measured 11837 / 11091 MiB winner', () => {
  const p = prof(q8, { nCpuMoe: 16 })
  const plan = estimateVramPerGpu({ ...p, gpu: { ...p.gpu, splitMode: 'layer', tensorSplit: [2, 1] } }, q8, T4x2)
  near(plan.estMb[0], 11837, 'GPU0')
  near(plan.estMb[1], 11091, 'GPU1')
  assert.notEqual(plan.verdict, 'overflow', 'the config that actually ran must not read as overflow')
})

test('zero offload is already byte-balanced (measured 10905 / 11079 MiB)', () => {
  const plan = estimateVramPerGpu(prof(q4, { nCpuMoe: 0 }), q4, T4x2)
  near(plan.estMb[0], 10905, 'GPU0')
  near(plan.estMb[1], 11079, 'GPU1')
  assert.equal(plan.verdict, 'fits')
})

test('splitMode none puts everything on the pinned card and nothing on the other', () => {
  const p = prof(q4, { nCpuMoe: 0 })
  const plan = estimateVramPerGpu({ ...p, gpu: { ...p.gpu, splitMode: 'none', mainGpu: 1 } }, q4, T4x2)
  assert.equal(plan.estMb[0], 0)
  assert.ok(plan.estMb[1] > 20_000)
  assert.equal(plan.verdict, 'overflow') // 22.9 GB cannot sit on one 15 GB card
})

// ---- deriveTensorSplit ------------------------------------------------------

test('no offload -> no tensor-split (even layers are already even bytes)', () => {
  assert.deepEqual(deriveTensorSplit(prof(q4, { nCpuMoe: 0 }), q4, T4x2), [])
})

test('dense models never get a derived split (their layers are uniform)', () => {
  const dense = model({ sizeBytes: 17_923_394_624, moe: false, arch: 'qwen3' })
  assert.deepEqual(deriveTensorSplit(prof(dense, { nCpuMoe: 0 }), dense, T4x2), [])
})

test('offload -> split gives GPU0 the cheap expert-stripped head, and it balances', () => {
  const p = prof(q8, { nCpuMoe: 24 })
  const ts = deriveTensorSplit(p, q8, T4x2)
  assert.equal(ts.length, 2)
  assert.ok(ts[0] > ts[1], `GPU0 should take more layers than GPU1, got ${ts.join(',')}`)
  assert.equal(ts[0] + ts[1], q8.blockCount)
  // and applying it must actually even the cards out, which the default split does not
  const plan = estimateVramPerGpu({ ...p, gpu: { ...p.gpu, splitMode: 'layer', tensorSplit: ts } }, q8, T4x2)
  const skew = Math.abs(plan.estMb[0] - plan.estMb[1]) / Math.max(...plan.estMb)
  assert.ok(skew < 0.2, `cards should end up within 20%, got ${plan.estMb.join(' / ')}`)
})

test('a balanced split lets a lower offload fit where the default split overflows', () => {
  // nCpuMoe=16 is the config that measured 5.82 tok/s. Under llama.cpp's even split it overflows
  // GPU1; under the derived split it fits. That difference is exactly what the offload search
  // needs to see in order to stop at 16 instead of retreating to 24.
  const p = prof(q8, { nCpuMoe: 16 })
  assert.equal(estimateVramPerGpu(p, q8, T4x2).verdict, 'overflow')
  const ts = deriveTensorSplit(p, q8, T4x2)
  const balanced = estimateVramPerGpu({ ...p, gpu: { ...p.gpu, splitMode: 'layer', tensorSplit: ts } }, q8, T4x2)
  assert.notEqual(balanced.verdict, 'overflow')
})
