// Scalability tier 4's config-only runtime limits, exposed on GET/PATCH /api/v1/settings by item 5.3: the route stores
// a whole in-range value and answers anything else with the bound's 400. The host-only refusal is covered through the
// real app in server.settings-gate.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { defaultConfig, type Config } from '../config/config'
import { DOWNLOAD_CONCURRENCY, ENGINE_LOAD_STALL_SECONDS, GATEWAY_MAX_BODY_MB } from '../config/config-bounds'
import type { Deps } from '../deps'
import { registerSettingsRoutes } from './settings-routes'

function mkApp() {
  let cfg = defaultConfig()
  const d = {
    store: {
      snapshot: () => structuredClone(cfg),
      read: () => cfg,
      update: (fn: (c: Config) => void) => { const work = structuredClone(cfg); fn(work); cfg = work },
    },
  } as unknown as Deps
  const app = new Hono()
  registerSettingsRoutes(app, d)
  const patch = (body: unknown) => app.request('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { app, patch, config: () => cfg }
}

const LIMITS = [
  { key: 'downloadConcurrency', bound: DOWNLOAD_CONCURRENCY, body: (v: unknown) => ({ downloadConcurrency: v }), read: (c: Config) => c.downloadConcurrency },
  { key: 'engineLoadStallSeconds', bound: ENGINE_LOAD_STALL_SECONDS, body: (v: unknown) => ({ engineLoadStallSeconds: v }), read: (c: Config) => c.engineLoadStallSeconds },
  { key: 'gateway.maxBodyMb', bound: GATEWAY_MAX_BODY_MB, body: (v: unknown) => ({ gateway: { maxBodyMb: v } }), read: (c: Config) => c.gateway.maxBodyMb },
]

for (const l of LIMITS) {
  test(`PATCH ${l.key}: the bound's edges are stored and read back by GET`, async () => {
    for (const v of [l.bound.min, l.bound.max]) {
      const { app, patch, config } = mkApp()
      assert.equal((await patch(l.body(v))).status, 200, String(v))
      assert.equal(l.read(config()), v)
      const got = await (await app.request('/api/v1/settings')).json() as Record<string, unknown> & { gateway: { maxBodyMb: number } }
      assert.equal(l.key === 'gateway.maxBodyMb' ? got.gateway.maxBodyMb : got[l.key], v)
    }
  })

  test(`PATCH ${l.key}: past an edge, a fraction or another JSON type is a 400 and nothing is stored`, async () => {
    for (const v of [l.bound.min - 1, l.bound.max + 1, l.bound.min + 0.5, String(l.bound.max), null]) {
      const { patch, config } = mkApp()
      const before = JSON.stringify(config())
      const res = await patch({ ...l.body(v), theme: 'dark' })
      assert.equal(res.status, 400, String(v))
      assert.deepEqual((await res.json() as { error: unknown }).error, { code: 'invalid_config_value', message: l.bound.message })
      assert.equal(JSON.stringify(config()), before)
    }
  })
}
