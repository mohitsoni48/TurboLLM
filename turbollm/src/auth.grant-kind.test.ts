import test from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from './deps'
import { grantKind, verifyKeyValue, hashKey, isFacadeOnlyKey, requiredCapability } from './auth'
import { defaultConfig } from './config/config'

const KEY = 'tllm-abcdefghijklmnopqrstuvwxyz0123456789ABCD'

const depsWithKey = (grant: unknown): Deps => {
  const cfg = defaultConfig()
  cfg.apiKeys.push({
    id: 'k1', name: 'test', hash: hashKey(KEY), prefix: KEY.slice(0, 12),
    createdAt: '2026-09-10T00:00:00Z', lastUsedAt: null,
    ...(grant === undefined ? {} : { grant }),
  } as never)
  return { store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } } as unknown as Deps
}

test('grantKind: no grant is an ordinary full-access key', () => {
  assert.equal(grantKind({ grant: undefined }), 'none')
})

test('grantKind: a grant with no kind is a LINK grant — every pre-ADR-422 key', () => {
  assert.equal(grantKind({ grant: { capabilities: ['models:use'] } } as never), 'link')
})

test('grantKind: an explicit remote kind is a remote grant', () => {
  assert.equal(grantKind({ grant: { kind: 'remote', capabilities: ['models:use'] } } as never), 'remote')
})

test('isFacadeOnlyKey still means "carries any grant" — ext/auth.ts depends on that', () => {
  assert.equal(isFacadeOnlyKey({ grant: { kind: 'remote', capabilities: [] } } as never), true)
  assert.equal(isFacadeOnlyKey({ grant: { capabilities: [] } } as never), true)
  assert.equal(isFacadeOnlyKey({ grant: undefined }), false)
})

test('verifyKeyValue: an ungranted key works everywhere, as before', () => {
  assert.equal(verifyKeyValue(KEY, depsWithKey(undefined)), true)
  assert.equal(verifyKeyValue(KEY, depsWithKey(undefined), { ingress: true }), true)
})

test('verifyKeyValue: a LINK grant is refused even on ingress (ADR-376 rule, unchanged)', () => {
  const d = depsWithKey({ capabilities: ['models:use'] })
  assert.equal(verifyKeyValue(KEY, d), false)
  assert.equal(verifyKeyValue(KEY, d, { ingress: true }), false)
})

test('verifyKeyValue: a REMOTE grant is refused OFF the ingress socket', () => {
  const d = depsWithKey({ kind: 'remote', capabilities: ['models:use'] })
  assert.equal(verifyKeyValue(KEY, d), false)
})

test('verifyKeyValue: a REMOTE grant is accepted ON the ingress socket', () => {
  const d = depsWithKey({ kind: 'remote', capabilities: ['models:use'] })
  assert.equal(verifyKeyValue(KEY, d, { ingress: true }), true)
})

test('requiredCapability: inference needs models:use', () => {
  assert.equal(requiredCapability('POST', '/v1/chat/completions'), 'models:use')
  assert.equal(requiredCapability('GET', '/v1/models'), 'models:use')
})

test('requiredCapability: config reads and writes are separate capabilities', () => {
  assert.equal(requiredCapability('GET', '/api/v1/settings'), 'config:read')
  assert.equal(requiredCapability('PATCH', '/api/v1/settings'), 'config:write')
})

test('requiredCapability: downloads split read from write', () => {
  assert.equal(requiredCapability('GET', '/api/v1/downloads'), 'downloads:read')
  assert.equal(requiredCapability('POST', '/api/v1/downloads'), 'downloads:write')
})

test('requiredCapability: an unmapped path yields null, which callers must treat as DENY', () => {
  assert.equal(requiredCapability('POST', '/api/v1/engines/scan'), null)
})
