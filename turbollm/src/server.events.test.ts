import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createApp, registerCodeRoutesIfSupported, registerSpaFallback } from './server'
import { requiredCapability } from './auth'
import type { Deps } from './deps'

const RAW_KEY = 'tllm-events-test-key'

/** The same minimal double server.route-order.test.ts boots the real app with. */
function mkDeps(): Deps {
  const db = new Proxy({}, { get: () => () => [] })
  const cfg: Record<string, unknown> = {
    apiKeys: [{
      id: 'k1', name: 'test', hash: createHash('sha256').update(RAW_KEY).digest('hex'),
      prefix: RAW_KEY.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    }],
    links: [],
    daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-test', port: 6996 },
  }
  return {
    version: 'test',
    store: { snapshot: () => cfg, read: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    db,
    telemetry: { firstUse: () => {}, useFeature: () => {} },
  } as unknown as Deps
}

async function bootedApp() {
  const d = mkDeps()
  const app = createApp(d)
  await registerCodeRoutesIfSupported(app, d)
  registerSpaFallback(app)
  return app
}

test('GET /api/v1/events is served by the real boot sequence, ahead of the SPA fallback', async () => {
  const app = await bootedApp()
  const ac = new AbortController()
  const res = await app.request('/api/v1/events', { headers: { 'X-TurboLLM-Auth': RAW_KEY }, signal: ac.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/)
  ac.abort()
  await res.body?.cancel().catch(() => {})
})

test('GET /api/v1/events sits behind lanAuth like every other /api/v1 read', async () => {
  const app = await bootedApp()
  const res = await app.request('/api/v1/events', { headers: { Host: '192.168.1.20:6996' } })
  assert.equal(res.status, 401)
})

test('a scoped remote token needs what /api/v1/status needs to hear its invalidations', () => {
  assert.equal(requiredCapability('GET', '/api/v1/events'), requiredCapability('GET', '/api/v1/status'))
  assert.equal(requiredCapability('POST', '/api/v1/events'), null)
})
