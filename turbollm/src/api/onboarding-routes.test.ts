import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOnboardingPatch } from './onboarding-routes'

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
