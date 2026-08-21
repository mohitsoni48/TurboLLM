import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerLinkAdminRoutes } from './link-admin-routes'
import { decodeLinkString, encodeLinkString } from '../link/link-string'
import type { Deps } from '../deps'

function mkApp(fetchImpl?: typeof fetch) {
  const cfg: Record<string, unknown> = { apiKeys: [], links: [], daemon: { port: 6996 } }
  const d = {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
  } as unknown as Deps
  const app = new Hono()
  registerLinkAdminRoutes(app, d, { fetchImpl })
  return { app, cfg }
}

const json = (body: unknown) => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('mint creates a granted key and reveals the raw token exactly once', async () => {
  const { app, cfg } = mkApp()
  const res = await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }))
  assert.equal(res.status, 200)
  const body = await res.json() as { token: string; linkString: string }
  assert.ok(body.token.startsWith('tllm-'))
  const keys = cfg.apiKeys as { name: string; grant: { capabilities: string[] }; hash: string }[]
  assert.equal(keys.length, 1)
  assert.deepEqual(keys[0].grant.capabilities, ['models:use'])
  // Only the hash is persisted — the raw token can never be re-shown, same rule as
  // every other key in the product.
  assert.ok(!JSON.stringify(cfg.apiKeys).includes(body.token))
})

test('the minted link string decodes back to a usable url and token', async () => {
  const { app } = mkApp()
  const body = await (await app.request('/api/v1/links/mint',
    json({ name: 'laptop', capabilities: ['models:use'] }))).json() as { token: string; linkString: string }
  const decoded = decodeLinkString(body.linkString)
  assert.ok(decoded)
  assert.equal(decoded!.token, body.token)
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

test('inbound lists granted keys with their capabilities and last-used, never a hash', async () => {
  const { app } = mkApp()
  await app.request('/api/v1/links/mint', json({ name: 'laptop', capabilities: ['models:use'] }))
  const res = await app.request('/api/v1/links/inbound')
  const body = await res.text()
  assert.ok(body.includes('laptop'))
  assert.ok(body.includes('models:use'))
  assert.ok(!body.includes('hash'))
})
