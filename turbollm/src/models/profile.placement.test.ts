// Free-VRAM placement of a DEFAULT profile (scalability review 4.7, within ADR-060: a default's placement, not per-pool
// config). Pure: the per-card readings are passed in, so no nvidia-smi runs here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveDefault, estimateVram, gpuUserSet, placeOnFreeVram, resolveProfile } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(sizeBytes: number): ModelEntry {
  return {
    key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
    sizeBytes, sizeLabel: '', arch: 'llama', quant: 'Q4_K_M',
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '',
  }
}

function sys(...vramMb: number[]): SysInfo {
  return {
    os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
    gpus: vramMb.map((v, i) => ({ name: `gpu${i}`, vramMb: v, vendor: 'nvidia' as const })),
  }
}

const TWO_24 = sys(24000, 24000)
const place = (m: ModelEntry, s: SysInfo, used: number[]) => placeOnFreeVram(deriveDefault(m, s), m, s, used)

test('cards that are empty keep the default even split (no behaviour change on an idle box)', () => {
  assert.deepEqual(place(model(8e9), TWO_24, [0, 0]), { kind: 'default' })
})

test('two models resident on card 0: the third default model goes to card 1 alone', () => {
  assert.deepEqual(place(model(8e9), TWO_24, [21000, 500]), {
    kind: 'place', gpu: { splitMode: 'none', tensorSplit: [], mainGpu: 1, tensorParallelSize: 1 },
  })
})

test('the card with the most free memory is chosen, not the first that fits', () => {
  const three = sys(24000, 24000, 24000)
  const r = place(model(8e9), three, [10000, 22000, 5000])
  assert.equal(r.kind === 'place' && r.gpu.mainGpu, 2)
})

test('a model too big for any one card is split in proportion to the free memory', () => {
  const m = model(30e9)
  assert.ok(estimateVram(deriveDefault(m, TWO_24), m, TWO_24).estMb > 24000, 'precondition: needs both cards')
  const r = place(m, TWO_24, [8000, 0])
  assert.ok(r.kind === 'place')
  assert.equal(r.gpu.splitMode, 'layer')
  assert.deepEqual(r.gpu.tensorSplit, [16000 - 512, 24000 - 512], 'proportional to free, less the reserve')
})

test('no card (nor all together) has room: nofit, so the caller makes room', () => {
  assert.deepEqual(place(model(8e9), TWO_24, [23000, 23000]), { kind: 'nofit' })
})

test('a single GPU that cannot hold the model reports nofit; one that can keeps the default', () => {
  const one = sys(24000)
  assert.deepEqual(place(model(8e9), one, [20000]), { kind: 'nofit' })
  assert.deepEqual(place(model(8e9), one, [2000]), { kind: 'default' })
})

test('readings that do not line up with the detected GPUs are not trusted', () => {
  assert.deepEqual(place(model(8e9), TWO_24, [23000]), { kind: 'default' })
})

test('a CPU-only default (ngl 0) and a CPU-only box are left alone', () => {
  const m = model(8e9)
  assert.deepEqual(placeOnFreeVram({ ...deriveDefault(m, TWO_24), ngl: 0 }, m, TWO_24, [23000, 23000]), { kind: 'default' })
  assert.deepEqual(place(m, sys(), []), { kind: 'default' })
})

test('gpuUserSet: only a gpu block the user saved or requested counts', () => {
  const m = model(8e9)
  assert.equal(gpuUserSet(m, TWO_24, undefined, undefined), false)
  assert.equal(gpuUserSet(m, TWO_24, { ngl: 10, userSetOnly: true }, undefined), false, 'another field is not the gpu block')
  assert.equal(gpuUserSet(m, TWO_24, { gpu: { splitMode: 'none', tensorSplit: [], mainGpu: 0, tensorParallelSize: 1 }, userSetOnly: true }, undefined), true)
  assert.equal(gpuUserSet(m, TWO_24, undefined, { gpu: { splitMode: 'row', tensorSplit: [], mainGpu: -1, tensorParallelSize: 1 } }), true)
  // An earlier build saved the whole draft: its untouched default gpu block is not the user's.
  assert.equal(gpuUserSet(m, TWO_24, resolveProfile(m, TWO_24), undefined), false)
})
