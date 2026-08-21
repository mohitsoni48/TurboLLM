import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasCapability, allowsModel, LINK_PRESETS } from './capabilities'
import type { ApiKey } from '../config/config'

const base: ApiKey = { id: 'k', name: 'n', hash: 'h', prefix: 'p', createdAt: 'c', lastUsedAt: null }
const withGrant = (caps: string[], models?: string[]): ApiKey =>
  ({ ...base, grant: { capabilities: caps as never, models } })

test('a legacy key with no grant has every capability (absent = full access)', () => {
  assert.equal(hasCapability(base, 'models:use'), true)
  assert.equal(hasCapability(base, 'config:write'), true)
})

test('a granted key has only what it was granted', () => {
  const k = withGrant(['models:use'])
  assert.equal(hasCapability(k, 'models:use'), true)
  assert.equal(hasCapability(k, 'models:load'), false)
  assert.equal(hasCapability(k, 'config:write'), false)
})

test('an empty capability array grants nothing — it is NOT treated as absent', () => {
  const k = withGrant([])
  assert.equal(hasCapability(k, 'models:use'), false)
})

test('no key at all grants nothing (fails closed)', () => {
  assert.equal(hasCapability(undefined, 'models:use'), false)
})

test('an absent model allowlist means every model', () => {
  assert.equal(allowsModel(withGrant(['models:use']), 'anything'), true)
})

test('an empty model allowlist also means every model, matching the spec default', () => {
  assert.equal(allowsModel(withGrant(['models:use'], []), 'anything'), true)
})

test('a populated model allowlist is an exact-match whitelist, never a prefix match', () => {
  const k = withGrant(['models:use'], ['qwen3-35b'])
  assert.equal(allowsModel(k, 'qwen3-35b'), true)
  // Guards against the resolveEntry substring-matching hazard leaking into auth.
  assert.equal(allowsModel(k, 'qwen3-35b-uncensored'), false)
  assert.equal(allowsModel(k, 'qwen3'), false)
})

test('a legacy key with no grant may address any model', () => {
  assert.equal(allowsModel(base, 'anything'), true)
})

test('presets are ordered least- to most-privileged and never include engines', () => {
  assert.deepEqual(LINK_PRESETS.inference, ['models:use'])
  assert.ok(LINK_PRESETS.server.includes('models:wake'))
  assert.ok(LINK_PRESETS.full.includes('config:write'))
  for (const caps of Object.values(LINK_PRESETS)) {
    for (const c of caps) assert.ok(!c.startsWith('engines'))
  }
})
