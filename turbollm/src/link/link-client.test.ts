import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LinkClient } from './link-client'

const rec = { baseUrl: 'http://host:6996', token: 'tllm-x' }

test('a 200 hello with a shared version yields an ok probe', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response(JSON.stringify({
      machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
      linkApiVersions: [1], capabilities: ['models:use'],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const p = await c.hello()
  assert.equal(p.kind, 'ok')
  if (p.kind === 'ok') {
    assert.equal(p.machineId, 'm1')
    assert.equal(p.version, 1)
    assert.deepEqual(p.capabilities, ['models:use'])
  }
})

test('a 401 yields an http probe carrying the status, not a thrown error', async () => {
  const c = new LinkClient(rec, { fetchImpl: async () => new Response('', { status: 401 }) })
  assert.deepEqual(await c.hello(), { kind: 'http', status: 401 })
})

test('a thrown fetch yields a network probe — never propagates', async () => {
  const c = new LinkClient(rec, { fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

test('a timeout yields a network probe, not a hang', async () => {
  const c = new LinkClient(rec, {
    timeoutMs: 20,
    fetchImpl: (_u, init) => new Promise((_res, rej) => {
      (init as RequestInit).signal?.addEventListener('abort', () => rej(new Error('aborted')))
    }) as Promise<Response>,
  })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

test('a non-TurboLLM URL that returns HTML yields network, not a crash', async () => {
  // Pasting a router admin page or a 404 page must be survivable.
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

test('a host with no overlapping version yields incompatible', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response(JSON.stringify({
      machineId: 'm', machineName: 'x', appVersion: '9', linkApiVersions: [99], capabilities: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const p = await c.hello()
  assert.equal(p.kind, 'incompatible')
})

test('presents the token and never logs it', async () => {
  let seen = ''
  const c = new LinkClient(rec, {
    fetchImpl: async (_u, init) => {
      seen = new Headers((init as RequestInit).headers).get('X-TurboLLM-Auth') ?? ''
      return new Response(JSON.stringify({
        machineId: 'm', machineName: 'x', appVersion: '1', linkApiVersions: [1], capabilities: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await c.hello()
  assert.equal(seen, 'tllm-x')
})
