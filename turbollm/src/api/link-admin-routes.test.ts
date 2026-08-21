import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerLinkAdminRoutes } from './link-admin-routes'
import { decodeLinkString, encodeLinkString } from '../link/link-string'
import { LINK_PRESETS } from '../link/capabilities'
import { Emitter } from '../telemetry/emit'
import { readQueue } from '../telemetry/queue'
import type { Deps } from '../deps'

function mkApp(fetchImpl?: typeof fetch, telemetry?: Emitter, daemon?: Record<string, unknown>) {
  const cfg: Record<string, unknown> = {
    apiKeys: [], links: [], daemon: { port: 6996, ...daemon },
  }
  const d = {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    ...(telemetry ? { telemetry } : {}),
  } as unknown as Deps
  const app = new Hono()
  registerLinkAdminRoutes(app, d, { fetchImpl })
  return { app, cfg }
}

/** Real `Emitter` over a temp data dir, at `anon` consent — same convention as
 *  `telemetry/emit.test.ts`'s `makeEmitter`. Returns the dir so a test can read
 *  back exactly what was queued via `readQueue`. */
function mkTelemetry(): { telemetry: Emitter; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-link-admin-telemetry-'))
  const cfg = { telemetry: { level: 'anon', machineId: '33333333-3333-3333-3333-333333333333' } }
  const telemetry = new Emitter({
    dataDir: dir,
    store: { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as never,
    version: '1.11.2',
    os: 'win32/x64',
  })
  return { telemetry, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const json = (body: unknown) => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('mint creates a granted key and reveals the raw token exactly once', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }))
  assert.equal(res.status, 200)
  const body = await res.json() as { linkString: string }
  const token = decodeLinkString(body.linkString)!.token
  assert.ok(token.startsWith('tllm-'))
  const keys = cfg.apiKeys as { name: string; grant: { capabilities: string[] }; hash: string }[]
  assert.equal(keys.length, 1)
  assert.deepEqual(keys[0].grant.capabilities, ['models:use'])
  // Only the hash is persisted — the raw token can never be re-shown, same rule as
  // every other key in the product.
  assert.ok(!JSON.stringify(cfg.apiKeys).includes(token))
})

test('mint reveals the raw token in ONE field only — linkString, never a second copy', async () => {
  const { app } = mkApp()
  const res = await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }))
  const body = await res.json() as Record<string, unknown>
  const token = decodeLinkString(body.linkString as string)!.token
  // The one-time reveal surface is exactly one field. A `token` sibling was a second
  // copy of the same secret on the wire that no caller ever read.
  assert.deepEqual(Object.keys(body).sort(), ['keyId', 'linkString'])
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'linkString') assert.ok(!String(v).includes(token), `${k} must not carry the raw token`)
  }
})

test('the minted link string decodes back to a usable url and token', async () => {
  const { app } = mkApp()
  const body = await (await app.request('/api/v1/links/mint',
    json({ name: 'laptop', capabilities: ['models:use'] }))).json() as { linkString: string }
  const decoded = decodeLinkString(body.linkString)
  assert.ok(decoded)
  assert.ok(decoded!.token.startsWith('tllm-'))
  assert.ok(decoded!.baseUrl.startsWith('http'))
})

test('mint refuses an unknown capability instead of storing it', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint', json({ name: 'x', capabilities: ['engines:add'] }))
  assert.equal(res.status, 400)
  assert.equal((cfg.apiKeys as unknown[]).length, 0)
})

test('mint refuses an empty capability list — a token that can do nothing is a bug, not a config', async () => {
  const { app } = mkApp()
  assert.equal((await app.request('/api/v1/links/mint', json({ name: 'x', capabilities: [] }))).status, 400)
})

test('adding a link from a valid link string stores it and probes once', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app, cfg } = mkApp(hello)
  const s = encodeLinkString('http://192.168.1.9:6996', 'tllm-abc')
  const res = await app.request('/api/v1/links', json({ linkString: s }))
  assert.equal(res.status, 200)
  const links = cfg.links as { name: string; status: string; grantedCapabilities: string[] }[]
  assert.equal(links.length, 1)
  assert.equal(links[0].name, 'workstation')
  assert.equal(links[0].status, 'online')
  assert.deepEqual(links[0].grantedCapabilities, ['models:use'])
})

test('adding a link with a junk string is a 400, not a crash or a stored record', async () => {
  const { app, cfg } = mkApp()
  assert.equal((await app.request('/api/v1/links', json({ linkString: 'garbage' }))).status, 400)
  assert.equal((cfg.links as unknown[]).length, 0)
})

test('an unreachable host is still stored, so the user can fix the URL later', async () => {
  // Kaggle hands back a new tunnel URL every session; a link must survive its host
  // being down, or the relink flow becomes delete-and-recreate.
  const { app, cfg } = mkApp(async () => { throw new TypeError('fetch failed') })
  const s = encodeLinkString('http://dead:6996', 'tllm-abc')
  assert.equal((await app.request('/api/v1/links', json({ linkString: s }))).status, 200)
  const links = cfg.links as { status: string }[]
  assert.equal(links[0].status, 'unreachable')
})

test('PATCH updates the baseUrl and re-probes — the Kaggle relink path', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'kaggle', appVersion: '1', linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app, cfg } = mkApp(hello)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://old:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  const res = await app.request(`/api/v1/links/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://new-tunnel.trycloudflare.com' }),
  })
  assert.equal(res.status, 200)
  const l = (cfg.links as { baseUrl: string; status: string }[])[0]
  assert.equal(l.baseUrl, 'https://new-tunnel.trycloudflare.com')
  assert.equal(l.status, 'online')
})

test('DELETE removes the link', async () => {
  const { app, cfg } = mkApp(async () => { throw new Error('x') })
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  assert.equal((await app.request(`/api/v1/links/${id}`, { method: 'DELETE' })).status, 200)
  assert.equal((cfg.links as unknown[]).length, 0)
})

test('GET /api/v1/links lists stored links for the settings UI', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app } = mkApp(hello)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-a') }))
  const res = await app.request('/api/v1/links')
  assert.equal(res.status, 200)
  const body = await res.json() as { links: { name: string; status: string }[] }
  assert.equal(body.links.length, 1)
  assert.equal(body.links[0].name, 'workstation')
  assert.equal(body.links[0].status, 'online')
})

// ── Regression coverage: the raw peer token must never reach the browser. `token` on
// `LinkRecord` is a live bearer credential this machine presents to the host — distinct
// from mint's one-time reveal of a FRESH token. These assert on the raw response TEXT,
// not a parsed/typed object, so a nested or renamed occurrence can't slip past a
// narrowly-typed assertion.

test('POST /api/v1/links never echoes the raw token back to the browser', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app } = mkApp(hello)
  const res = await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-secret-abc') }))
  const text = await res.text()
  assert.ok(!text.includes('tllm-secret-abc'))
  assert.ok(!text.includes('"token"'))
})

test('PATCH /api/v1/links/:id never echoes the raw token back to the browser', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'kaggle', appVersion: '1', linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app, cfg } = mkApp(hello)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://old:6996', 'tllm-secret-xyz') }))
  const id = (cfg.links as { id: string }[])[0].id
  const res = await app.request(`/api/v1/links/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://new-tunnel.trycloudflare.com' }),
  })
  const text = await res.text()
  assert.ok(!text.includes('tllm-secret-xyz'))
  assert.ok(!text.includes('"token"'))
})

test('GET /api/v1/links never echoes any stored raw token back to the browser', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app } = mkApp(hello)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-secret-list') }))
  const res = await app.request('/api/v1/links')
  const text = await res.text()
  assert.ok(!text.includes('tllm-secret-list'))
  assert.ok(!text.includes('"token"'))
})

test('inbound lists granted keys with their capabilities and last-used, never a hash', async () => {
  const { app } = mkApp()
  await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }))
  const res = await app.request('/api/v1/links/inbound')
  const body = await res.text()
  assert.ok(body.includes('laptop'))
  assert.ok(body.includes('models:use'))
  assert.ok(!body.includes('hash'))
})

// ── Regression coverage: review findings on `models` validation and the
// machineId-change latch (see apply-probe.ts).

test('mint refuses a bare string for models instead of storing it (substring-matching escalation)', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint',
    json({ name: 'x', capabilities: ['models:use'], models: 'somesubstring' }))
  assert.equal(res.status, 400)
  assert.equal((cfg.apiKeys as unknown[]).length, 0)
})

test('mint refuses a number for models', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint',
    json({ name: 'x', capabilities: ['models:use'], models: 42 }))
  assert.equal(res.status, 400)
  assert.equal((cfg.apiKeys as unknown[]).length, 0)
})

test('mint refuses an array containing a non-string element for models', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint',
    json({ name: 'x', capabilities: ['models:use'], models: ['qwen3', 42] }))
  assert.equal(res.status, 400)
  assert.equal((cfg.apiKeys as unknown[]).length, 0)
})

test('mint accepts an empty array for models — legal, means "all models"', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint',
    json({ name: 'x', capabilities: ['models:use'], models: [] }))
  assert.equal(res.status, 200)
  const keys = cfg.apiKeys as { grant: { models?: string[] } }[]
  assert.equal(keys.length, 1)
  assert.equal(keys[0].grant.models, undefined)
})

test('mint accepts a valid array of model keys for models', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint',
    json({ name: 'x', capabilities: ['models:use'], models: ['qwen3-30b'] }))
  assert.equal(res.status, 200)
  const keys = cfg.apiKeys as { grant: { models?: string[] } }[]
  assert.deepEqual(keys[0].grant.models, ['qwen3-30b'])
})

test('PATCH re-probe flags a machineId change instead of silently adopting it — the Kaggle relink path', async () => {
  // A reused tunnel hostname must not let a stranger's daemon quietly inherit a link
  // the user believes points at their own workstation (LinkManager.probeOnce enforces
  // the same latch; the admin route must share the exact same logic, not a copy).
  const first = async () => new Response(JSON.stringify({
    machineId: 'ORIGINAL', machineName: 'workstation', appVersion: '1', linkApiVersions: [1],
    capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app, cfg } = mkApp(first)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://old:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  assert.equal((cfg.links as { machineId: string | null }[])[0].machineId, 'ORIGINAL')

  // Re-register routes against the SAME cfg/store, now with a hello() answering as a
  // different machineId — exactly what a reused Kaggle tunnel hostname looks like — and
  // drive the PATCH re-probe through it.
  const second = async () => new Response(JSON.stringify({
    machineId: 'DIFFERENT', machineName: 'stranger', appVersion: '1', linkApiVersions: [1],
    capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const appPatched = new Hono()
  registerLinkAdminRoutes(appPatched, {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps, { fetchImpl: second })
  const res = await appPatched.request(`/api/v1/links/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://new-tunnel.trycloudflare.com' }),
  })
  assert.equal(res.status, 200)
  const l = (cfg.links as { machineId: string | null; lastError: string | null }[])[0]
  assert.equal(l.machineId, 'DIFFERENT')
  assert.match(l.lastError ?? '', /different machine/i)
})

// ── Telemetry (Task 11): link_minted / link_added ───────────────────────────

test('mint emits link_minted with the capability count, never the token or capability names', async () => {
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { app } = mkApp(undefined, telemetry)
    await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use', 'models:load'] }))
    const events = readQueue(dir).map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    const minted = events.filter((e) => e.event === 'link_minted')
    assert.equal(minted.length, 1)
    assert.deepEqual(minted[0].payload, { capabilityCount: 2 })
    const text = JSON.stringify(events)
    assert.ok(!text.includes('tllm-'))
    assert.ok(!/models:/.test(text))
  } finally {
    cleanup()
  }
})

// Regression guard for the review finding: the mint route's telemetry-preset
// validation must accept EXACTLY the domain preset names (`link/capabilities.ts`'s
// `LINK_PRESETS`, the record actually used to expand a preset into capabilities), not
// a separately-hand-maintained copy. If a fourth preset were ever added there without
// this test, it would fail here rather than silently drift out of validation.
test('mint accepts a preset name for every real domain preset, and echoes it into link_minted', async () => {
  for (const presetName of Object.keys(LINK_PRESETS)) {
    const { telemetry, dir, cleanup } = mkTelemetry()
    try {
      const { app } = mkApp(undefined, telemetry)
      const caps = LINK_PRESETS[presetName as keyof typeof LINK_PRESETS]
      const res = await app.request('/api/v1/links/mint', json({ name: 'x', capabilities: caps, preset: presetName }))
      assert.equal(res.status, 200)
      const minted = readQueue(dir)
        .map((q) => q.event as { event: string; payload?: Record<string, unknown> })
        .filter((e) => e.event === 'link_minted')
      assert.equal(minted.length, 1)
      assert.deepEqual(minted[0].payload, { capabilityCount: caps.length, preset: presetName })
    } finally {
      cleanup()
    }
  }
})

test('mint drops an unrecognized preset name instead of forwarding it to telemetry', async () => {
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { app } = mkApp(undefined, telemetry)
    const res = await app.request('/api/v1/links/mint',
      json({ name: 'x', capabilities: ['models:use'], preset: 'made-up-preset' }))
    assert.equal(res.status, 200)
    const minted = readQueue(dir)
      .map((q) => q.event as { event: string; payload?: Record<string, unknown> })
      .filter((e) => e.event === 'link_minted')
    assert.equal(minted.length, 1)
    assert.deepEqual(minted[0].payload, { capabilityCount: 1 }, 'no preset field at all — never a made-up value')
  } finally {
    cleanup()
  }
})

test('mint with no telemetry deps is a no-op, not a crash', async () => {
  const { app } = mkApp()
  const res = await app.request('/api/v1/links/mint', json({ name: 'x', capabilities: ['models:use'] }))
  assert.equal(res.status, 200)
})

test('adding an unreachable link emits link_added with outcome "unreachable"', async () => {
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { app } = mkApp(async () => { throw new TypeError('fetch failed') }, telemetry)
    await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://dead:6996', 'tllm-abc') }))
    const events = readQueue(dir).map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    const added = events.filter((e) => e.event === 'link_added')
    assert.equal(added.length, 1)
    assert.deepEqual(added[0].payload, { outcome: 'unreachable' })
    const text = JSON.stringify(events)
    assert.ok(!text.includes('tllm-'))
    assert.ok(!text.includes('dead:6996'))
  } finally {
    cleanup()
  }
})

test('adding an online link emits link_added with outcome "online"', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'workstation', appVersion: '1.11.2',
    linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { telemetry, dir, cleanup } = mkTelemetry()
  try {
    const { app } = mkApp(hello, telemetry)
    await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-abc') }))
    const events = readQueue(dir).map((q) => q.event as { event: string; payload?: Record<string, unknown> })
    const added = events.filter((e) => e.event === 'link_added')
    assert.equal(added.length, 1)
    assert.deepEqual(added[0].payload, { outcome: 'online' })
  } finally {
    cleanup()
  }
})

test('adding a link with no telemetry deps is a no-op, not a crash', async () => {
  const { app } = mkApp(async () => { throw new TypeError('fetch failed') })
  const res = await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://dead:6996', 'tllm-abc') }))
  assert.equal(res.status, 200)
})

// ── Host gate (ADR-376 final review, C-1) ───────────────────────────────────────────
//
// The attack: lanBind=true + requireApiKey=false is the documented "open LAN" posture,
// and `lanAuth`'s bypassesAuth lets ANY non-tunneled caller through it with no credential
// at all. Ungated, POST /api/v1/links/mint then handed that stranger a real, permanent
// ApiKey — one that keeps working after the user later turns requireApiKey ON. That is
// the exact self-escalation `keysHostGate` was added to stop on POST /api/v1/keys.
//
// `app.request()` provides no connection info, so `isLoopback` cannot determine an
// address and fails CLOSED while LAN-exposed — i.e. these requests are treated as the
// remote stranger they represent, the same convention as keys-network.test.ts.
const OPEN_LAN = { lanBind: true, requireApiKey: false }
const LOCKED_LAN = { lanBind: true, requireApiKey: true }

const GATED_ROUTES: { label: string; path: string; init?: RequestInit }[] = [
  { label: 'POST /api/v1/links/mint', path: '/api/v1/links/mint', init: json({ name: 'x', capabilities: ['models:use'] }) },
  { label: 'GET /api/v1/links/inbound', path: '/api/v1/links/inbound' },
  { label: 'GET /api/v1/links', path: '/api/v1/links' },
  { label: 'POST /api/v1/links', path: '/api/v1/links', init: json({ linkString: encodeLinkString('http://h:6996', 'tllm-abc') }) },
  { label: 'PATCH /api/v1/links/:id', path: '/api/v1/links/some-id', init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' } },
  { label: 'DELETE /api/v1/links/:id', path: '/api/v1/links/some-id', init: { method: 'DELETE' } },
]

for (const route of GATED_ROUTES) {
  test(`${route.label} refuses an unauthenticated open-LAN caller`, async () => {
    const { app, cfg } = mkApp(undefined, undefined, OPEN_LAN)
    const res = await app.request(route.path, route.init)
    assert.equal(res.status, 403)
    const body = await res.json() as { error: { code: string } }
    assert.equal(body.error.code, 'forbidden')
    // The critical half: nothing was created. A 403 that still minted a key would be
    // the same escalation with a worse status code.
    assert.deepEqual(cfg.apiKeys, [])
    assert.deepEqual(cfg.links, [])
  })

  test(`${route.label} is allowed once "Require an API key" is on (lanAuth verified the key first)`, async () => {
    const { app } = mkApp(async () => { throw new TypeError('fetch failed') }, undefined, LOCKED_LAN)
    const res = await app.request(route.path, route.init)
    assert.notEqual(res.status, 403)
  })
}

test('an open-LAN stranger cannot mint a key that would outlive the open-LAN posture', async () => {
  const { app, cfg } = mkApp(undefined, undefined, OPEN_LAN)
  await app.request('/api/v1/links/mint', json({ name: 'attacker', capabilities: [...LINK_PRESETS.full] }))
  // The whole point of the gate: no durable credential exists to keep working after the
  // user turns requireApiKey on.
  assert.equal((cfg.apiKeys as unknown[]).length, 0)
})

// ── Probe must not clobber a user-set name (final review, I-3) ───────────────────────

const helloWith = (name: string, machineId: () => string) => async () => new Response(JSON.stringify({
  machineId: machineId(), machineName: name, appVersion: '1.11.2',
  linkApiVersions: [1], capabilities: ['models:use'],
}), { status: 200, headers: { 'content-type': 'application/json' } })

test('PATCH { name } survives the re-probe instead of being reverted by the host', async () => {
  const { app, cfg } = mkApp(helloWith('TurboLLM', () => 'm1'))
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-abc') }))
  const id = (cfg.links as { id: string }[])[0].id
  const res = await app.request(`/api/v1/links/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kaggle box' }),
  })
  const body = await res.json() as { link: { name: string } }
  assert.equal(body.link.name, 'kaggle box')
  assert.equal((cfg.links as { name: string }[])[0].name, 'kaggle box')
})

test('the FIRST handshake still seeds the name from the host, so a link is not left named after its URL', async () => {
  const { app, cfg } = mkApp(helloWith('workstation', () => 'm1'))
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-abc') }))
  assert.equal((cfg.links as { name: string }[])[0].name, 'workstation')
})

// ── The machineId-change latch (final review, I-5) ───────────────────────────────────

test('a machineId change latches into machineIdChanged and a later good probe does NOT clear it', async () => {
  let machine = 'm1'
  const { app, cfg } = mkApp(helloWith('workstation', () => machine))
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-abc') }))
  const id = (cfg.links as { id: string }[])[0].id

  machine = 'stranger'
  await app.request(`/api/v1/links/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal((cfg.links as { machineIdChanged?: boolean }[])[0].machineIdChanged, true)

  // The bug this replaces: the next successful probe saw machineId already adopted and
  // wiped the warning, so the anti-hijack signal lived for at most one poll interval.
  const again = await app.request(`/api/v1/links/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
  const body = await again.json() as { link: { machineIdChanged: boolean; lastError: string | null } }
  assert.equal(body.link.machineIdChanged, true)
  assert.ok(body.link.lastError?.includes('different machine'))
})

test('only an explicit acknowledgement clears the machineId latch', async () => {
  let machine = 'm1'
  const { app, cfg } = mkApp(helloWith('workstation', () => machine))
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-abc') }))
  const id = (cfg.links as { id: string }[])[0].id
  machine = 'stranger'
  await app.request(`/api/v1/links/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })

  const res = await app.request(`/api/v1/links/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ acknowledgeMachineChange: true }),
  })
  const body = await res.json() as { link: { machineIdChanged: boolean; lastError: string | null } }
  assert.equal(body.link.machineIdChanged, false)
  assert.equal(body.link.lastError, null)
})

// ── Peer side: the remote model catalog the chat picker groups by machine (task 8) ──────
//
// The picker's grouping is pure and tested in `web/src/lib/remote-models.test.ts`; this is
// the one route that feeds it. It is a thin read over `RemoteCatalog`, which already
// re-checks each link's LIVE status on every call — so an offline machine contributes
// nothing here without this route needing its own copy of that rule.

function mkCatalogApp(rows: unknown[], daemon?: Record<string, unknown>) {
  const cfg: Record<string, unknown> = { apiKeys: [], links: [], daemon: { port: 6996, ...daemon } }
  const d = {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    remoteCatalog: { models: () => rows },
  } as unknown as Deps
  const app = new Hono()
  registerLinkAdminRoutes(app, d)
  return app
}

const ROW = {
  linkId: 'lnk1',
  machine: 'workstation',
  model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', nativeCtx: 262144, vision: false, loaded: true },
}

test('GET /api/v1/links/models returns the catalog rows the picker groups by machine', async () => {
  const res = await mkCatalogApp([ROW]).request('/api/v1/links/models')
  assert.equal(res.status, 200)
  const body = await res.json() as { models: typeof ROW[] }
  assert.deepEqual(body.models, [ROW])
})

test('GET /api/v1/links/models is empty, not an error, when nothing is linked', async () => {
  const res = await mkCatalogApp([]).request('/api/v1/links/models')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { models: [] })
})

test('GET /api/v1/links/models never discloses the host filesystem or a link token', async () => {
  // Same rule as GET /api/link/v1/models on the host: no `path`, and certainly no
  // credential. Asserted on the serialized text so a nested field cannot slip past.
  const res = await mkCatalogApp([ROW]).request('/api/v1/links/models')
  const text = await res.text()
  assert.ok(!text.includes('path'))
  assert.ok(!text.includes('tllm-'))
  assert.ok(!text.includes('baseUrl'))
})

test('GET /api/v1/links/models carries the same host gate as the rest of this surface', async () => {
  // Without the gate, an open-LAN stranger reads the full inventory of every machine this
  // box links to — the same disclosure `GET /api/v1/links` is gated for.
  const app = mkCatalogApp([ROW], { lanBind: true, requireApiKey: false })
  const res = await app.request('/api/v1/links/models', { headers: { 'x-forwarded-for': '10.0.0.9' } })
  assert.equal(res.status, 403)
})

// ── Link names are a routing surface, not decoration (final-review C-2 / M-1) ──────────
// A link's display name is the machine segment of every qualified `<machine>/<model>` id.
// A `/` in it turns `lab/rig/Qwen3-35B` into machine `lab` (parseRemoteId splits on the
// FIRST slash), which names no link, so the id falls through to the router's LOCAL
// substring resolution and a local model answers with the wrong weights and no error.

test('a hostile machineName from the handshake cannot carry the id separator', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'lab/rig', appVersion: '1', linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app, cfg } = mkApp(hello)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-a') }))
  const l = (cfg.links as { name: string }[])[0]
  assert.equal(l.name, 'lab-rig')
  assert.ok(!l.name.includes('/'))
})

test('two hosts reporting the SAME machineName get distinct link names', async () => {
  const hello = async () => new Response(JSON.stringify({
    machineId: 'm1', machineName: 'kaggle', appVersion: '1', linkApiVersions: [1], capabilities: ['models:use'],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { app, cfg } = mkApp(hello)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://a:6996', 'tllm-a') }))
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://b:6996', 'tllm-b') }))
  const names = (cfg.links as { name: string }[]).map((l) => l.name)
  assert.deepEqual(names, ['kaggle', 'kaggle (2)'])
})

test('PATCH refuses a name containing the id separator instead of storing it', async () => {
  const { app, cfg } = mkApp(async () => { throw new Error('x') })
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  const before = (cfg.links as { name: string }[])[0].name
  for (const bad of ['lab/rig', 'lab\\rig', '   ']) {
    const res = await app.request(`/api/v1/links/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: bad }),
    })
    assert.equal(res.status, 400)
  }
  assert.equal((cfg.links as { name: string }[])[0].name, before)
})

test('PATCH refuses a name another link already answers to', async () => {
  const { app, cfg } = mkApp(async () => { throw new Error('x') })
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://a:6996', 'tllm-a') }))
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://b:6996', 'tllm-b') }))
  const links = cfg.links as { id: string; name: string }[]
  const res = await app.request(`/api/v1/links/${links[1].id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: links[0].name.toUpperCase() }),
  })
  assert.equal(res.status, 400)
  assert.notEqual(links[1].name.toLowerCase(), links[0].name.toLowerCase())
})

// ── The peer can finally READ a host's live state (final-review I-5) ───────────────────
// `LinkClient.status()` and the host's GET /api/link/v1/status both existed and nothing
// called either, so the phase's "live t/s and context-meter parity" claim rested on code
// with no consumer. This is that consumer.

const HOST_STATUS = {
  engine: { id: 'e1', name: 'llama.cpp', kind: 'llama.cpp', state: 'running', port: 8081, pid: 4242 },
  model: { key: 'qwen3-35b', name: 'Qwen3 35B', quant: 'Q4_K_M', ctx: 262144, vision: false },
  engineStats: { tps: 42 },
  liveGeneration: { phase: 'gen', pct: 0, outputTokens: 7 },
}

test("GET /api/v1/links/:id/status returns the host's own status shape, untranslated", async () => {
  const responder = async (url: string) => new Response(
    JSON.stringify(String(url).endsWith('/hello')
      ? { machineId: 'm1', machineName: 'rig', appVersion: '1', linkApiVersions: [1], capabilities: ['models:use'] }
      : HOST_STATUS),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
  const { app, cfg } = mkApp(responder as unknown as typeof fetch)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  const res = await app.request(`/api/v1/links/${id}/status`)
  assert.equal(res.status, 200)
  const body = await res.json() as { status: typeof HOST_STATUS }
  assert.deepEqual(body.status, HOST_STATUS)
  // No host filesystem detail crosses: the shared builder has no launchCommand and no
  // engine.error log tail, so neither can appear here.
  const text = JSON.stringify(body)
  assert.ok(!text.includes('launchCommand'))
  assert.ok(!text.includes('logTail'))
})

test('a host that does not answer is a typed 503 naming it, never an empty success', async () => {
  // An empty-but-200 body renders as "the machine is idle", which sends the user
  // debugging the wrong box.
  const { app, cfg } = mkApp(async () => { throw new TypeError('fetch failed') })
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://dead:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  const res = await app.request(`/api/v1/links/${id}/status`)
  assert.equal(res.status, 503)
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'unavailable')
  assert.match(body.error.message, /did not answer/)
})

test("a token without models:use is reported as a permission problem, not a dead host", async () => {
  const responder = async (url: string) => (String(url).endsWith('/hello')
    ? new Response(
        JSON.stringify({ machineId: 'm1', machineName: 'rig', appVersion: '1', linkApiVersions: [1], capabilities: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    : new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }))
  const { app, cfg } = mkApp(responder as unknown as typeof fetch)
  await app.request('/api/v1/links', json({ linkString: encodeLinkString('http://h:6996', 'tllm-a') }))
  const id = (cfg.links as { id: string }[])[0].id
  const res = await app.request(`/api/v1/links/${id}/status`)
  assert.equal(res.status, 503)
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'forbidden')
})

test('an unknown link id is a 404, not a probe of nothing', async () => {
  const { app } = mkApp()
  assert.equal((await app.request('/api/v1/links/nope/status')).status, 404)
})

// ── A grant is only a boundary if there IS a boundary (final-review I-2) ───────────────
// On lanBind + requireApiKey off, `bypassesAuth` waves LAN traffic through before any
// credential is examined, so a peer reaches this machine's PUBLIC /v1/chat/completions —
// full auto-swap path, loading and evicting models — without presenting the link token at
// all. The grant refusal never runs, and "Inference only" is a label rather than a limit.

/** Hono env shaped like @hono/node-server's, so `getConnInfo` sees a loopback caller —
 *  i.e. the OWNER at the keyboard, who clears `hostGate` even on an open LAN. That is the
 *  only caller for whom the open-LAN mint gate is the deciding check. */
const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never

test('minting is refused while this machine is open on the LAN', async () => {
  const { app, cfg } = mkApp(undefined, undefined, { lanBind: true, requireApiKey: false })
  const res = await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }), LOOPBACK_ENV)
  assert.equal(res.status, 409)
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'open_lan')
  // Actionable, and it names the switch — the settings UI surfaces this sentence verbatim.
  assert.match(body.error.message, /Require an API key/)
  // A token that silently means nothing is worse than one that was never minted.
  assert.equal((cfg.apiKeys as unknown[]).length, 0)
})

test('minting works again once a key is required', async () => {
  const { app, cfg } = mkApp(undefined, undefined, { lanBind: true, requireApiKey: true })
  assert.equal((await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }), LOOPBACK_ENV)).status, 200)
  assert.equal((cfg.apiKeys as unknown[]).length, 1)
})

test('a loopback-only daemon can still mint — there is no open LAN to close', async () => {
  // With lanBind off nothing reaches this box from another machine except through a
  // tunnel, and a tunneled request always enforces (bypassesAuth ignores requireApiKey
  // for it). The gate would be pure friction here.
  const { app } = mkApp(undefined, undefined, { lanBind: false, requireApiKey: false })
  assert.equal((await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }))).status, 200)
})
