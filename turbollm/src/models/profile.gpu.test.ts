// Multi-GPU split tests (ADR-054). Covers the profile → llama.cpp arg mapping, the
// vLLM tensor-parallel arg, the multi-GPU VRAM budget, capability gating, and that the
// defaults are no-ops (no behavior change on a single-GPU box or an unconfigured split).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultGpu, deriveDefault, estimateVram, gpuBudgetMb, profileToArgs, resolveProfile } from './profile'
import type { LoadProfile } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'
import { vllmServerCommand } from '../engines/vllm'

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

function sys(gpus: Array<{ vramMb: number }>): SysInfo {
  return {
    os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
    gpus: gpus.map((g, i) => ({ name: `gpu${i}`, vramMb: g.vramMb, vendor: 'nvidia' as const })),
  }
}

const caps = { kvTypes: [], flags: [] } // empty flags = graceful-degrade (all flags allowed)

function withGpu(over: Partial<LoadProfile['gpu']>): LoadProfile {
  const base = deriveDefault(model(), sys([{ vramMb: 24000 }]))
  return { ...base, gpu: { ...defaultGpu(), ...over } }
}

test('default gpu profile emits no multi-GPU flags (no behavior change)', () => {
  const p = deriveDefault(model(), sys([{ vramMb: 24000 }, { vramMb: 24000 }]))
  const args = profileToArgs(p, model(), caps)
  assert.equal(args.includes('--split-mode'), false)
  assert.equal(args.includes('--tensor-split'), false)
  assert.equal(args.includes('--main-gpu'), false)
})

test('split-mode row is emitted; layer (default) is not', () => {
  assert.deepEqual(splitFlag(profileToArgs(withGpu({ splitMode: 'row' }), model(), caps)), 'row')
  assert.equal(profileToArgs(withGpu({ splitMode: 'layer' }), model(), caps).includes('--split-mode'), false)
})

test('split-mode none pins a single GPU and suppresses tensor-split', () => {
  const args = profileToArgs(withGpu({ splitMode: 'none', mainGpu: 1, tensorSplit: [0.5, 0.5] }), model(), caps)
  assert.equal(splitFlag(args), 'none')
  assert.equal(args[args.indexOf('--main-gpu') + 1], '1')
  assert.equal(args.includes('--tensor-split'), false) // ignored for single-GPU
})

test('tensor-split is joined with commas', () => {
  const args = profileToArgs(withGpu({ tensorSplit: [0.6, 0.4] }), model(), caps)
  assert.equal(args[args.indexOf('--tensor-split') + 1], '0.6,0.4')
})

test('main-gpu -1 (default) emits no flag', () => {
  assert.equal(profileToArgs(withGpu({ mainGpu: -1 }), model(), caps).includes('--main-gpu'), false)
})

test('GPU flags are gated by engine capability', () => {
  const limited = { kvTypes: [], flags: ['-ngl', '--parallel'] } // no split flags
  const args = profileToArgs(withGpu({ splitMode: 'row', tensorSplit: [1, 1], mainGpu: 0 }), model(), limited)
  assert.equal(args.includes('--split-mode'), false)
  assert.equal(args.includes('--tensor-split'), false)
  assert.equal(args.includes('--main-gpu'), false)
})

test('gpuBudgetMb sums all GPUs for layer/row split, picks one for none', () => {
  const s = sys([{ vramMb: 24000 }, { vramMb: 16000 }])
  assert.equal(gpuBudgetMb(s, withGpu({ splitMode: 'layer' })), 40000)
  assert.equal(gpuBudgetMb(s, withGpu({ splitMode: 'row' })), 40000)
  assert.equal(gpuBudgetMb(s, withGpu({ splitMode: 'none', mainGpu: 1 })), 16000)
  assert.equal(gpuBudgetMb(s, withGpu({ splitMode: 'none', mainGpu: -1 })), 24000) // default GPU 0
  assert.equal(gpuBudgetMb(sys([]), withGpu({})), 0)
})

test('estimateVram uses the summed multi-GPU budget', () => {
  const big = model({ sizeBytes: 30_000_000_000 }) // ~30 GB weights
  const oneGpu = estimateVram(withGpu({}), big, sys([{ vramMb: 24000 }]))
  const twoGpu = estimateVram(withGpu({}), big, sys([{ vramMb: 24000 }, { vramMb: 24000 }]))
  assert.equal(oneGpu.verdict, 'overflow') // doesn't fit one 24 GB card
  assert.equal(twoGpu.totalVramMb, 48000)
  assert.equal(twoGpu.verdict, 'fits') // fits across two
})

test('resolveProfile deep-merges gpu (partial override keeps other fields)', () => {
  const m = model()
  const s = sys([{ vramMb: 24000 }, { vramMb: 24000 }])
  const resolved = resolveProfile(m, s, { gpu: { tensorSplit: [0.7, 0.3] } as LoadProfile['gpu'] }, { gpu: { mainGpu: 1 } as LoadProfile['gpu'] })
  assert.deepEqual(resolved.gpu.tensorSplit, [0.7, 0.3]) // from saved
  assert.equal(resolved.gpu.mainGpu, 1) // from override
  assert.equal(resolved.gpu.splitMode, 'layer') // untouched default survives
  assert.equal(resolved.gpu.tensorParallelSize, 1)
})

test('vllmServerCommand adds --tensor-parallel-size only when > 1', () => {
  assert.equal(vllmServerCommand('py', 'org/m', 8000, '127.0.0.1').args.includes('--tensor-parallel-size'), false)
  assert.equal(vllmServerCommand('py', 'org/m', 8000, '127.0.0.1', 1).args.includes('--tensor-parallel-size'), false)
  const tp2 = vllmServerCommand('py', 'org/m', 8000, '127.0.0.1', 2).args
  assert.equal(tp2[tp2.indexOf('--tensor-parallel-size') + 1], '2')
})

/** The value after --split-mode, or undefined when the flag is absent. */
function splitFlag(args: string[]): string | undefined {
  const i = args.indexOf('--split-mode')
  return i < 0 ? undefined : args[i + 1]
}
