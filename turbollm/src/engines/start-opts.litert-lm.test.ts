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

test('without a GPU the config selects the cpu backend whatever the GPU-layers setting', () => {
  const opts = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: CPU_ONLY, overrides: { ngl: 99 }, trigger: 'resume' })
  assert.equal(opts.litertLmConfig?.default.backend, 'cpu')
})

test('with a GPU and GPU layers the config selects the gpu backend; zero layers falls back to cpu', () => {
  const gpu = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: WITH_GPU, overrides: { ngl: 99 }, trigger: 'manual' })
  assert.equal(gpu.litertLmConfig?.default.backend, 'gpu')
  const cpu = buildStartOpts({ entry: entry(), engine: engine(), cfg: defaultConfig(), sys: WITH_GPU, overrides: { ngl: 0 }, trigger: 'manual' })
  assert.equal(cpu.litertLmConfig?.default.backend, 'cpu')
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
})
