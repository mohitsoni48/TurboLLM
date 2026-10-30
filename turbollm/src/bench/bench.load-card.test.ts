// A single-GPU auto-tune on a box of more than one card, where the engine may number the cards otherwise than
// nvidia-smi (cards of two models, a Vulkan build, an engine added by hand): the real search reads each load's VRAM
// through a stand-in nvidia-smi, whose figures follow the -ngl the stand-in manager was started with. Summing the
// cards there counted another program's memory on the other card as the load's, so the tune found no candidate or
// too few layers; and card N's memory was another card's than the engine's. The card a load grows is now its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BenchRunner, type BenchCandidate } from './bench'
import { deriveDefault, type LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'
import { tmpDir } from '../test-support/tmp'

const skip = process.platform === 'win32' ? 'a stand-in nvidia-smi script on PATH' : false

/** A card as the stand-in nvidia-smi reports it: `idle` MB used by others; a card the engine uses also holds `base` MB
 *  plus `perLayer` MB per offloaded layer while it is loaded, and `gen` MB more once it has generated, up to 50 MB short
 *  of `cap`. */
type Card = { idle: number; cap: number; engine?: { base: number; perLayer: number; gen?: number } }

const dir = skip ? '' : tmpDir('tllm-load-card-')
const state = join(dir, 'smi.json')
if (!skip) {
  writeFileSync(join(dir, 'nvidia-smi'), `#!/usr/bin/env node
const st = JSON.parse(require('fs').readFileSync(${JSON.stringify(state)}, 'utf8'))
process.stdout.write(st.cards.map((c) => c.engine && st.ngl !== null ? Math.min(c.cap - 50, c.idle + c.engine.base + st.ngl * c.engine.perLayer + (st.gen ? c.engine.gen || 0 : 0)) : c.idle).join('\\n') + '\\n')
`)
  chmodSync(join(dir, 'nvidia-smi'), 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
  for (const v of ['CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'GPU_DEVICE_ORDINAL']) delete process.env[v]
}

const CAPS = { kvTypes: ['f16', 'q8_0'], flags: [] as string[] }
const MODEL: ModelEntry = {
  key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
  sizeBytes: 8_000_000_000, sizeLabel: '8 GB', arch: 'llama', quant: 'Q4_K_M',
  nativeCtx: 8192, blockCount: 8, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
  nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
  incomplete: false, parseError: null, loaded: false, hasProfile: false,
  benchTps: null, mtime: '',
}

/** The ngl a single-GPU tune on `mainGpu` benches, and its probes' readings, with 1024 MB of headroom. */
async function tune(sys: SysInfo, mainGpu: number, binPath: string, cards: Card[]): Promise<{ benched: number | null; probes: string[] }> {
  const { r } = runner(binPath, cards)
  let benched: number | null = null
  r.benchAt = async (_e, _s, p) => { benched = p.ngl; return null }
  const d = deriveDefault(MODEL, sys)
  const results: BenchCandidate[] = []
  await r.denseSearch(MODEL, sys, { ...d, ctx: 8192, gpu: { ...d.gpu, splitMode: 'none', mainGpu, tensorSplit: [] } }, CAPS, results, 1024)
  return { benched, probes: results.map((c) => `${c.label}: ${c.vramAbsMb}`) }
}

/** A BenchRunner whose engine is the stand-in: its loads set the stand-in nvidia-smi's -ngl, and a measured chat sets
 *  its generated state. */
function runner(binPath: string, cards: Card[]) {
  const save = (ngl: number | null, gen = false) => writeFileSync(state, JSON.stringify({ ngl, gen, cards }))
  save(null)
  let ngl: number | null = null
  const manager = {
    start: async (opts: { extraArgs: string[] }, hooks?: { beforeStart?: () => Promise<void> }) => {
      await hooks?.beforeStart?.()
      ngl = Number(opts.extraArgs[opts.extraArgs.indexOf('-ngl') + 1])
      save(ngl)
    },
    stopAndWait: async () => { ngl = null; save(null) },
    status: () => ({ state: 'running' }),
    logPath: () => null,
    target: () => 'http://engine.invalid', // never asked: the measured chat is stubbed
  }
  const engine = { id: 'llama-cpp', binPath, version: 'b1', capabilities: CAPS }
  const bench = new BenchRunner(manager as never, { dir: () => '/home/u/.turbollm' } as never, {} as never, { active: () => engine } as never, 'test', {} as never)
  const r = bench as unknown as {
    deadline: number; engine: unknown; loadCards: Map<string, number>; settleGpu: () => Promise<void>
    benchAt: (e: ModelEntry, s: SysInfo, p: LoadProfile) => Promise<null>
    prefillProbe: () => Promise<'ok'>
    runChatWatched: () => Promise<{ tps: number; prefillTps: number; ttftMs: number }>
    denseSearch: (e: ModelEntry, s: SysInfo, p: LoadProfile, caps: typeof CAPS, results: BenchCandidate[], headroomMb: number) => Promise<{ profile: LoadProfile } | null>
  }
  r.deadline = Date.now() + 120_000
  r.engine = engine
  r.settleGpu = async () => {}
  r.prefillProbe = async () => 'ok'
  r.runChatWatched = async () => { save(ngl, true); return { tps: 50, prefillTps: 500, ttftMs: 100 } }
  return { r }
}

const box = (...gpus: Array<[string, number]>): SysInfo =>
  ({ os: 'linux/x64', cpu: 't', cores: 8, ramMB: 64000, gpus: gpus.map(([name, vramMb]) => ({ name, vramMb, vendor: 'nvidia' as const })) })
const CUDA = '/home/u/.turbollm/engines/llama.cpp-b6000-cuda/llama-server'

test('single-GPU tune on cards of two models: another program\'s 13 GB on the other card does not fail every candidate', { skip }, async () => {
  // nvidia-smi lists the 4090 on bus 01 and the 3060 on bus 02; a CUDA build numbers the 4090 first too, so
  // `--main-gpu 1` is the 3060. ComfyUI holds 13 GB on the 4090. The sum read over 13 GB at every ngl, against the
  // 3060's 11264 MB below its headroom, and the tune found nothing.
  const got = await tune(box(['NVIDIA GeForce RTX 4090', 24564], ['NVIDIA GeForce RTX 3060', 12288]), 1, CUDA, [
    { idle: 13000, cap: 24564 },
    { idle: 200, cap: 12288, engine: { base: 300, perLayer: 1000 } },
  ])
  assert.equal(got.benched, 9, got.probes.join(', '))
})

test('single-GPU tune with an engine added by hand: the other card\'s 20 GB does not hold the offload back', { skip }, async () => {
  // Two RTX 3090s and a llama-server whose build TurboLLM cannot tell (it may be Vulkan), on card 1; card 0 holds
  // 20 GB of another program. The sum passed only ngl=0 and 1.
  const got = await tune(box(['NVIDIA GeForce RTX 3090', 24576], ['NVIDIA GeForce RTX 3090', 24576]), 1, '/opt/llama/build/bin/llama-server', [
    { idle: 20000, cap: 24576 },
    { idle: 200, cap: 24576, engine: { base: 300, perLayer: 2000 } },
  ])
  assert.equal(got.benched, 9, got.probes.join(', '))
})

test('single-GPU tune on a Vulkan build whose card 0 is the listing\'s card 1: judged against that card\'s memory', { skip }, async () => {
  // nvidia-smi lists a 3090 then the 3060 that drives the display, which the Vulkan loader puts first: `--main-gpu 0`
  // is the 3060. Judged against the 3090's 24 GB, a load filling the 3060 to its last 50 MB still fitted: 1400 MB and
  // 1200 per layer leave the user's 1 GB of headroom on the 3060 up to ngl=8.
  const got = await tune(box(['NVIDIA GeForce RTX 3090', 24576], ['NVIDIA GeForce RTX 3060', 12288]), 0,
    '/home/u/.turbollm/engines/llama.cpp-b6000-vulkan/llama-server', [
      { idle: 300, cap: 24576 },
      { idle: 1100, cap: 12288, engine: { base: 300, perLayer: 1200 } },
    ])
  assert.equal(got.benched, 8, got.probes.join(', '))
})

test('single-GPU tune where the engine numbers the cards as listed: card N, as before', { skip }, async () => {
  // Two cards of one model and an official CUDA build: card 1 is read without asking which card grew.
  const got = await tune(box(['NVIDIA GeForce RTX 3090', 24576], ['NVIDIA GeForce RTX 3090', 24576]), 1, CUDA, [
    { idle: 20000, cap: 24576 },
    { idle: 200, cap: 24576, engine: { base: 300, perLayer: 2000 } },
  ])
  assert.equal(got.benched, 9, got.probes.join(', '))
})

// measure() reads each card before a load for every split, for the load's own share; only a single-GPU load's card is
// learnt from it. A layer split's Phase 2 learnt the card that grew most, read it alone against the summed pool, and so
// missed the headroom its generation went past.
test('a layer split\'s Phase 2 reads the summed pool: its headroom backoff still fires, and no card is learnt', { skip }, async () => {
  // A 3090 and a 3070, an official CUDA build, layers split by free memory (3:1). Loaded, ngl=9 fits the pool with
  // the 1 GB headroom (29900 of 32768 MB); generating adds 1500 and 700 MB, past it (31842 MB): one layer less.
  const { r } = runner(CUDA, [
    { idle: 300, cap: 24576, engine: { base: 300, perLayer: 2400, gen: 1500 } },
    { idle: 300, cap: 8192, engine: { base: 200, perLayer: 800, gen: 700 } },
  ])
  const sys = box(['NVIDIA GeForce RTX 3090', 24576], ['NVIDIA GeForce RTX 3070', 8192])
  const d = deriveDefault(MODEL, sys)
  const results: BenchCandidate[] = []
  const found = await r.denseSearch(MODEL, sys, { ...d, ctx: 8192, gpu: { ...d.gpu, splitMode: 'layer', tensorSplit: [] } }, CAPS, results, 1024)
  const runs = results.map((c) => `${c.label}: ${c.vramAbsMb}`)
  assert.ok(runs.includes('ngl=9: 31842'), runs.join(', '))
  assert.equal(found?.profile.ngl, 8, runs.join(', '))
  assert.deepEqual([...r.loadCards], [])
})
