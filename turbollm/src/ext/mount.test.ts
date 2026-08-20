// turbollm/src/ext/mount.test.ts
//
// mountExtApi (spec 27 §4/§10): the entire /api/ext/v1 surface is flag-gated. Off means off —
// a request to any path under it must 404, not merely fail auth, since a 401/403 would still
// confirm the surface exists to a caller who cannot use it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mountExtApi } from './mount.js'

test('the api is not mounted when the flag is off', async () => {
  const app = new Hono()
  mountExtApi(app, { store: { snapshot: () => ({ api: { ext: { enabled: false } }, apiKeys: [] }) } } as never, null as never, null as never)
  const res = await app.request('/api/ext/v1/capabilities')
  assert.equal(res.status, 404, 'a disabled feature must not answer at all')
})
