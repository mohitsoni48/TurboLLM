// Direct unit tests for buildStartOpts, the one StartOpts builder shared by the manual Load path
// (startEngine) and the boot resume (D10, run 2026-09-13-autoload-last-model). The resume path used to
// keep its own copy, and it drifted: KoboldCpp got llama-server flags, vLLM lost --max-model-len, and a
// pinned port was ignored. Equivalence with startEngine at 4fa0f7b is pinned separately, by
// src/api/engine-lifecycle.start-opts.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Config, type Engine, defaultConfig } from '../config/config'
import type { LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import { type SysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { koboldcppProfileToArgs } from './koboldcpp'
import type { StartOpts } from './manager'
import { mlxSamplingArgs } from './mlx'
import { buildStartOpts, launchFormat } from './start-opts'
import type { ModelFormat } from './compat'

const NO_GPU_MACHINE: SysInfo = { os: 'win32', cpu: 'test', cores: 8, ramMB: 32768, gpus: [] }

test('a GGUF load carries the resume trigger it was built with', () => {
  const opts = resumeLoad(ggufModel(), 'llama-server')

  assert.equal(opts.trigger, 'resume')
})

test('a safetensors model-directory load carries the resume trigger it was built with', () => {
  const opts = resumeLoad(safetensorsModel(), 'vllm')

  assert.equal(opts.trigger, 'resume')
})

test('koboldcpp gets KoboldCpp flags, including --usecpu on a machine with no GPU', () => {
  const opts = resumeLoad(ggufModel(), 'koboldcpp')

  assert.deepEqual(opts.extraArgs, koboldcppProfileToArgs(opts.profile!, primaryVendor(NO_GPU_MACHINE), false))
  assert.ok(opts.extraArgs.includes('--usecpu'))
  assert.ok(!opts.extraArgs.includes('-c'))
})

// KoboldCpp's backend comes from the primary vendor, not from gpus[0]: an Intel iGPU listed
// before an NVIDIA card must not pick Vulkan. The shared builder ranks vendors.
test('koboldcpp picks its GPU backend from the primary vendor, not the first GPU listed', () => {
  const igpuFirst: SysInfo = {
    ...NO_GPU_MACHINE,
    gpus: [
      { name: 'Intel UHD', vramMb: 1024, vendor: 'intel' },
      { name: 'RTX 5070 Ti', vramMb: 16384, vendor: 'nvidia' },
    ],
  }

  const opts = buildStartOpts({
    entry: ggufModel(), engine: testEngine('koboldcpp'), cfg: defaultConfig(), sys: igpuFirst,
    overrides: { ngl: 99 }, trigger: 'gateway_switch',
  })

  assert.ok(opts.extraArgs.includes('--usecuda'))
  assert.ok(!opts.extraArgs.includes('--usevulkan'))
})

test('vllm gets --max-model-len from the saved vLLM profile', () => {
  const cfg = configWithSavedProfile({ vllm: { maxModelLen: 16384 } })

  const opts = resumeLoad(safetensorsModel(), 'vllm', cfg)

  assert.ok(opts.extraArgs.includes('--max-model-len'))
})

test('llama-server keeps the saved pinned port as the preferred port', () => {
  const cfg = configWithSavedProfile({ port: 9200 })

  const opts = resumeLoad(ggufModel(), 'llama-server', cfg)

  assert.equal(opts.preferredPort, 9200)
})

// The load dialog's "this load only" (Remember unchecked) sends its draft as overrides. The model-directory
// path resolved them into `profile` but launched from the saved profile alone, so a draft tensor-parallel
// size, pinned port or MLX sampling never reached the engine.
test('model-directory engines launch with the "this load only" overrides over the saved profile', () => {
  const cfg = configWithSavedProfile({ port: 9200, gpu: { tensorParallelSize: 1 }, sampling: { temp: 0.7, topP: 0.9 } })
  const overrides = {
    port: 9300,
    gpu: { splitMode: 'layer', tensorSplit: [], mainGpu: -1, tensorParallelSize: 2 },
    sampling: { temp: 0.2 }, // a partial draft, as an API caller may send
  } as unknown as Partial<LoadProfile>
  const build = (kind: string) =>
    buildStartOpts({ entry: safetensorsModel(), engine: testEngine(kind), cfg, sys: NO_GPU_MACHINE, overrides, trigger: 'manual' })

  const vllm = build('vllm')
  const mlx = build('mlx')

  assert.equal(vllm.tensorParallelSize, 2)
  assert.equal(vllm.preferredPort, 9300)
  assert.deepEqual(mlx.extraArgs, ['--temp', '0.2', '--top-p', '0.9'])
  assert.equal(mlx.preferredPort, 9300)
})

test('building StartOpts leaves the config snapshot it reads unchanged', () => {
  const cfg = configWithSavedProfile({ ctx: 16384, port: 9200, vllm: { maxModelLen: 16384 } })
  const before = structuredClone(cfg)

  for (const [entry, kind] of [[ggufModel(), 'llama-server'], [safetensorsModel(), 'vllm']] as const) {
    const overrides = { ctx: 8192 }
    buildStartOpts({ entry, engine: testEngine(kind), cfg, sys: NO_GPU_MACHINE, overrides, trigger: 'resume' })
  }

  assert.deepEqual(cfg, before)
})

const OPENJEV_LAUNCH_TOKENS = [
  '--runner', 'pooling',
  '--convert', 'classify',
  '--hf-overrides', '{"architectures":["Qwen3_5ForConditionalGeneration"]}',
  '--limit-mm-per-prompt', '{"image":0,"video":0}',
]

function jevModel(): ModelEntry {
  return ggufModel({
    format: 'mlx', nativeCtx: 262144, path: 'D:\\models\\openjev\\qwen3.5-4b-nli-v2',
    jev: {
      labels: ['contradiction', 'entailment', 'neutral'],
      nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
      architecture: 'Qwen3_5ForSequenceClassification',
      verified: true,
    },
  })
}

// The length is capped here, not passed through: vLLM's profile run on this model's native
// 262,144 died with a CUDA illegal memory access (2026-09-21, vLLM 0.29.0) — see jev.ts.
test('a Jev model on vLLM launches with the verified classifier flags after the profile flags', () => {
  const opts = resumeLoad(jevModel(), 'vllm')

  assert.deepEqual(opts.extraArgs, [
    '--max-model-len', '8192', '--max-num-batched-tokens', '8192', ...OPENJEV_LAUNCH_TOKENS,
  ])
})

test('a Jev model on MLX keeps the MLX sampling path, with no Jev flags', () => {
  const opts = resumeLoad(jevModel(), 'mlx')

  assert.deepEqual(opts.extraArgs, mlxSamplingArgs(undefined))
})

// A manual Load starts a model on the selected engine whatever its format (compat.ts manualLoadRefusal). Built for the
// model's format, the engine got options of another engine: llama.cpp's -c and -ngl on vLLM, the LiteRT-LM --config
// object under KoboldCpp, so it failed on arguments it does not take instead of on the file it was handed.
test("a model the engine does not read is launched with that engine's own options", () => {
  const litertlm = ggufModel({ format: 'litertlm', path: 'D:\\models\\gemma.litertlm' })
  const kobold = resumeLoad(litertlm, 'koboldcpp')
  assert.deepEqual(kobold.extraArgs, koboldcppProfileToArgs(kobold.profile!, primaryVendor(NO_GPU_MACHINE), false))
  assert.equal(kobold.litertLmConfig, undefined)
  assert.equal(kobold.modelPath, litertlm.path)

  const vllm = resumeLoad(ggufModel(), 'vllm')
  assert.ok(vllm.extraArgs.includes('--max-num-batched-tokens'), vllm.extraArgs.join(' '))
  assert.ok(!vllm.extraArgs.includes('-c'), vllm.extraArgs.join(' '))

  const llama = resumeLoad(safetensorsModel(), 'llama-server')
  assert.deepEqual(llama.extraArgs.slice(0, 2), ['-c', String(llama.profile!.ctx)])

  const litert = resumeLoad(ggufModel(), 'litert-lm')
  assert.ok(litert.litertLmConfig, 'the LiteRT-LM engine reads its options from --config')
})

// QG-3 (ADR-462, plan D-8): a hand-loaded model the selected SDK row does not read is launched with that row's own
// options, as for every other engine. The fallback asked the kind, so a GGUF loaded on the LiteRT-LM SDK row was built
// as a model directory ('mlx').
test('a GGUF loaded on the LiteRT-LM SDK row is built through the LiteRT-LM path, not the model-directory one', () => {
  const opts = buildStartOpts({ entry: ggufModel(), engine: sdkRowEngine(['litertlm']), cfg: defaultConfig(), sys: NO_GPU_MACHINE, trigger: 'resume' })
  assert.ok(opts.litertLmConfig, 'LiteRT-LM options')
})

test('a .litertlm loaded on the llama.cpp SDK row is built through the GGUF path', () => {
  const litertlm = ggufModel({ format: 'litertlm', path: 'D:\\models\\gemma.litertlm' })
  const opts = buildStartOpts({ entry: litertlm, engine: sdkRowEngine(['gguf']), cfg: defaultConfig(), sys: NO_GPU_MACHINE, trigger: 'resume' })
  assert.equal(opts.litertLmConfig, undefined)
  assert.deepEqual(opts.extraArgs.slice(0, 2), ['-c', String(opts.profile!.ctx)])
})

/** launchFormat before D-8, pasted verbatim (with the kind table it read): every kind still launches as it did. */
function launchFormatBefore(engineKind: string, format: ModelFormat): ModelFormat {
  const accepts = (f: ModelFormat) => {
    if (['mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang'].includes(engineKind)) return f === 'mlx'
    if (engineKind === 'laya') return false
    if (engineKind === 'litert-lm') return f === 'litertlm'
    if (engineKind === 'turbollm-sdk') return f === 'gguf' || f === 'litertlm'
    return f === 'gguf'
  }
  if (accepts(format)) return format
  if (engineKind === 'litert-lm') return 'litertlm'
  return accepts('gguf') ? 'gguf' : 'mlx'
}

test('launchFormat is unchanged for every kind and format (the legacy SDK row included)', () => {
  const kinds = ['llama-server', 'llamafile', 'koboldcpp', 'mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang', 'litert-lm', 'laya', 'turbollm-sdk', 'a-future-kind']
  for (const kind of kinds) {
    for (const format of ['gguf', 'mlx', 'litertlm'] as ModelFormat[]) {
      assert.equal(launchFormat({ kind }, format), launchFormatBefore(kind, format), `${kind} ${format}`)
    }
  }
})

function sdkRowEngine(formats: ModelFormat[]): Engine {
  return { ...testEngine('turbollm-sdk'), sdkEngine: { id: 'sdk-engine', kind: 'sdk-runtime', formats, backends: ['cpu'] } }
}

function resumeLoad(entry: ModelEntry, kind: string, cfg: Config = defaultConfig()): StartOpts {
  return buildStartOpts({ entry, engine: testEngine(kind), cfg, sys: NO_GPU_MACHINE, trigger: 'resume' })
}

function configWithSavedProfile(profile: Record<string, unknown>): Config {
  const cfg = defaultConfig()
  cfg.modelProfiles['model-a'] = { 'eng-1': { profile, updatedAt: '2026-09-13T00:00:00.000Z' } }
  return cfg
}

function testEngine(kind: string): Engine {
  return {
    id: 'eng-1', name: 'test-engine', kind, binPath: 'llama-server', version: 'b1',
    capabilities: { kvTypes: [], flags: [] }, addedAt: 't',
  } as Engine
}

function safetensorsModel(): ModelEntry {
  return ggufModel({ format: 'mlx', nativeCtx: 32768, path: 'D:\\models\\model-a' })
}

function ggufModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'model-a', name: 'Model A', path: 'D:\\models\\model-a.gguf', dir: 'D:\\models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 4096,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    loaded: false, hasProfile: false, benchTps: null, mtime: '2026-09-13T00:00:00.000Z',
    ...overrides,
  }
}
