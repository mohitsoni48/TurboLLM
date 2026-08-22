import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteCatalog } from './remote-catalog'
import type { LinkRecord } from './types'

const link = (over: Partial<LinkRecord> = {}): LinkRecord => ({
  id: 'l1', name: 'workstation', baseUrl: 'https://ws.example', token: 'tllm-secret',
  machineId: 'm1', grantedCapabilities: ['models:use'], linkApiVersion: 1,
  status: 'online', lastSeenAt: null, lastError: null, ...over,
})

/** Construct the catalog with Turbo Link's experimental gate ON.
 *
 *  `isEnabled` is a REQUIRED constructor field (remote-catalog.ts): a missing gate must be
 *  a compile error, not a silently enabled feature. This suite predates the gate and is
 *  about the catalog's own caching/filtering, so it runs unlocked; the gate itself is
 *  covered by experimental-gate.test.ts. */
function mkCatalog(
  src: { list: () => LinkRecord[] },
  opts: Omit<ConstructorParameters<typeof RemoteCatalog>[1], 'isEnabled'> = {},
) {
  return new RemoteCatalog(src, { ...opts, isEnabled: () => true })
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** A fetch that answers /api/link/v1/models per base URL. Anything not listed 404s. */
function fetchFor(byBase: Record<string, unknown>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input)
    for (const [base, body] of Object.entries(byBase)) {
      if (url === `${base}/api/link/v1/models`) return json(body)
    }
    return new Response('nope', { status: 404 })
  }) as typeof fetch
}

/** A mutable link list, standing in for LinkManager.list(). */
function source(records: LinkRecord[]) {
  const state = { records }
  return { src: { list: () => state.records }, state }
}

test('refresh never throws when the host is unreachable', async () => {
  const { src } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
  })
  await cat.refresh() // must not reject
  assert.deepEqual(cat.models(), [])
  assert.equal(cat.modelOn('l1', 'Qwen3-35B'), undefined)
})

test('refresh never throws on a 200 with a nonsense body', async () => {
  const { src } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({ 'https://ws.example': { machineName: 'ws', models: 'not-an-array' } }),
  })
  await cat.refresh()
  assert.deepEqual(cat.models(), [])
})

test('refresh caches an online link\'s models', async () => {
  const { src } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({
      'https://ws.example': {
        machineName: 'workstation',
        models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true }],
      },
    }),
  })
  await cat.refresh()
  const rows = cat.models()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.linkId, 'l1')
  assert.equal(rows[0]!.machine, 'workstation')
  assert.equal(rows[0]!.model.key, 'Qwen3-35B')
  assert.equal(rows[0]!.model.loaded, true)
})

test('models are dropped the moment a link\'s status leaves online', async () => {
  const { src, state } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({
      'https://ws.example': { machineName: 'workstation', models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    }),
  })
  await cat.refresh()
  assert.equal(cat.modelOn('l1', 'Qwen3-35B')?.key, 'Qwen3-35B')

  // The poll loop marks it unreachable. A stale cache must NOT keep answering — this is
  // the exact hazard that would let an offline machine look available.
  state.records = [link({ status: 'unreachable' })]
  assert.equal(cat.modelOn('l1', 'Qwen3-35B'), undefined)
  assert.deepEqual(cat.models(), [])

  // …and the cache entry is genuinely evicted, not merely hidden.
  await cat.refresh()
  state.records = [link({ status: 'online' })]
  assert.equal(cat.modelOn('l1', 'Qwen3-35B'), undefined)
})

test('a link removed from the list drops its cached models', async () => {
  const { src, state } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({
      'https://ws.example': { machineName: 'workstation', models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    }),
  })
  await cat.refresh()
  state.records = []
  await cat.refresh()
  assert.deepEqual(cat.models(), [])
  assert.equal(cat.modelOn('l1', 'Qwen3-35B'), undefined)
})

test('modelOn is EXACT — never a substring or case-insensitive match', async () => {
  const { src } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({
      'https://ws.example': { machineName: 'workstation', models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    }),
  })
  await cat.refresh()
  assert.equal(cat.modelOn('l1', 'Qwen3-35B')?.key, 'Qwen3-35B')
  assert.equal(cat.modelOn('l1', 'Qwen3'), undefined)
  assert.equal(cat.modelOn('l1', 'qwen3-35b'), undefined)
  assert.equal(cat.modelOn('l1', 'Qwen3-35B-Instruct'), undefined)
  assert.equal(cat.modelOn('nope', 'Qwen3-35B'), undefined)
})

test('linkByName is case-insensitive and reads the live record', async () => {
  const { src, state } = source([link()])
  const cat = mkCatalog(src)
  assert.equal(cat.linkByName('WORKSTATION')?.id, 'l1')
  assert.equal(cat.linkByName('workstation')?.id, 'l1')
  assert.equal(cat.linkByName('work')?.id, undefined) // exact name, not a prefix
  state.records = [link({ name: 'studio' })]
  assert.equal(cat.linkByName('workstation'), undefined)
  assert.equal(cat.linkByName('Studio')?.id, 'l1')
})

test('two machines exposing the same model name stay distinct', async () => {
  const { src } = source([
    link(),
    link({ id: 'l2', name: 'kaggle', baseUrl: 'https://kg.example', token: 'tllm-other' }),
  ])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({
      'https://ws.example': { machineName: 'workstation', models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
      'https://kg.example': { machineName: 'kaggle', models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    }),
  })
  await cat.refresh()
  const rows = cat.models()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.machine).sort(), ['kaggle', 'workstation'])
  assert.deepEqual(rows.map((r) => r.linkId).sort(), ['l1', 'l2'])
  // Each machine answers only for itself.
  assert.equal(cat.modelOn('l1', 'Qwen3-35B')?.key, 'Qwen3-35B')
  assert.equal(cat.modelOn('l2', 'Qwen3-35B')?.key, 'Qwen3-35B')
  assert.equal(cat.linkByName('kaggle')?.baseUrl, 'https://kg.example')
})

test('a machine renamed by the user re-keys without a refresh', async () => {
  const { src, state } = source([link()])
  const cat = mkCatalog(src, {
    fetchImpl: fetchFor({
      'https://ws.example': { machineName: 'workstation', models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B' }] },
    }),
  })
  await cat.refresh()
  assert.equal(cat.models()[0]!.machine, 'workstation')

  state.records = [link({ name: 'big-box' })]
  assert.equal(cat.models()[0]!.machine, 'big-box')
  assert.equal(cat.linkByName('big-box')?.id, 'l1')
  assert.equal(cat.linkByName('workstation'), undefined)
  // The models themselves are keyed by link id, so the rename keeps them.
  assert.equal(cat.modelOn('l1', 'Qwen3-35B')?.key, 'Qwen3-35B')
})

test('a link without models:use is never fetched', async () => {
  let calls = 0
  const { src } = source([link({ grantedCapabilities: ['config:read'] })])
  const cat = mkCatalog(src, {
    fetchImpl: (async () => { calls++; return json({ machineName: 'ws', models: [] }) }) as unknown as typeof fetch,
  })
  await cat.refresh()
  assert.equal(calls, 0)
  assert.deepEqual(cat.models(), [])
})
