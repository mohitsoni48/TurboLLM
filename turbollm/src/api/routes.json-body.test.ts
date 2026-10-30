// The daemon's REST routes read their JSON body through routes.ts's body(), which fell back to {} only for a body that
// did not parse. A JSON `null` reached the handlers, and the first field read threw (startEngine's `b.modelKey`, the MCP
// server's `b.transport`): the request got Hono's bare text/plain "Internal Server Error" 500 instead of the route's own
// JSON 400 or 409, the answer the same request with `{}` gets.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { defaultConfig } from '../config/config'
import type { Deps } from '../deps'

function mkApp(model?: { key: string }) {
  const cfg = defaultConfig()
  const app = new Hono()
  const d = {
    version: 'test',
    store: {
      snapshot: () => cfg,
      update: (fn: (c: typeof cfg) => void) => { const work = structuredClone(cfg); fn(work); Object.assign(cfg, work) },
      dir: () => '.',
    },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    registry: { active: () => undefined },
    scanner: { get: (key: string) => (key === model?.key ? model : undefined), rescan: () => {} },
  } as unknown as Deps
  registerApi(app, d)
  return { cfg, app }
}

const ROUTES: Array<[method: string, path: string]> = [
  ['POST', '/api/v1/engine/start'],
  ['POST', '/api/v1/mcp/servers'],
  ['POST', '/api/v1/keys'],
  ['POST', '/api/v1/modeldirs'],
  ['POST', '/api/v1/modeldirs/primary'],
  ['DELETE', '/api/v1/modeldirs'],
]

test('a JSON body that is not an object gets the same answer as {} from the REST routes, not a bare 500', async () => {
  for (const [method, path] of ROUTES) {
    const send = (raw: string) => mkApp().app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: raw })
    const empty = await send('{}')
    const expected = { status: empty.status, body: await empty.json() as unknown }
    assert.notEqual(expected.status, 500, `${method} ${path} with {}`)
    for (const raw of ['null', '[]', '"x"', '7']) {
      const res = await send(raw)
      assert.match(res.headers.get('Content-Type') ?? '', /application\/json/, `${method} ${path} with ${raw}: ${res.status}`)
      assert.deepEqual({ status: res.status, body: await res.json() as unknown }, expected, `${method} ${path} with ${raw}`)
    }
  }
})

// PATCH /api/v1/settings reads the same helper and refuses a body that is not an object with its own 400
// (settings-json-types.test.ts); a body that does not parse is still an empty patch.
test('PATCH /api/v1/settings still refuses a JSON body that is not an object, and takes one that does not parse as empty', async () => {
  const { cfg, app } = mkApp()
  const before = structuredClone(cfg)
  const patch = (raw: string) => app.request('/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: raw })
  for (const raw of ['null', '[]', '"x"']) {
    const res = await patch(raw)
    assert.equal(res.status, 400, raw)
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'invalid_config_value', raw)
  }
  assert.deepEqual(cfg, before, 'a refused patch writes nothing')
  assert.equal((await patch('{not json')).status, 200)
})

// The profile PUT hands the whole body to validateLoadProfileFields, which refuses a body that is not an object with its
// own 400. Read through body(), such a body is {} and gets the refusal for a missing ctx instead.
test('PUT /api/v1/models/:key/profile still answers a JSON body that is not an object with its own 400', async () => {
  const { app } = mkApp({ key: 'm' })
  const put = (raw: string) => app.request('/api/v1/models/m/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: raw })
  for (const raw of ['null', '[]', '"x"', '7']) {
    const res = await put(raw)
    assert.equal(res.status, 400, raw)
    assert.deepEqual((await res.json() as { error: unknown }).error, { code: 'invalid_profile_value', message: 'profile must be a JSON object.' }, raw)
  }
  const unparsed = await put('{not json')
  assert.equal(unparsed.status, 400)
  assert.equal((await unparsed.json() as { error: { message: string } }).error.message, 'ctx must be at least 256.', 'a body that does not parse is an empty profile')
})
