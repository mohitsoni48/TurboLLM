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
  // A host that accepts the connection and then never answers — the realistic failure the
  // timeout exists for. The fake settles ONLY when the client's own abort signal fires, so
  // this really is the timeout path and not just "a fetch that rejects" (covered above).
  //
  // The keepalive timer is load-bearing, not defensive padding. `AbortSignal.timeout()`
  // unrefs its timer by design — a daemon poll must never hold the process open — so with
  // nothing else pending the event loop drains before the abort can fire, the promise never
  // settles, and node:test kills the whole file ("Promise resolution is still pending but
  // the event loop has already resolved"). One ordinary, ref'd timer pins the loop open for
  // the few ms this single request can take. It RESOLVES rather than rejects so that a
  // regression which stops the abort from ever firing fails the assertion below loudly
  // instead of quietly yielding the `network` the test wanted anyway.
  const c = new LinkClient(rec, {
    timeoutMs: 20,
    fetchImpl: (_u, init) => new Promise<Response>((res, rej) => {
      const keepalive = setTimeout(() => res(new Response(JSON.stringify({
        machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
        linkApiVersions: [1], capabilities: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } })), 2000)
      ;(init as RequestInit).signal?.addEventListener('abort', () => {
        clearTimeout(keepalive)
        rej(new Error('aborted'))
      })
    }),
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

test('a 200 application/json body of literal null yields network, not a throw', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

test('a 200 application/json body that is an array yields network, not a throw', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

test('a 200 application/json body that is a bare string yields network, not a throw', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response('"hi"', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

test('a 200 application/json body that is a bare number yields network, not a throw', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response('42', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await c.hello(), { kind: 'network' })
})

// ── config()/writeConfig() (spec §5.8). Task 6 is the intended consumer; these pin the
//    contract now so it cannot drift before that lands. ────────────────────────────────

test('config() returns the host projection unchanged, and never re-validates its shape', async () => {
  const c = new LinkClient(rec, {
    fetchImpl: async () => new Response(
      JSON.stringify({ config: { modelDefaults: { ctx: 8192 }, somethingNewTheHostAdded: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  })
  const p = await c.config()
  assert.equal(p.kind, 'config')
  // Handed back whole: a peer-side shape filter would be a second copy of the host's
  // allowlist that goes stale the day the host adds a field.
  if (p.kind === 'config') {
    assert.deepEqual(p.config, { modelDefaults: { ctx: 8192 }, somethingNewTheHostAdded: 1 })
  }
})

test('config() on a 403 (no config:read) is an http probe, NOT an empty config', async () => {
  // "We do not know this host's settings" must never render as "the host has no settings".
  const c = new LinkClient(rec, { fetchImpl: async () => new Response('', { status: 403 }) })
  assert.deepEqual(await c.config(), { kind: 'http', status: 403 })
})

test('config() rejects a garbage shape rather than adopting it', async () => {
  for (const body of ['{}', '{"config":null}', '{"config":[]}', '{"config":"nope"}']) {
    const c = new LinkClient(rec, {
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    })
    assert.deepEqual(await c.config(), { kind: 'network' }, body)
  }
})

test('writeConfig() sends the patch under `patch` and does not pre-filter it', async () => {
  // The HOST holds the allowlist. A peer-side filter would be a second copy of it, so an
  // out-of-scope path must go out on the wire and come back as the host's own 403.
  let sent: { method?: string; body?: string } = {}
  const c = new LinkClient(rec, {
    fetchImpl: async (_u, init) => {
      const i = init as RequestInit
      sent = { method: i.method, body: i.body as string }
      return new Response('', { status: 403 })
    },
  })
  assert.deepEqual(await c.writeConfig({ apiKeys: [] }), { kind: 'http', status: 403 })
  assert.equal(sent.method, 'PATCH')
  assert.deepEqual(JSON.parse(sent.body!), { patch: { apiKeys: [] } })
})

test('writeConfig() reports accepted on a 200, and never throws on a dead host', async () => {
  const ok = new LinkClient(rec, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, applied: ['gateway.keepN'] }),
      { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await ok.writeConfig({ 'gateway.keepN': 2 }), { kind: 'accepted' })

  const dead = new LinkClient(rec, { fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(await dead.writeConfig({ 'gateway.keepN': 2 }), { kind: 'network' })
})
