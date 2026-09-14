import test from 'node:test'
import assert from 'node:assert/strict'
import type { Deps } from '../deps'
import { provisionRemoteApiKey, revokeRemoteKeys } from '../auth'
import { grantKind } from '../auth'
import { defaultConfig } from '../config/config'

const deps = (): Deps => {
  const cfg = defaultConfig()
  return { store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } } as unknown as Deps
}

test('token: minting stores only a hash and returns the raw value once', () => {
  const d = deps()
  const raw = provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  assert.equal(raw.startsWith('tllm-'), true)
  const stored = d.store.snapshot().apiKeys.at(-1)!
  assert.equal(stored.hash.length, 64)
  assert.equal(JSON.stringify(stored).includes(raw), false)
})

test('token: the minted key carries a remote-kind grant, not a link one', () => {
  const d = deps()
  provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  assert.equal(grantKind(d.store.snapshot().apiKeys.at(-1)!), 'remote')
})

test('token: it is named so a user can find it in Developer -> API Keys', () => {
  const d = deps()
  provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  assert.equal(d.store.snapshot().apiKeys.at(-1)!.name.startsWith('remote-'), true)
})

test('token: revoking removes remote keys and leaves every other key alone', () => {
  const d = deps()
  d.store.update((c) => c.apiKeys.push({ id: 'plain', name: 'mine', hash: 'a'.repeat(64), prefix: 'tllm-xxxxxxx', createdAt: '', lastUsedAt: null } as never))
  provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  provisionRemoteApiKey(d, { kind: 'remote', capabilities: ['models:use'] })
  assert.equal(revokeRemoteKeys(d), 2)
  const left = d.store.snapshot().apiKeys
  assert.equal(left.length, 1)
  assert.equal(left[0].id, 'plain')
})

test('token: revoking never touches a Turbo Link grant', () => {
  const d = deps()
  d.store.update((c) => c.apiKeys.push({ id: 'peer', name: 'laptop', hash: 'b'.repeat(64), prefix: 'tllm-yyyyyyy', createdAt: '', lastUsedAt: null, grant: { capabilities: ['models:use'] } } as never))
  assert.equal(revokeRemoteKeys(d), 0)
  assert.equal(d.store.snapshot().apiKeys.length, 1)
})
