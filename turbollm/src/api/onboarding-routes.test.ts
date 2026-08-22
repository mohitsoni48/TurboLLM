import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOnboardingPatch, hardwareFactsFromSysInfo } from './onboarding-routes'
import type { SysInfo } from '../sysinfo/sysinfo'

test('applyOnboardingPatch: setting a profile leaves status pending', () => {
  const out = applyOnboardingPatch(
    { status: 'pending', profile: null, completedAt: null, schemaVersion: 1, everLoadedModel: false },
    { profile: 'pro' },
    1000,
  )
  assert.equal(out.profile, 'pro')
  assert.equal(out.status, 'pending')
  assert.equal(out.completedAt, null)
})

test('applyOnboardingPatch: completing stamps completedAt', () => {
  const out = applyOnboardingPatch(
    { status: 'pending', profile: 'casual', completedAt: null, schemaVersion: 1, everLoadedModel: false },
    { status: 'completed' },
    1000,
  )
  assert.equal(out.completedAt, 1000)
})

test('applyOnboardingPatch: an invalid profile is rejected, not stored', () => {
  const out = applyOnboardingPatch(
    { status: 'pending', profile: 'casual', completedAt: null, schemaVersion: 1, everLoadedModel: false },
    { profile: 'hacker' },
    1000,
  )
  assert.equal(out.profile, 'casual')
})

test('applyOnboardingPatch: skipping does not stamp completedAt', () => {
  const out = applyOnboardingPatch(
    { status: 'pending', profile: null, completedAt: null, schemaVersion: 1, everLoadedModel: false },
    { status: 'skipped' },
    1000,
  )
  assert.equal(out.status, 'skipped')
  assert.equal(out.completedAt, null)
})

test('applyOnboardingPatch: everLoadedModel is not a client-settable field — a patch cannot flip it', () => {
  const out = applyOnboardingPatch(
    { status: 'pending', profile: null, completedAt: null, schemaVersion: 1, everLoadedModel: false },
    // OnboardingPatch has no everLoadedModel field at all, so this cast simulates
    // a hand-crafted request body trying to smuggle one in.
    { status: 'completed', everLoadedModel: true } as never,
    1000,
  )
  assert.equal(out.everLoadedModel, false)
})

// ---- hardwareFactsFromSysInfo ------------------------------------------------
// Onboarding used to size the machine from gpus[0], so a dual-GPU box resolved its model
// recommendation against ONE card and was offered a model it could hold twice over. The
// budget has to match gpuBudgetMb, which sums every card for the default layer split.

function sys(gpus: Array<{ vramMb: number; vendor?: string; unified?: boolean }>, ramMB = 64000): SysInfo {
  return {
    os: 'linux/x64', cpu: 'test', cores: 16, ramMB,
    gpus: gpus.map((g, i) => ({
      name: `gpu${i}`, vramMb: g.vramMb,
      vendor: (g.vendor ?? 'nvidia') as SysInfo['gpus'][number]['vendor'],
      ...(g.unified === undefined ? {} : { unified: g.unified }),
    })),
  } as SysInfo
}

test('hardwareFactsFromSysInfo: dual-GPU pools both cards, not just the first', () => {
  const hw = hardwareFactsFromSysInfo(sys([{ vramMb: 15360 }, { vramMb: 15360 }]))
  assert.equal(hw.usableVramMb, 30720, 'a 2x15 GB box must size as 30 GB, not 15')
})

test('hardwareFactsFromSysInfo: single GPU is unchanged', () => {
  assert.equal(hardwareFactsFromSysInfo(sys([{ vramMb: 24000 }])).usableVramMb, 24000)
})

test('hardwareFactsFromSysInfo: CPU-only reports no VRAM', () => {
  assert.equal(hardwareFactsFromSysInfo(sys([])).usableVramMb, 0)
})

test('hardwareFactsFromSysInfo: a non-primary-vendor GPU does not inflate the budget', () => {
  // An Intel iGPU beside an NVIDIA dGPU is common and cannot be offloaded to.
  const hw = hardwareFactsFromSysInfo(sys([{ vramMb: 16384 }, { vramMb: 8192, vendor: 'intel' }]))
  assert.equal(hw.usableVramMb, 16384)
})

test('hardwareFactsFromSysInfo: still reports unified memory when present', () => {
  assert.equal(hardwareFactsFromSysInfo(sys([{ vramMb: 32000, vendor: 'apple', unified: true }])).unifiedMemory, true)
})
