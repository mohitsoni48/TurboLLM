// A saved profile holds only what the user set. The model dialog used to save its whole draft, seeded from the resolved
// profile, so the built-in defaults it held (context 8192, GPU layers 99, the llama.cpp sampling 0.8/0.95/40/0.05)
// became the user's choice the first time anything was saved. What the dialog, presets and auto-tune save now is marked
// userSetOnly; what an earlier build saved is read field by field against the automatic profile (userSetProfile).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automaticProfile, configuredCtx, mergeUserSet, resolveProfile, userSetProfile, type LoadProfile } from './profile'
import { defaultConfig, setModelProfile } from '../config/config'
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
const DEFAULTS = { ctx: 8192, ngl: 99, imageMaxTokens: 0, maxTokens: 0 }

test('a profile an earlier build saved whole keeps only what differs from the automatic profile', () => {
  const auto = automaticProfile(model(), SYS, DEFAULTS)
  // What the old dialog stored after the user changed only Flash attention and Temperature.
  const whole: LoadProfile = { ...auto, flashAttn: 'off', sampling: { ...auto.sampling, temp: 0.3 }, extraArgs: [] }
  assert.deepEqual(userSetProfile(whole, auto), { flashAttn: 'off', sampling: { temp: 0.3 } })
})

test('a profile marked userSetOnly is the user\'s in every field, a default-equal one included', () => {
  const auto = automaticProfile(model(), SYS, DEFAULTS)
  const mine = { ctx: 8192, sampling: { temp: 0.8 }, userSetOnly: true } as Partial<LoadProfile>
  assert.deepEqual(userSetProfile(mine, auto), { ctx: 8192, sampling: { temp: 0.8 } })
})

test('tunedBy is kept: provenance, not a setting', () => {
  const auto = automaticProfile(model(), SYS, DEFAULTS)
  assert.deepEqual(userSetProfile({ ...auto, ngl: 20, tunedBy: 'bench' }, auto), { ngl: 20, tunedBy: 'bench' })
})

test('a later Model Defaults change reaches a model saved with only what the user set, as it did not with the whole draft', () => {
  const m = model()
  const before = automaticProfile(m, SYS, DEFAULTS)
  const oldWhole: Partial<LoadProfile> = { ...before, flashAttn: 'off' }
  const mine: Partial<LoadProfile> = { flashAttn: 'off', userSetOnly: true }
  const raised = { ...DEFAULTS, ctx: 16384 }
  assert.equal(resolveProfile(m, SYS, oldWhole, undefined, raised).ctx, 8192, 'the whole draft pinned the context of the day')
  assert.equal(resolveProfile(m, SYS, mine, undefined, raised).ctx, 16384)
  assert.equal(resolveProfile(m, SYS, mine, undefined, raised).flashAttn, 'off')
})

test('the resolved profile never carries the marker', () => {
  const r = resolveProfile(model(), SYS, { userSetOnly: true, ctx: 4096 }, { userSetOnly: true, ngl: 3 }, DEFAULTS)
  assert.equal('userSetOnly' in r, false)
  assert.equal(r.ctx, 4096)
  assert.equal(r.ngl, 3)
})

test('mergeUserSet merges the groups key by key', () => {
  assert.deepEqual(
    mergeUserSet({ ctx: 6000, sampling: { temp: 0.5 } as LoadProfile['sampling'] }, { sampling: { topK: 20 } as LoadProfile['sampling'], ngl: 1 }),
    { ctx: 6000, ngl: 1, sampling: { temp: 0.5, topK: 20 } },
  )
})

test('configuredCtx: the context a model saved without one would load with, not its ceiling', () => {
  const m = model()
  const cfg = defaultConfig()
  assert.equal(configuredCtx(cfg, m, 'e1', SYS), undefined, 'no profile: unknown, as before')
  setModelProfile(cfg, m.key, 'e1', { flashAttn: 'off', userSetOnly: true })
  assert.equal(configuredCtx(cfg, m, 'e1', SYS), 8192)
  setModelProfile(cfg, m.key, 'e1', { ctx: 20000, userSetOnly: true })
  assert.equal(configuredCtx(cfg, m, 'e1', SYS), 20000)
  assert.equal(configuredCtx(cfg, m, '', SYS), undefined)
})
