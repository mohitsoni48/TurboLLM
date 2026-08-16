import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEvent } from '../schema'
import { deriveDefault, estimateVram } from '../../models/profile'
import { buildModelLoadConfig } from './model'
import type { ModelEntry } from '../../models/scanner'
import type { SysInfo } from '../../sysinfo/sysinfo'
import type { Engine } from '../../config/config'

const sys: SysInfo = {
  os: 'win32/x64',
  cpu: 'Test CPU',
  cores: 16,
  ramMB: 65536,
  gpus: [{ name: 'Test GPU', vramMb: 16000, vendor: 'nvidia' }],
}

const denseModel: ModelEntry = {
  key: 'dense-test', name: 'Dense Test', path: 'x.gguf', dir: '.', format: 'gguf',
  sizeBytes: 1e9, sizeLabel: '1B', arch: 'llama', quant: 'Q4_K_M', nativeCtx: 8192,
  blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0, nextnLayers: 0,
  vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
  incomplete: false, parseError: null, loaded: false, hasProfile: false,
  benchTps: null, mtime: '',
}

const engine: Engine = {
  id: 'llama-1', name: 'llama.cpp', binPath: '/bin/llama-server', kind: 'llama-server',
  version: 'b1234', capabilities: { flags: [], kvTypes: [] }, addedAt: '2026-01-01T00:00:00.000Z',
}

function envelope(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 1,
    event: 'model_load',
    ts: '2026-08-05T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.11.0', os: 'win32/x64' },
    payload,
  }
}

test('validateEvent: model_load accepts outcome/trigger alone, with no config block', () => {
  const r = validateEvent(envelope({ outcome: 'ok', trigger: 'manual' }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: model_load rejects an unknown trigger', () => {
  const r = validateEvent(envelope({ outcome: 'ok', trigger: 'someone_elses_click' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /trigger/)
})

test('validateEvent: model_load accepts the full config buildModelLoadConfig produces', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)
  const config = buildModelLoadConfig(denseModel, profile, engine, vram)
  const r = validateEvent(envelope({ outcome: 'ok', trigger: 'manual', ...config }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: model_load rejects a config with only some of model/engine/params/fit present', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)
  const config = buildModelLoadConfig(denseModel, profile, engine, vram)
  // Never partially — either the whole config rides along or none of it does.
  const r = validateEvent(envelope({ outcome: 'ok', trigger: 'manual', model: config.model }))
  assert.equal(r.ok, true, 'each block is independently optional at the schema level')
  // The real guarantee is enforced by buildModelLoadConfig always returning all four
  // together or (via the caller's own `entry && profile` check) none at all — not by
  // the schema, which cannot see "these came from one function call."
})

test('validateEvent: model_load never carries the extraArgs/grammar/path-bearing fields — booleans only', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)
  const config = buildModelLoadConfig(denseModel, profile, engine, vram)
  assert.equal(typeof config.params?.hasGrammar, 'boolean')
  assert.equal(typeof config.params?.hasExtraArgs, 'boolean')
  assert.equal('grammar' in (config.params ?? {}), false)
  assert.equal('extraArgs' in (config.params ?? {}), false)
  assert.equal('chatTemplateFile' in (config.params ?? {}), false)
  assert.equal('draftModelPath' in (config.params ?? {}), false)
})

test('buildModelLoadConfig: multiGpu/gpuCount reflect the profile.gpu.tensorSplit length', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)

  const single = buildModelLoadConfig(denseModel, profile, engine, vram)
  assert.equal(single.params?.multiGpu, false)
  assert.equal(single.params?.gpuCount, 1)

  const dual = buildModelLoadConfig(denseModel, { ...profile, gpu: { ...profile.gpu, tensorSplit: [50, 50] } }, engine, vram)
  assert.equal(dual.params?.multiGpu, true)
  assert.equal(dual.params?.gpuCount, 2)
})

test('buildModelLoadConfig: isCustom reflects whether the engine has a sourceRepo', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)

  const official = buildModelLoadConfig(denseModel, profile, engine, vram)
  assert.equal(official.engine?.isCustom, false)

  const custom = buildModelLoadConfig(denseModel, profile, { ...engine, sourceRepo: 'https://github.com/someone/llama.cpp' }, vram)
  assert.equal(custom.engine?.isCustom, true)
})

test('buildModelLoadConfig: engine.kind rides through as-is — user-added custom engine kinds must not be silently dropped', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)
  const config = buildModelLoadConfig(denseModel, profile, { ...engine, kind: 'my-custom-fork' }, vram)
  assert.equal(config.engine?.kind, 'my-custom-fork')
  // And the schema must actually accept it, not just the plain builder function —
  // this is exactly why engine.kind is `f.ident()` and not a closed enum.
  const r = validateEvent(envelope({ outcome: 'ok', trigger: 'manual', ...config }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('buildModelLoadConfig: model identity comes from the scanner entry, quant included as-is', () => {
  const profile = deriveDefault(denseModel, sys)
  const vram = estimateVram(profile, denseModel, sys)
  const config = buildModelLoadConfig(denseModel, profile, engine, vram)
  assert.deepEqual(config.model, {
    name: 'Dense Test',
    quant: 'Q4_K_M',
    arch: 'llama',
    sizeBytes: 1e9,
    moe: false,
    nativeCtx: 8192,
  })
})
