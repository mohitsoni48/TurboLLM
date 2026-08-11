import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOnboarding, ONBOARDING_SCHEMA_VERSION } from './state'

test('normalizeOnboarding: absent config yields a pending, profile-less state', () => {
  assert.deepEqual(normalizeOnboarding(undefined), {
    status: 'pending', profile: null, completedAt: null, schemaVersion: ONBOARDING_SCHEMA_VERSION,
    everLoadedModel: false,
  })
})

test('normalizeOnboarding: everLoadedModel only ever becomes true from a literal boolean true', () => {
  assert.equal(normalizeOnboarding({ everLoadedModel: 'true' }).everLoadedModel, false)
  assert.equal(normalizeOnboarding({ everLoadedModel: 1 }).everLoadedModel, false)
  assert.equal(normalizeOnboarding({ everLoadedModel: true }).everLoadedModel, true)
})

test('normalizeOnboarding: an unknown status falls back to pending, never throws', () => {
  const out = normalizeOnboarding({ status: 'banana', profile: 'pro' })
  assert.equal(out.status, 'pending')
  assert.equal(out.profile, 'pro')
})

test('normalizeOnboarding: an unknown profile is dropped to null', () => {
  assert.equal(normalizeOnboarding({ status: 'completed', profile: 'wizard' }).profile, null)
})

test('normalizeOnboarding: a valid state round-trips unchanged', () => {
  const s = { status: 'completed', profile: 'casual', completedAt: 1234, schemaVersion: 1, everLoadedModel: true }
  assert.deepEqual(normalizeOnboarding(s), s)
})
