// The load dialog's live VRAM bar (vram.ts `estimateVram`) must agree with the daemon's own
// estimate (src/models/profile.ts `estimateVram`, sent as `vramFit` by GET /api/v1/models/:key).
// The web copy had drifted to the pre-ADR-223 formula — every layer at full ctx, headDim fixed at
// 128, no SSM state, a flat 600 MB mmproj — and showed e.g. a Gemma-3-27B that the daemon calls
// "tight" (88%) as "overflow" (141%).
//
// The web bundle cannot import daemon code (separate packages/builds; see single-file-model.test.ts),
// so the expected numbers below are the DAEMON's: produced by running profile.ts's estimateVram on
// these exact fixtures (sys = one GPU of `vramMb`). If profile.ts's estimator changes, port the
// change into vram.ts and regenerate these numbers from the daemon function.
import { describe, expect, it } from 'vitest'
import { estimateVram } from './vram'
import type { LoadProfile, ModelEntry } from './types'

const base = {
  key: 'k', name: 'n', path: '/m.gguf', dir: '/', format: 'gguf', sizeLabel: '', arch: 'x', quant: 'Q4_K_M',
  nativeCtx: 131072, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false, mmprojPath: null,
  mmprojSizeBytes: 0, hasChatTemplate: true, incomplete: false, parseError: null,
}
const model = (o: object) => ({ ...base, ...o }) as unknown as ModelEntry
const profile = (o: object) => ({
  ctx: 32768, ngl: 999, nCpuMoe: 0, kvTypeK: 'f16', kvTypeV: 'f16', kvOffload: true, kvUnified: true, parallel: 1,
  useMmproj: true, mmprojGpu: true, gpu: { splitMode: 'layer', mainGpu: -1 }, ...o,
}) as unknown as LoadProfile
/** Gemma's 5 sliding : 1 global layout (true = sliding). */
const swa = (blocks: number) => Array.from({ length: blocks }, (_, i) => (i + 1) % 6 !== 0)
const hybrid = { sizeBytes: 16.8e9, blockCount: 64, headCountKv: 4, headDim: 256, fullAttentionInterval: 4, ssmInnerSize: 6144, ssmStateSize: 128, ssmConvKernel: 4 }

const cases: Array<[name: string, m: ModelEntry, p: LoadProfile, vramMb: number, daemon: { estMb: number; verdict: string }]> = [
  ['Gemma-3-27B: sliding window + real mmproj size',
    model({ sizeBytes: 16.5e9, blockCount: 62, headCountKv: 16, headDim: 128, slidingWindow: 1024, slidingWindowPattern: swa(62), vision: true, mmprojPath: '/mmproj.gguf', mmprojSizeBytes: 858e6 }),
    profile({}), 24564, { estMb: 21625, verdict: 'tight' }],
  ['Qwen3.6-27B-like hybrid: every 4th layer full attention + SSM state, parallel 2 non-unified',
    model(hybrid), profile({ ctx: 65536, kvTypeK: 'q8_0', kvTypeV: 'q8_0', kvUnified: false, parallel: 2 }), 24564, { estMb: 22204, verdict: 'tight' }],
  ['Gemma-4-like MoE: per-layer KV heads + a separate sliding head dim',
    model({ sizeBytes: 15.6e9, moe: true, expertCount: 128, blockCount: 30, headCountKv: 8, headDim: 512, headDimSwa: 256, slidingWindow: 1024, slidingWindowPattern: swa(30), headCountKvPerLayer: swa(30).map((s) => (s ? 8 : 2)) }),
    profile({ ctx: 131072, nCpuMoe: 10 }), 16303, { estMb: 14979, verdict: 'tight' }],
  ['dense model with a real headDim of 64 and an asymmetric KV quant',
    model({ sizeBytes: 2.0e9, blockCount: 28, headCountKv: 8, headDim: 64 }),
    profile({ kvTypeK: 'q8_0', kvTypeV: 'q4_0', ngl: 20 }), 8192, { estMb: 2933, verdict: 'fits' }],
  ['sliding window under a unified cache with 4 slots and ubatch 1024',
    model({ sizeBytes: 16.5e9, blockCount: 62, headCountKv: 16, headDim: 128, slidingWindow: 1024, slidingWindowPattern: swa(62) }),
    profile({ ctx: 16384, parallel: 4, uBatchSize: 1024 }), 24564, { estMb: 20823, verdict: 'tight' }],
  ['hybrid under a unified cache with 3 slots: the SSM state still scales per sequence',
    model(hybrid), profile({ parallel: 3 }), 24564, { estMb: 20211, verdict: 'tight' }],
  ['KV cache in system RAM costs no VRAM',
    model(hybrid), profile({ ctx: 65536, kvOffload: false }), 24564, { estMb: 17600, verdict: 'fits' }],
  ['an unusable hybrid interval (> blocks) falls back to the legacy all-layer formula',
    model({ sizeBytes: 5e9, blockCount: 1, headCountKv: 8, headDim: 0, fullAttentionInterval: 4 }),
    profile({ ctx: 8192 }), 12288, { estMb: 5834, verdict: 'fits' }],
]

describe('estimateVram — parity with the daemon (src/models/profile.ts)', () => {
  for (const [name, m, p, vramMb, daemon] of cases) {
    it(name, () => {
      const web = estimateVram(p, m, vramMb)
      expect({ estMb: web.estMb, verdict: web.verdict }).toEqual(daemon)
    })
  }
})
