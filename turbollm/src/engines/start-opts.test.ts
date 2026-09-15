// Direct unit tests for buildStartOpts, the one StartOpts builder shared by the manual Load path
// (startEngine) and the boot resume (D10, run 2026-09-13-autoload-last-model). The resume path used to
// keep its own copy, and it drifted: KoboldCpp got llama-server flags, vLLM lost --max-model-len, and a
// pinned port was ignored. Equivalence with startEngine at 4fa0f7b is pinned separately, by
// src/api/engine-lifecycle.start-opts.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Config, type Engine, defaultConfig } from '../config/config'
import type { ModelEntry } from '../models/scanner'
import { type SysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { koboldcppProfileToArgs } from './koboldcpp'
import type { StartOpts } from './manager'
import { buildStartOpts } from './start-opts'

const NO_GPU_MACHINE: SysInfo = { os: 'win32', cpu: 'test', cores: 8, ramMB: 32768, gpus: [] }

test('a GGUF load carries the resume trigger it was built with', () => {
  const opts = resumeLoad(ggufModel(), 'llama-server')

  assert.equal(opts.trigger, 'resume')
})

test('a safetensors model-directory load carries the resume trigger it was built with', () => {
  const opts = resumeLoad(safetensorsModel(), 'vllm')

  assert.equal(opts.trigger, 'resume')
})

test('koboldcpp gets KoboldCpp flags, including --nogpu on a machine with no GPU', () => {
  const opts = resumeLoad(ggufModel(), 'koboldcpp')

  assert.deepEqual(opts.extraArgs, koboldcppProfileToArgs(opts.profile!, primaryVendor(NO_GPU_MACHINE), false))
  assert.ok(opts.extraArgs.includes('--nogpu'))
  assert.ok(!opts.extraArgs.includes('-c'))
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

test('building StartOpts leaves the config snapshot it reads unchanged', () => {
  const cfg = configWithSavedProfile({ ctx: 16384, port: 9200, vllm: { maxModelLen: 16384 } })
  const before = structuredClone(cfg)

  for (const [entry, kind] of [[ggufModel(), 'llama-server'], [safetensorsModel(), 'vllm']] as const) {
    const overrides = { ctx: 8192 }
    buildStartOpts({ entry, engine: testEngine(kind), cfg, sys: NO_GPU_MACHINE, overrides, trigger: 'resume' })
  }

  assert.deepEqual(cfg, before)
})

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
