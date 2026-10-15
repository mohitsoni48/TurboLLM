// GET /api/v1/connect/:cli replaces a CLI key on a LAN-bound daemon, and a cross-site <img> needs
// no preflight, so lanAuth (auth.ts) refuses it without the X-TurboLLM-UI header the web UI sends
// (api.ts getConnect). That only holds while no other site may send the header: /api's CORS
// (server.ts) must never allow it in a preflight. Drives the REAL createApp, since what matters is
// the CORS config and lanAuth together.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server'
import type { Deps } from './deps'

function mkDeps(): Deps {
  // Same minimal double as server.app-proof.test.ts, plus the manager the connect route reads.
  const cfg: Record<string, unknown> = {
    apiKeys: [],
    links: [],
    daemon: { lanBind: false, requireApiKey: true, machineId: 'machine-test', port: 6996 },
  }
  return {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '.' },
    db: new Proxy({}, { get: () => () => [] }),
    telemetry: { firstUse: () => {}, useFeature: () => {} },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
}

const LOOPBACK = { incoming: { socket: { localAddress: '127.0.0.1', localPort: 6996, remoteAddress: '127.0.0.1', remotePort: 55555, remoteFamily: 'IPv4' } } }

test('GET /api/v1/connect/:cli: no other site may send the X-TurboLLM-UI header it requires', async () => {
  const app = createApp(mkDeps())
  for (const origin of ['https://turbollm.dev', 'https://evil.example']) {
    const res = await app.request('/api/v1/connect/claude-code', {
      method: 'OPTIONS',
      headers: { Host: '127.0.0.1:6996', Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-turbollm-ui' },
    }, LOOPBACK as never)
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/)
    assert.ok(!allowed.includes('x-turbollm-ui') && !allowed.includes('*'), `${origin}: ${allowed}`)
  }

  // Through the whole stack: the UI's request works, the same GET without the header doesn't.
  const get = (headers: Record<string, string>) =>
    app.request('/api/v1/connect/claude-code', { headers: { Host: '127.0.0.1:6996', ...headers } }, LOOPBACK as never)
  assert.equal((await get({})).status, 403)
  assert.equal((await get({ 'Sec-Fetch-Site': 'same-origin', 'X-TurboLLM-UI': '1' })).status, 200)
})
