// buildStartOpts for a .litertlm bundle: the LiteRT-LM engine's backend/context/threads travel as a config object
// (written to `serve --config` by the manager), and the model path is the bundle file itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Config, type Engine, defaultConfig } from '../config/config'
import type { ModelEntry } from '../models/scanner'
import { litertlmEntryFor } from '../models/litertlm'
import type { SysInfo } from '../sysinfo/sysinfo'
import { buildStartOpts } from './start-opts'

const CPU_ONLY: SysInfo = { os: 'win32', cpu: 'test', cores: 8, ramMB: 32768, gpus: [] }
const WITH_GPU: SysInfo = { ...CPU_ONLY, gpus: [{ name: 'Radeon 780M', vramMb: 4096, vendor: 'amd' }] }

const engine = (): Engine =>
  ({ id: 'lrt-1', name: 'LiteRT-LM', kind: 'litert-lm', binPath: '/venv/bin/python', version: 'litert-lm 0.17.1', capabilities: { kvTypes: [], flags: [] }, addedAt: 't' }) as Engine

const entry = (): ModelEntry => litertlmEntryFor('/models/gemma-3n-E2B-it-int4-ekv4096.litertlm', '/models', 3_000_000_000, 0)

function withSaved(profile: Record<string, unknown>, e: ModelEntry): Config {
  const cfg = defaultConfig()
  cfg.modelProfiles[e.key] = { 'lrt-1': { profile, updatedAt: '2026-10-03T00:00:00.000Z' } }
  return cfg
}

test('a .litertlm load uses the bundle path, text-only model info and the given trigger', () => {
  const e = entry()
  const opts = buildStartOpts({ entry: e, engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, trigger: 'manual' })
  assert.equal(opts.modelPath, '/models/gemma-3n-E2B-it-int4-ekv4096.litertlm')
  assert.equal(opts.model.key, e.key)
  assert.equal(opts.model.vision, false)
  assert.equal(opts.model.quant, 'INT4')
  assert.equal(opts.trigger, 'manual')
  assert.ok(opts.profile)
})

test('under Auto the config names no backend, GPU or not, whatever the GPU-layers setting: the model\'s own applies', () => {
  // It named the GPU when one was detected and GPU layers was above 0, the CPU otherwise: a CPU-only bundle failed on
  // the Android app (which reports its GPU) and a GPU-only one on Termux or with GPU layers at 0.
  for (const sys of [CPU_ONLY, WITH_GPU]) {
    for (const ngl of [0, 99]) {
      const opts = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys, overrides: { ngl }, trigger: 'manual' })
      assert.equal(opts.litertLmConfig?.default.backend, undefined, `${sys.gpus.length} GPUs, ngl ${ngl}`)
    }
  }
})

test('ctx and threads from the profile reach the config; ctx also lands on the model info', () => {
  const opts = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, overrides: { ctx: 2048, threads: 4, ngl: 0 }, trigger: 'manual' })
  assert.equal(opts.litertLmConfig?.default.max_num_tokens, 2048)
  assert.equal(opts.litertLmConfig?.default.cpu_thread_count, 4)
  assert.equal(opts.model.ctx, 2048)
})

test('a saved profile port is carried as the preferred port, and user extra args pass through', () => {
  const e = entry()
  const cfg = withSaved({ port: 8123, ngl: 0, extraArgs: ['--verbose'] }, e)
  const opts = buildStartOpts({ entry: e, engine: engine(), cfg, sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(opts.preferredPort, 8123)
  assert.deepEqual(opts.extraArgs, ['--verbose'])
})

test('a .litertlm load never carries llama.cpp flags or a tensor-parallel size', () => {
  const opts = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: WITH_GPU, trigger: 'manual' })
  assert.ok(!opts.extraArgs.some((a) => a === '-ngl' || a === '--ctx-size' || a === '-c'))
  assert.equal(opts.tensorParallelSize, undefined)
})

test('an explicit backend in the profile wins over detection: gpu is honoured with no GPU detected (Android)', () => {
  const forced = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, overrides: { ngl: 0, litertLm: { backend: 'gpu' } }, trigger: 'manual' })
  assert.equal(forced.litertLmConfig?.default.backend, 'gpu')
  const cpu = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: WITH_GPU, overrides: { ngl: 99, litertLm: { backend: 'cpu' } }, trigger: 'manual' })
  assert.equal(cpu.litertLmConfig?.default.backend, 'cpu')
})

test('a saved litertLm.backend survives the profile merge, and an old profile without it defaults to auto', () => {
  const e = entry()
  const saved = buildStartOpts({ entry: e, engine: engine(), cfg: withSaved({ ngl: 0, litertLm: { backend: 'gpu' } }, e), sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(saved.profile?.litertLm.backend, 'gpu')
  assert.equal(saved.litertLmConfig?.default.backend, 'gpu')
  const old = buildStartOpts({ entry: e, engine: engine(), cfg: withSaved({ ngl: 99 }, e), sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(old.profile?.litertLm.backend, 'auto')
  assert.equal(old.litertLmConfig?.default.backend, undefined)
})

// ── context: the bundle's own unless the user set one ─────────────────────────────────────────
// Qwen3-0.6B_dynamic's header: a dynamic export taking up to 32770 tokens, LlmMetadata.max_num_tokens 4096. TurboLLM
// wrote max_num_tokens 8192 on every load (min(Model Defaults, the limit)), doubling its KV cache, and reported 8192.
const qwen3 = (): ModelEntry => litertlmEntryFor('/models/Qwen3-0.6B_dynamic.litertlm', '/models', 600_000_000, 0, { nativeCtx: 32770, ctxDynamic: true, defaultCtx: 4096 })

test('with no context set, no max_num_tokens is written and the bundle\'s own default is reported', () => {
  const opts = buildStartOpts({ entry: qwen3(), engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, trigger: 'manual' })
  assert.equal(opts.litertLmConfig?.default.max_num_tokens, undefined)
  assert.equal(opts.model.ctx, 4096)
  assert.equal(opts.profile?.ctx, 4096)
  // A bundle that declares no default: the runtime's 4096, not 8192.
  const bare = litertlmEntryFor('/models/gemma-4-E2B-it.litertlm', '/models', 2e9, 0)
  const b = buildStartOpts({ entry: bare, engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, trigger: 'manual' })
  assert.equal(b.litertLmConfig?.default.max_num_tokens, undefined)
  assert.equal(b.model.ctx, 4096)
})

test('a context the user saved is written, a request\'s too, and a Model Defaults context the user changed', () => {
  const e = qwen3()
  const saved = buildStartOpts({ entry: e, engine: engine(), cfg: withSaved({ ctx: 6000, userSetOnly: true }, e), sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(saved.litertLmConfig?.default.max_num_tokens, 6000)
  assert.equal(saved.model.ctx, 6000)
  const asked = buildStartOpts({ entry: e, engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, overrides: { ctx: 16384 }, trigger: 'manual' })
  assert.equal(asked.litertLmConfig?.default.max_num_tokens, 16384)
  const cfg = defaultConfig()
  cfg.modelDefaults.ctx = 16384
  const global = buildStartOpts({ entry: e, engine: engine(), cfg, sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(global.litertLmConfig?.default.max_num_tokens, 16384)
  assert.equal(global.model.ctx, 16384)
  // Model Defaults' built-in 8192 is in every config, set or not: it is not the user's.
  assert.equal(buildStartOpts({ entry: e, engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, trigger: 'resume' }).litertLmConfig?.default.max_num_tokens, undefined)
})

test('an earlier build\'s whole profile with the automatic 8192 of the day writes no context; a context the user moved stays', () => {
  const e = qwen3()
  // What the old dialog saved for a Backend change: min(Model Defaults 8192, the raw 32771) and the rest.
  const old = buildStartOpts({ entry: e, engine: engine(), cfg: withSaved({ ctx: 8192, ngl: 99, threads: 0, litertLm: { backend: 'cpu' } }, e), sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(old.litertLmConfig?.default.max_num_tokens, undefined)
  assert.equal(old.litertLmConfig?.default.backend, 'cpu')
  assert.equal(old.model.ctx, 4096)
  const moved = buildStartOpts({ entry: e, engine: engine(), cfg: withSaved({ ctx: 2048, ngl: 99, threads: 0 }, e), sys: CPU_ONLY, trigger: 'resume' })
  assert.equal(moved.litertLmConfig?.default.max_num_tokens, 2048)
})

test('a user context past a dynamic export\'s maximum is cut to it, below its magic number', () => {
  const opts = buildStartOpts({ entry: qwen3(), engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, overrides: { ctx: 65536 }, trigger: 'manual' })
  assert.equal(opts.litertLmConfig?.default.max_num_tokens, 32770)
})

test('on a GPU the user chose, a default above 4096 is reported as the runtime opens it: 4096 (not on Apple)', () => {
  const big = litertlmEntryFor('/models/big.litertlm', '/models', 1e9, 0, { nativeCtx: 0, ctxDynamic: false, defaultCtx: 8192 })
  const gpu = buildStartOpts({ entry: big, engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, overrides: { litertLm: { backend: 'gpu' } }, trigger: 'manual' })
  assert.equal(gpu.model.ctx, 4096)
  assert.equal(gpu.litertLmConfig?.default.max_num_tokens, undefined)
  const mac = buildStartOpts({ entry: big, engine: engine(), cfg: defaultConfig(), sys: { ...CPU_ONLY, os: 'darwin/arm64' }, overrides: { litertLm: { backend: 'gpu' } }, trigger: 'manual' })
  assert.equal(mac.model.ctx, 8192)
})

test('a vision bundle loads as a vision model', () => {
  const vl = litertlmEntryFor('/models/LFM2.5-VL-450M_int8.litertlm', '/models', 5e8, 0, { nativeCtx: 4098, ctxDynamic: true, defaultCtx: 4096, vision: true, audio: false })
  assert.equal(buildStartOpts({ entry: vl, engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, trigger: 'manual' }).model.vision, true)
})
