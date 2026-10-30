// GitHub #288: Settings → Model defaults can set the K and V cache types, like context and GPU
// layers. They sit between the built-in heuristic (f16, q4_0 on Android) and a model's own saved
// profile, and '' is automatic.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automaticProfile, resolveProfile, type LoadProfile } from './profile'
import type { ModelEntry } from './scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

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

const SYS: SysInfo = { os: 'linux/x64', cpu: 'test', cores: 8, ramMB: 32000, gpus: [{ name: 'gpu0', vramMb: 16000, vendor: 'nvidia' }] }
const ANDROID: SysInfo = { ...SYS, os: 'android/arm64', gpus: [] }
const DEFAULTS = { ctx: 8192, ngl: 99, imageMaxTokens: 0, maxTokens: 0 }

test('with no default cache types set, a model keeps the heuristic: f16, q4_0 on Android', () => {
  const p = automaticProfile(model(), SYS, DEFAULTS)
  assert.equal(p.kvTypeK, 'f16')
  assert.equal(p.kvTypeV, 'f16')
  const a = automaticProfile(model(), ANDROID, DEFAULTS)
  assert.equal(a.kvTypeK, 'q4_0')
  assert.equal(a.kvTypeV, 'q4_0')
})

test('"" is automatic, not a cache type', () => {
  const p = automaticProfile(model(), ANDROID, { ...DEFAULTS, kvTypeK: '', kvTypeV: '' })
  assert.equal(p.kvTypeK, 'q4_0')
  assert.equal(p.kvTypeV, 'q4_0')
})

test('default K and V cache types reach a model with no saved profile, each on its own', () => {
  const p = automaticProfile(model(), SYS, { ...DEFAULTS, kvTypeK: 'q8_0', kvTypeV: 'q4_0' })
  assert.equal(p.kvTypeK, 'q8_0')
  assert.equal(p.kvTypeV, 'q4_0')
  const kOnly = automaticProfile(model(), SYS, { ...DEFAULTS, kvTypeK: 'q8_0' })
  assert.equal(kOnly.kvTypeK, 'q8_0')
  assert.equal(kOnly.kvTypeV, 'f16')
})

test('a cache type saved for the model still wins over the default', () => {
  const saved: Partial<LoadProfile> = { kvTypeK: 'f16', kvTypeV: 'q8_0', userSetOnly: true }
  const p = resolveProfile(model(), SYS, saved, undefined, { ...DEFAULTS, kvTypeK: 'q4_0', kvTypeV: 'q4_0' })
  assert.equal(p.kvTypeK, 'f16')
  assert.equal(p.kvTypeV, 'q8_0')
})

test('a saved profile that sets other fields only picks up the default cache types', () => {
  const saved: Partial<LoadProfile> = { flashAttn: 'off', userSetOnly: true }
  const p = resolveProfile(model(), SYS, saved, undefined, { ...DEFAULTS, kvTypeK: 'q8_0', kvTypeV: 'q8_0' })
  assert.equal(p.flashAttn, 'off')
  assert.equal(p.kvTypeK, 'q8_0')
  assert.equal(p.kvTypeV, 'q8_0')
})
