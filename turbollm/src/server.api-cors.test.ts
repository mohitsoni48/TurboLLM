// /api's CORS (server.ts): https://turbollm.dev's "Suggest for my hardware" page reads
// /api/v1/sysinfo from the user's own daemon, and that is the only cross-origin read /api answers.
// The allowlist used to cover all of /api/*, so a script on turbollm.dev (a compromised deploy, an
// XSS) could read every keyless loopback GET: conversations, settings with stdio MCP env values,
// the live Code terminal ids. Drives the REAL createApp, since what matters is the CORS config in
// front of lanAuth and the routes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import { defaultConfig, type Config } from './config/config'
import type { Deps } from './deps'

function mkApp() {
  const cfg = defaultConfig()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg), dir: () => '.' },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  return createApp(d)
}

const LOOPBACK = { incoming: { socket: { localAddress: '127.0.0.1', localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } }
const SITE = 'https://turbollm.dev'

test('turbollm.dev may read /api/v1/sysinfo, preflight included; no other origin may', async () => {
  const app = mkApp()
  const get = (origin: string) =>
    app.request('/api/v1/sysinfo', { headers: { Host: '127.0.0.1:6996', Origin: origin, 'Sec-Fetch-Site': 'cross-site' } }, LOOPBACK as never)
  const res = await get(SITE)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), SITE)
  assert.equal((await get('https://evil.example')).headers.get('access-control-allow-origin'), null)

  const preflight = await app.request('/api/v1/sysinfo', {
    method: 'OPTIONS',
    headers: { Host: '127.0.0.1:6996', Origin: SITE, 'Access-Control-Request-Method': 'GET' },
  }, LOOPBACK as never)
  assert.ok(preflight.status >= 200 && preflight.status < 300, `preflight status ${preflight.status}`)
  assert.equal(preflight.headers.get('access-control-allow-origin'), SITE)
})

test('turbollm.dev gets no cross-origin read of any other /api route', async () => {
  const app = mkApp()
  for (const path of ['/api/v1/settings', '/api/v1/conversations', '/api/v1/status']) {
    const res = await app.request(path, { headers: { Host: '127.0.0.1:6996', Origin: SITE, 'Sec-Fetch-Site': 'cross-site' } }, LOOPBACK as never)
    assert.equal(res.headers.get('access-control-allow-origin'), null, path)
    // A preflight (a request with a custom header, or a JSON body) gets nothing to pass on either.
    const preflight = await app.request(path, {
      method: 'OPTIONS',
      headers: { Host: '127.0.0.1:6996', Origin: SITE, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-turbollm-auth' },
    }, LOOPBACK as never)
    assert.equal(preflight.headers.get('access-control-allow-origin'), null, `${path} preflight`)
  }
})
