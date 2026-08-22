// Turbo Link's experimental gate (`daemon.experimental.turboLink`, ADR-376 + the
// established `experimental.memory`/`routines` two-layer shape).
//
// Turbo Link is fully built but has never been verified against a real second machine, so
// it ships OFF and is opt-in. This file is the single place that pins what "off" means, in
// BOTH directions — because the interesting case is not a fresh install with the flag off,
// it is a user who linked machines, then turned the flag back off:
//
//   * the host façade must refuse (typed, not a 404 a peer would read as a version skew);
//   * the peer's admin routes must refuse;
//   * the poll loop must not poll;
//   * remote models must vanish from every surface that can route to them; and
//   * NOTHING may be deleted — every `LinkRecord` and every granted `ApiKey` stays in
//     config, so turning the flag back on restores the previous state exactly.
//
// The one behaviour that is NOT conditional on the flag is `verifyKeyValue` refusing a
// granted (link) token for the ordinary API. That is a security property, not a feature
// behaviour, and it is asserted here in both flag states so it cannot become conditional.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import { registerLinkAdminRoutes } from '../api/link-admin-routes'
import { LinkManager } from './link-manager'
import { RemoteCatalog } from './remote-catalog'
import { ModelRouter } from '../gateway/model-router'
import { verifyKeyValue } from '../auth'
import { TURBO_LINK_DISABLED_CODE, isTurboLinkEnabled } from './gate'
import type { ApiKey } from '../config/config'
import type { Deps } from '../deps'
import type { LinkRecord } from './types'

// ── fixtures ──────────────────────────────────────────────────────────────────

function key(raw: string, caps?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never } } : {}),
  }
}

const rec = (over: Partial<LinkRecord> = {}): LinkRecord => ({
  id: 'l1', name: 'workstation', baseUrl: 'http://host:6996', token: 'tllm-secret',
  machineId: 'm1', grantedCapabilities: ['models:use'], linkApiVersion: 1,
  status: 'online', lastSeenAt: null, lastError: null, ...over,
})

/** A Deps whose config carries real links, real granted keys, and an explicit flag —
 *  i.e. exactly the "already linked, then toggled" state this file is about. */
function mkDeps(turboLink: boolean, over: { keys?: ApiKey[]; links?: LinkRecord[] } = {}) {
  const cfg: Record<string, unknown> = {
    apiKeys: over.keys ?? [key('tllm-a', ['models:use', 'models:wake'])],
    links: over.links ?? [rec()],
    daemon: {
      lanBind: true,
      requireApiKey: true,
      machineId: 'machine-abc',
      experimental: { memory: false, cloudDeploy: false, routines: false, turboLink },
    },
  }
  const d = {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps
  return { d, cfg }
}

function facade(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

function admin(d: Deps) {
  const a = new Hono()
  registerLinkAdminRoutes(a, d)
  return a
}

// ── the predicate itself ──────────────────────────────────────────────────────

test('isTurboLinkEnabled reads daemon.experimental.turboLink and fails closed', () => {
  assert.equal(isTurboLinkEnabled(mkDeps(true).d), true)
  assert.equal(isTurboLinkEnabled(mkDeps(false).d), false)
  // A config shape with no `experimental` block cannot come out of normalize(), but a
  // half-written file must never read as "on".
  const bare = { store: { snapshot: () => ({ daemon: {} }) } } as unknown as Deps
  assert.equal(isTurboLinkEnabled(bare), false)
})

// ── the host façade ───────────────────────────────────────────────────────────

test('the façade refuses every route with a typed error while the flag is off', async () => {
  const { d } = mkDeps(false)
  for (const [method, path] of [
    ['POST', '/api/link/v1/hello'],
    ['GET', '/api/link/v1/models'],
    ['GET', '/api/link/v1/status'],
  ] as const) {
    const res = await facade(d).request(path, { method, headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
    assert.equal(res.status, 403, `${method} ${path}`)
    const body = await res.json() as { error: { code: string; message: string } }
    // Typed and specific: a 404 here would read to a peer as a link-API version mismatch
    // and send them hunting for an upgrade that does not exist.
    assert.equal(body.error.code, TURBO_LINK_DISABLED_CODE, `${method} ${path}`)
    assert.match(body.error.message, /Turbo Link/)
  }
})

test('the façade refuses BEFORE resolving a token — a valid link key gets no further', async () => {
  const { d } = mkDeps(false)
  const res = await facade(d).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' },
  })
  assert.equal(res.status, 403)
  const raw = await res.text()
  assert.ok(!raw.includes('machine-abc'), 'refusal must not disclose the machine identity')
  assert.ok(!raw.includes('models:use'), 'refusal must not disclose the grant')
})

test('the façade works normally with the flag on', async () => {
  const { d } = mkDeps(true)
  const res = await facade(d).request('/api/link/v1/hello', {
    method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' },
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { machineId: string }
  assert.equal(body.machineId, 'machine-abc')
})

// ── the peer's admin routes ───────────────────────────────────────────────────

const ADMIN_ROUTES: [string, string][] = [
  ['POST', '/api/v1/links/mint'],
  ['GET', '/api/v1/links/inbound'],
  ['GET', '/api/v1/links'],
  ['GET', '/api/v1/links/models'],
  ['POST', '/api/v1/links'],
  ['PATCH', '/api/v1/links/l1'],
  ['GET', '/api/v1/links/l1/status'],
  ['POST', '/api/v1/links/l1/load'],
  ['POST', '/api/v1/links/l1/unload'],
  ['GET', '/api/v1/links/l1/downloads'],
  ['POST', '/api/v1/links/l1/downloads'],
  ['DELETE', '/api/v1/links/l1/downloads/d1'],
  ['GET', '/api/v1/links/l1/config'],
  ['PATCH', '/api/v1/links/l1/config'],
  ['DELETE', '/api/v1/links/l1'],
]

test('every admin route refuses with a typed error while the flag is off', async () => {
  const { d } = mkDeps(false)
  for (const [method, path] of ADMIN_ROUTES) {
    const res = await admin(d).request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' || method === 'PATCH' ? { body: '{}' } : {}),
    })
    assert.equal(res.status, 403, `${method} ${path}`)
    const body = await res.json() as { error: { code: string } }
    assert.equal(body.error.code, TURBO_LINK_DISABLED_CODE, `${method} ${path}`)
  }
})

test('turning the flag off deletes no link and revokes no key', async () => {
  const granted = key('tllm-a', ['models:use'])
  const { d, cfg } = mkDeps(false, { keys: [granted], links: [rec(), rec({ id: 'l2', name: 'rig' })] })
  // Hit every admin route, including the destructive ones. None may touch config.
  for (const [method, path] of ADMIN_ROUTES) {
    await admin(d).request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' || method === 'PATCH' ? { body: '{}' } : {}),
    })
  }
  assert.deepEqual((cfg.links as LinkRecord[]).map((l) => l.id), ['l1', 'l2'])
  assert.equal((cfg.apiKeys as ApiKey[]).length, 1)
  assert.deepEqual((cfg.apiKeys as ApiKey[])[0].grant, { capabilities: ['models:use'] })
})

// ── the poll loop ─────────────────────────────────────────────────────────────

test('the poll loop makes no outbound request while the flag is off', async () => {
  const { d } = mkDeps(false)
  let calls = 0
  const mgr = new LinkManager(d, {
    fetchImpl: (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch,
    isEnabled: () => isTurboLinkEnabled(d),
  })
  mgr.start()
  await mgr.probeAll()
  mgr.stop()
  assert.equal(calls, 0)
})

test('the poll loop probes normally while the flag is on', async () => {
  const { d } = mkDeps(true)
  let calls = 0
  const mgr = new LinkManager(d, {
    fetchImpl: (async () => {
      calls++
      return new Response(JSON.stringify({
        machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
        linkApiVersions: [1], capabilities: ['models:use'],
      }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch,
    isEnabled: () => isTurboLinkEnabled(d),
  })
  await mgr.probeAll()
  mgr.stop()
  assert.equal(calls, 1)
})

test('the poll loop does not refresh the remote catalog while the flag is off', async () => {
  const { d } = mkDeps(false)
  let refreshes = 0
  const mgr = new LinkManager(d, {
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    catalog: { refresh: async () => { refreshes++ } },
    isEnabled: () => isTurboLinkEnabled(d),
  })
  await mgr.probeAll()
  mgr.stop()
  assert.equal(refreshes, 0)
})

// ── remote models on every surface ────────────────────────────────────────────

const MODELS_BODY = {
  machineName: 'workstation',
  models: [{ key: 'Qwen3-35B', name: 'Qwen3-35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true }],
}

function catalogFor(enabled: boolean, links: LinkRecord[]) {
  return new RemoteCatalog({ list: () => links }, {
    fetchImpl: (async () => new Response(JSON.stringify(MODELS_BODY), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
    isEnabled: () => enabled,
  })
}

test('a disabled catalog advertises nothing, even after a refresh', async () => {
  const cat = catalogFor(false, [rec()])
  await cat.refresh()
  assert.deepEqual(cat.models(), [])
  assert.equal(cat.modelOn('l1', 'Qwen3-35B'), undefined)
  assert.equal(cat.linkByName('workstation'), undefined)
})

test('disabling drops models a previously-enabled catalog had already cached', async () => {
  // The realistic toggle-off: the catalog was warm when the flag flipped.
  const links = [rec()]
  let enabled = true
  const cat = new RemoteCatalog({ list: () => links }, {
    fetchImpl: (async () => new Response(JSON.stringify(MODELS_BODY), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
    isEnabled: () => enabled,
  })
  await cat.refresh()
  assert.equal(cat.models().length, 1)
  enabled = false
  // Instantly, without waiting for a refresh — same rule as a link going offline.
  assert.deepEqual(cat.models(), [])
  assert.equal(cat.modelOn('l1', 'Qwen3-35B'), undefined)
  // And a refresh while disabled evicts the cache rather than re-filling it.
  await cat.refresh()
  enabled = true
  assert.deepEqual(cat.models(), [], 'the cache must have been evicted, not merely hidden')
})

test('ModelRouter treats a qualified id as NOT remote while the flag is off', async () => {
  const cat = catalogFor(false, [rec()])
  await cat.refresh()
  const router = new ModelRouter(
    { snapshot: () => ({ daemon: {} }) } as never, {} as never, {} as never,
    { list: () => ({ models: [] }) } as never, undefined as never, cat,
  )
  // `undefined` means "not a remote id" — resolution falls through to the local library,
  // which is the fail-closed answer: nothing is routed off this machine.
  assert.equal(router.resolveRemoteTarget('workstation/Qwen3-35B'), undefined)
})

test('ModelRouter still resolves a qualified id while the flag is on', async () => {
  const cat = catalogFor(true, [rec()])
  await cat.refresh()
  const router = new ModelRouter(
    { snapshot: () => ({ daemon: {} }) } as never, {} as never, {} as never,
    { list: () => ({ models: [] }) } as never, undefined as never, cat,
  )
  const route = router.resolveRemoteTarget('workstation/Qwen3-35B')
  assert.ok(route && 'remote' in route && route.remote, 'expected a remote route')
})

// ── the security property that is NOT a feature behaviour ─────────────────────

test('a granted (link) token stays refused by verifyKeyValue in BOTH flag states', () => {
  for (const flag of [true, false]) {
    const { d } = mkDeps(flag, { keys: [key('tllm-granted', ['models:use'])] })
    assert.equal(verifyKeyValue('tllm-granted', d), false, `flag=${flag}`)
  }
  // …while an ungranted legacy key is unaffected by the flag in either direction.
  for (const flag of [true, false]) {
    const { d } = mkDeps(flag, { keys: [key('tllm-legacy')] })
    assert.equal(verifyKeyValue('tllm-legacy', d), true, `flag=${flag}`)
  }
})

// ── the round trip: off → on again, on ONE live config ────────────────────────

test('turning the flag back on restores the fleet with no relink and no restart', async () => {
  // Everything above proves each direction from a fixture built that way. This proves the
  // TRANSITION on a single config object that is never rewritten in between: the same
  // Deps, the same already-constructed façade/manager/catalog, the flag flipped underneath
  // them. It is what "flip it in Settings and it comes back" actually means — the
  // predicates are live getters, not values read once at construction, so no daemon
  // restart is needed and, crucially, no link has to be re-established.
  const { d, cfg } = mkDeps(false)
  const flag = () => (cfg.daemon as { experimental: { turboLink: boolean } }).experimental
  const linksBefore = JSON.stringify(cfg.links)

  const app = facade(d)
  const adminApp = admin(d)
  const links = cfg.links as LinkRecord[]
  const cat = new RemoteCatalog({ list: () => links }, {
    fetchImpl: (async () => new Response(JSON.stringify(MODELS_BODY), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
    isEnabled: () => isTurboLinkEnabled(d),
  })
  let probes = 0
  const mgr = new LinkManager(d, {
    fetchImpl: (async () => { probes++; return new Response('{}') }) as unknown as typeof fetch,
    catalog: cat,
    isEnabled: () => isTurboLinkEnabled(d),
  })

  // OFF: refused everywhere, nothing polls, nothing advertised.
  const off = await app.request('/api/link/v1/hello', { method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  assert.equal(off.status, 403)
  assert.equal((await adminApp.request('/api/v1/links')).status, 403)
  await mgr.probeAll()
  await cat.refresh()
  assert.equal(probes, 0)
  assert.deepEqual(cat.models(), [])

  // ON, with nothing else touched — no relink, no new token, no config write.
  flag().turboLink = true

  const on = await app.request('/api/link/v1/hello', { method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  assert.equal(on.status, 200)
  assert.equal((await adminApp.request('/api/v1/links')).status, 200)
  await cat.refresh()
  assert.equal(cat.models().length, 1, 'remote models must come back on the first refresh')
  assert.ok(cat.linkByName('workstation'), 'the existing link must still be addressable by name')

  // OFF again — and the link the user had is still exactly the one they had at the start.
  flag().turboLink = false
  assert.equal((await app.request('/api/link/v1/hello', { method: 'POST', headers: { 'X-TurboLLM-Auth': 'tllm-a' } })).status, 403)
  assert.equal(JSON.stringify(cfg.links), linksBefore, 'no link may be added, mutated or dropped by toggling')
})
