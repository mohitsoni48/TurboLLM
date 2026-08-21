import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import type { HelloResponse } from './types'

function mkDeps(keys: ApiKey[]): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: keys, links: [], daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc' },
  }
  return {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps
}

function key(raw: string, caps?: string[], models?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never, models } } : {}),
  }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

test('hello returns the machine identity, versions, and the granted capabilities', async () => {
  const d = mkDeps([key('tllm-a', ['models:use', 'models:wake'])])
  const res = await app(d).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' },
  })
  assert.equal(res.status, 200)
  const body = await res.json() as HelloResponse
  assert.equal(body.machineId, 'machine-abc')
  assert.equal(body.appVersion, '1.11.2')
  assert.ok(body.linkApiVersions.includes(1))
  assert.deepEqual(body.capabilities, ['models:use', 'models:wake'])
})

test('hello reports the model allowlist only when the grant narrows it', async () => {
  const narrowed = mkDeps([key('tllm-a', ['models:use'], ['qwen3-35b'])])
  const b1 = await (await app(narrowed).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' },
  })).json() as HelloResponse
  assert.deepEqual(b1.models, ['qwen3-35b'])

  const open = mkDeps([key('tllm-a', ['models:use'])])
  const b2 = await (await app(open).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' },
  })).json() as HelloResponse
  assert.equal(b2.models, undefined)
})

test('a legacy full-access key reports the complete capability set, not an empty one', async () => {
  // Otherwise linking with an old key would grey out every control on the peer.
  const d = mkDeps([key('tllm-legacy')])
  const body = await (await app(d).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-legacy' },
  })).json() as HelloResponse
  assert.ok(body.capabilities.includes('models:use'))
  assert.ok(body.capabilities.includes('config:write'))
})

test('hello refuses a keyless caller — the façade exempts nothing', async () => {
  const res = await app(mkDeps([])).request('/api/link/v1/hello', { method: 'POST' })
  assert.equal(res.status, 401)
})

test('hello never leaks the token, its hash, or the host key list', async () => {
  const d = mkDeps([key('tllm-a', ['models:use'])])
  const res = await app(d).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' },
  })
  const text = await res.text()
  assert.ok(!text.includes('tllm-a'))
  assert.ok(!text.includes('hash'))
  assert.ok(!text.includes('apiKeys'))
})

test('mount order: an open LAN with no key still cannot reach the façade', async () => {
  // R2 guard. Testing linkAuth in isolation proves nothing about the REAL app, where
  // lanAuth runs first and would happily wave this request through. This drives the
  // actual composed middleware chain in the same order server.ts uses.
  const { lanAuth } = await import('../auth')
  const d = mkDeps([])
  ;(d.store.snapshot() as unknown as Record<string, unknown>).daemon = { lanBind: true, requireApiKey: false }
  const a = new Hono()
  a.use('*', lanAuth(d))
  registerLinkApi(a, d)
  const res = await a.request('/api/link/v1/hello', { method: 'POST' })
  assert.equal(res.status, 401)
})
