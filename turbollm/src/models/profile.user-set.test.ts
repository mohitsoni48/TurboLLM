// A saved profile holds only what the user set. The model dialog used to save its whole draft, seeded from the resolved
// profile, so the built-in defaults it held (context 8192, GPU layers 99, the llama.cpp sampling 0.8/0.95/40/0.05)
// became the user's choice the first time anything was saved. What the dialog, presets and auto-tune save now is marked
// userSetOnly; what an earlier build saved is read field by field against the automatic profile (userSetProfile).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automaticProfile, configuredCtx, legacySeedProfile, mergeUserSet, resolveProfile, userSetProfile, type LoadProfile } from './profile'
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

// ── a .litertlm's context: its own default unless the user set one ─────────────────────────────

const qwen3 = (): ModelEntry => model({
  key: 'qwen3|?|1', name: 'Qwen3', path: '/models/Qwen3-0.6B_dynamic.litertlm', format: 'litertlm', arch: 'litertlm',
  nativeCtx: 32770, ctxDynamic: true, defaultCtx: 4096, blockCount: 0, headCountKv: 0,
})

test('a .litertlm\'s automatic context is its own default; Settings > Model Defaults applies only once the user changed it', () => {
  assert.equal(automaticProfile(qwen3(), SYS, DEFAULTS).ctx, 4096)
  assert.equal(automaticProfile(qwen3(), SYS, { ...DEFAULTS, ctx: 16384 }).ctx, 16384)
  assert.equal(automaticProfile(qwen3(), SYS, { ...DEFAULTS, ctx: 65536 }).ctx, 32770, 'never past the longest it takes')
  assert.equal(automaticProfile(model({ format: 'litertlm', nativeCtx: 0 }), SYS, DEFAULTS).ctx, 4096, 'none declared: the runtime\'s 4096')
  assert.equal(automaticProfile(model(), SYS, DEFAULTS).ctx, 8192, 'a GGUF keeps the Model Defaults context as before')
})

test('an earlier build\'s whole profile for a .litertlm reads the old automatic 8192 as the default it was, not the user\'s', () => {
  const m = qwen3()
  const seed = legacySeedProfile(m, SYS, DEFAULTS)
  assert.equal(seed.ctx, 8192, 'min(Model Defaults 8192, the raw 32771)')
  const oldWhole: Partial<LoadProfile> = { ...seed, litertLm: { backend: 'cpu' } }
  assert.deepEqual(userSetProfile(oldWhole, seed), { litertLm: { backend: 'cpu' } })
  assert.equal(resolveProfile(m, SYS, oldWhole, undefined, DEFAULTS).ctx, 4096)
  // LFM2.5-VL's raw 4099 was its automatic context too.
  const vl = model({ format: 'litertlm', nativeCtx: 4098, ctxDynamic: true, defaultCtx: 4096 })
  assert.equal(legacySeedProfile(vl, SYS, DEFAULTS).ctx, 4099)
  assert.equal(resolveProfile(vl, SYS, { ...legacySeedProfile(vl, SYS, DEFAULTS) }, undefined, DEFAULTS).ctx, 4096)
  // A context the user moved is theirs.
  assert.equal(resolveProfile(m, SYS, { ...seed, ctx: 2048 }, undefined, DEFAULTS).ctx, 2048)
})
