// Task 7 — remote models in the peer's `GET /v1/models` (ADR-376 §1 decision 7).
//
// Local ids stay BARE and completely unchanged (gateway.models.test.ts still passes
// untouched); a linked host's models appear alongside them as qualified
// `<machine>/<model>` ids, which is exactly what ModelRouter.resolveRemote routes on.
//
// The catalog here is the REAL RemoteCatalog driven by a stub fetch, not a hand-written
// stand-in: "an offline link contributes nothing" is a property of that class's
// online-only rule, and asserting it against a fake would prove nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerGateway } from './gateway'
import { RemoteCatalog } from '../link/remote-catalog'
import type { LinkRecord, RemoteModel } from '../link/types'
import type { Deps } from '../deps'

const LIBRARY = [
  { key: 'qwen3-8b|Q4|123', name: 'Qwen3 8B' },
  { key: 'llama-3-70b|Q5|456', name: 'Llama 3 70B' },
]

function link(over: Partial<LinkRecord>): LinkRecord {
  return {
    id: 'l1', name: 'workstation', baseUrl: 'http://ws.local', token: 't', machineId: 'm1',
    grantedCapabilities: ['models:use'], linkApiVersion: 1, status: 'online',
    lastSeenAt: null, lastError: null,
    ...over,
  }
}

function remoteModel(over: Partial<RemoteModel>): RemoteModel {
  return { key: 'Qwen3-35B', name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 32768, vision: false, loaded: false, ...over }
}

/** Stub host: every link's `/api/link/v1/models` answers from `byBaseUrl`. */
function hostFetch(byBaseUrl: Record<string, RemoteModel[]>): typeof fetch {
  return (async (input: string | URL | globalThis.Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const base = Object.keys(byBaseUrl).find((b) => url.startsWith(b))
    if (!base) return new Response('nope', { status: 404 })
    return new Response(JSON.stringify({ machineName: 'ignored', models: byBaseUrl[base] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

async function catalogFor(links: LinkRecord[], byBaseUrl: Record<string, RemoteModel[]>): Promise<RemoteCatalog> {
  // Turbo Link's experimental gate is a required constructor field (remote-catalog.ts).
  // This suite asserts that remote models DO appear in /v1/models, so it runs unlocked;
  // that they vanish when the flag is off is covered by link/experimental-gate.test.ts.
  const cat = new RemoteCatalog(
    { list: () => links },
    { fetchImpl: hostFetch(byBaseUrl), isEnabled: () => true },
  )
  await cat.refresh()
  return cat
}

function fakeDeps(remoteCatalog?: RemoteCatalog, autoSwap = true): Deps {
  return {
    scanner: { list: () => ({ models: LIBRARY, scanning: false, lastScanAt: '' }) },
    modelRouter: { route: async () => ({ target: 'http://engine.local' }) },
    store: { snapshot: () => ({ modelDefaults: { maxTokens: 0 }, gateway: { autoSwap } }) },
    manager: { status: () => ({ state: 'stopped', model: null }), target: () => 'http://engine.local' },
    registry: { active: () => ({ kind: 'llama.cpp' }) },
    remoteCatalog,
  } as unknown as Deps
}

async function ids(d: Deps): Promise<string[]> {
  const app = new Hono()
  registerGateway(app, d)
  const res = await app.request('/v1/models', { method: 'GET' })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { data: Array<{ id: string }> }
  return body.data.map((e) => e.id)
}

test('an online link contributes its models as qualified ids, alongside the bare local ones', async () => {
  const cat = await catalogFor([link({})], { 'http://ws.local': [remoteModel({})] })
  const list = await ids(fakeDeps(cat))

  // Local ids are BARE and untouched — no migration, nothing renamed.
  assert.ok(list.includes('qwen3-8b|Q4|123'), 'bare local key still listed')
  assert.ok(list.includes('claude-qwen3-8b|Q4|123'), 'local claude- alias still listed')
  // The remote one is qualified, and only qualified.
  assert.ok(list.includes('workstation/Qwen3-35B'), 'remote model listed as <machine>/<model>')
  assert.equal(list.includes('Qwen3-35B'), false, 'a remote model must never be listed bare')
})

test('an OFFLINE link contributes nothing — a listed-but-unusable model is worse than an absent one', async () => {
  for (const status of ['unreachable', 'revoked', 'incompatible', 'unknown'] as const) {
    const cat = await catalogFor([link({ status })], { 'http://ws.local': [remoteModel({})] })
    const list = await ids(fakeDeps(cat))
    assert.equal(
      list.some((id) => id.startsWith('workstation/')),
      false,
      `a ${status} link must contribute no models`,
    )
    // …and the local library is completely unaffected by it.
    assert.ok(list.includes('qwen3-8b|Q4|123'))
  }
})

test('two hosts exposing the SAME model name produce two distinct qualified ids', async () => {
  const cat = await catalogFor(
    [
      link({ id: 'l1', name: 'workstation', baseUrl: 'http://ws.local' }),
      link({ id: 'l2', name: 'kaggle', baseUrl: 'http://kg.local' }),
    ],
    {
      'http://ws.local': [remoteModel({ key: 'Qwen3-35B' })],
      'http://kg.local': [remoteModel({ key: 'Qwen3-35B' })],
    },
  )
  const list = await ids(fakeDeps(cat))
  assert.ok(list.includes('workstation/Qwen3-35B'))
  assert.ok(list.includes('kaggle/Qwen3-35B'))
  assert.equal(new Set(list).size, list.length, 'every advertised id is unique')
})

test('with no catalog wired at all, /v1/models is exactly the pre-Turbo-Link list', async () => {
  const list = await ids(fakeDeps(undefined))
  assert.deepEqual(list, [
    'qwen3-8b|Q4|123', 'claude-qwen3-8b|Q4|123',
    'llama-3-70b|Q5|456', 'claude-llama-3-70b|Q5|456',
  ])
})

test('remote models are advertised even when local auto-swap is off', async () => {
  // autoSwap gates the local `claude-` alias because picking one always needs a local
  // swap. A remote model needs no local swap at all, so that gate does not apply to it.
  const cat = await catalogFor([link({})], { 'http://ws.local': [remoteModel({})] })
  const list = await ids(fakeDeps(cat, false))
  assert.equal(list.includes('claude-qwen3-8b|Q4|123'), false)
  assert.ok(list.includes('workstation/Qwen3-35B'))
})
