// Route-level tests for the model load preset CRUD routes (ADR-353 T5) on a real Hono app,
// mirroring keys-network.test.ts's "real app, minimal Deps double" discipline: registerPresetRoutes
// only touches d.store at handler time, so a snapshot/update double is sufficient.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerPresetRoutes } from './preset-routes'
import { MODEL_PRESET_CAP, defaultConfig, type Config } from '../config/config'
import type { Deps } from '../deps'

const KEY = 'm|q4|1'

function fakeApp(cfg: Config): Hono {
  const app = new Hono()
  const d = {
    version: 'test',
    store: {
      snapshot: () => cfg,
      update: (fn: (c: Config) => void) => fn(cfg),
    },
    // The create route guards on model existence, like PUT /models/:key/profile does.
    scanner: { get: (k: string) => (k === KEY ? { key: KEY } : undefined) },
  } as unknown as Deps
  registerPresetRoutes(app, d)
  return app
}

test('GET /presets: empty for a model with none', async () => {
  const app = fakeApp(defaultConfig())
  const res = await app.request(`/api/v1/models/${KEY}/presets`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { presets: [], pinnedId: null })
})

test('GET /presets: newest updatedAt first', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [
      { id: 'old', name: 'Old', engineId: '', profile: {}, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' },
      { id: 'new', name: 'New', engineId: '', profile: {}, updatedAt: '2026-02-01T00:00:00.000Z', origin: 'autotune' },
    ],
  }
  cfg.lastPresetId = { [KEY]: 'old' }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets`)
  const body = (await res.json()) as { presets: Array<{ id: string }>; pinnedId: string | null }
  assert.deepEqual(body.presets.map((p) => p.id), ['new', 'old'])
  // The pin has to reach the client: without it the dropdown cannot show which preset is
  // active, even though the pin is exactly what getModelProfile serves on the next load.
  assert.equal(body.pinnedId, 'old')
})

test('POST /presets: create → 201 with a minted id, origin manual, engineId defaulting to ""', async () => {
  const cfg = defaultConfig()
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fast 4k', profile: { ctx: 4096 } }),
  })
  assert.equal(res.status, 201)
  const created = (await res.json()) as { id: string; name: string; engineId: string; origin: string; profile: unknown }
  assert.ok(created.id)
  assert.equal(created.name, 'Fast 4k')
  assert.equal(created.engineId, '')
  assert.equal(created.origin, 'manual')
  assert.deepEqual(created.profile, { ctx: 4096 })
  assert.equal((cfg.modelPresets[KEY] ?? []).length, 1)
})

test('POST /presets: without name → 400', async () => {
  const res = await fakeApp(defaultConfig()).request(`/api/v1/models/${KEY}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: { ctx: 4096 } }),
  })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_config_value')
})

test('POST /presets: without profile → 400', async () => {
  const res = await fakeApp(defaultConfig()).request(`/api/v1/models/${KEY}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'No profile' }),
  })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_config_value')
})

test('POST /presets: array and scalar profiles are rejected with 400', async () => {
  const app = fakeApp(defaultConfig())
  for (const profile of [[{ ctx: 4096 }], 42, 'ctx: 4096']) {
    const res = await app.request(`/api/v1/models/${KEY}/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', profile }),
    })
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_config_value')
  }
})

test('POST /presets: past the per-model cap → 400 too_many_presets, NOT a 500', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: Array.from({ length: MODEL_PRESET_CAP }, (_, i) => ({
      id: `p-${i}`,
      name: `Preset ${i}`,
      engineId: '',
      profile: { ctx: 4096 },
      updatedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      origin: 'manual' as const,
    })),
  }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'One too many', profile: { ctx: 4096 } }),
  })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'too_many_presets')
  assert.equal((cfg.modelPresets[KEY] ?? []).length, MODEL_PRESET_CAP) // nothing was created
})

test('PUT /presets/:id: unknown id → 404', async () => {
  const res = await fakeApp(defaultConfig()).request(`/api/v1/models/${KEY}/presets/nope`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ghost' }),
  })
  assert.equal(res.status, 404)
})

test('PUT /presets/:id: name-only edit leaves updatedAt untouched', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [{ id: 'p-1', name: 'Old name', engineId: '', profile: { ctx: 4096 }, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' }],
  }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets/p-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New name' }),
  })
  assert.equal(res.status, 200)
  const updated = (await res.json()) as { name: string; updatedAt: string }
  assert.equal(updated.name, 'New name')
  assert.equal(updated.updatedAt, '2026-01-01T00:00:00.000Z') // NOT re-stamped
  assert.deepEqual((cfg.modelPresets[KEY] ?? [])[0]?.profile, { ctx: 4096 })
})

test('PUT /presets/:id: a profile change updates it and re-stamps updatedAt', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [{ id: 'p-1', name: 'Tuned', engineId: '', profile: { ctx: 4096 }, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' }],
  }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets/p-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: { ctx: 8192 } }),
  })
  assert.equal(res.status, 200)
  const updated = (await res.json()) as { profile: unknown; updatedAt: string }
  assert.deepEqual(updated.profile, { ctx: 8192 })
  assert.notEqual(updated.updatedAt, '2026-01-01T00:00:00.000Z')
})

test('PUT /presets/:id: non-object profile → 400', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [{ id: 'p-1', name: 'Tuned', engineId: '', profile: {}, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' }],
  }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets/p-1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: [1, 2, 3] }),
  })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_config_value')
})

test('DELETE /presets/:id: keeps the array (key still exists, []) and clears a matching pin', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [
      { id: 'p-1', name: 'One', engineId: '', profile: {}, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' },
      { id: 'p-2', name: 'Two', engineId: '', profile: {}, updatedAt: '2026-01-02T00:00:00.000Z', origin: 'autotune' },
    ],
  }
  cfg.lastPresetId = { [KEY]: 'p-1' }
  const app = fakeApp(cfg)

  const del = await app.request(`/api/v1/models/${KEY}/presets/p-1`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.deepEqual(await del.json(), { ok: true })
  assert.deepEqual((cfg.modelPresets[KEY] ?? []).map((p) => p.id), ['p-2']) // sibling survives
  assert.equal(cfg.lastPresetId?.[KEY], undefined) // the matching pin was cleared

  // Deleting the LAST preset still keeps the array — the key exists and is [], never deleted.
  const delLast = await app.request(`/api/v1/models/${KEY}/presets/p-2`, { method: 'DELETE' })
  assert.equal(delLast.status, 200)
  assert.ok(KEY in cfg.modelPresets) // the array is kept, never deleted
  assert.deepEqual(cfg.modelPresets[KEY], [])

  // A delete of a now-gone id is a clean 404 (the array exists but is empty).
  const again = await app.request(`/api/v1/models/${KEY}/presets/p-1`, { method: 'DELETE' })
  assert.equal(again.status, 404)
})

test('DELETE /presets/:id: an unrelated pin survives', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [
      { id: 'p-1', name: 'One', engineId: '', profile: {}, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' },
      { id: 'p-2', name: 'Two', engineId: '', profile: {}, updatedAt: '2026-01-02T00:00:00.000Z', origin: 'manual' },
    ],
  }
  cfg.lastPresetId = { [KEY]: 'p-2' }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets/p-1`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId?.[KEY], 'p-2')
})

test('POST /presets/:id/apply: sets the pin and returns the preset', async () => {
  const cfg = defaultConfig()
  cfg.modelPresets = {
    [KEY]: [{ id: 'p-1', name: 'One', engineId: '', profile: { ctx: 4096 }, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'manual' }],
  }
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets/p-1/apply`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { id: string }).id, 'p-1')
  assert.equal(cfg.lastPresetId?.[KEY], 'p-1')
})

test('POST /presets/:id/apply: unknown id → 404 and no pin written', async () => {
  const cfg = defaultConfig()
  const res = await fakeApp(cfg).request(`/api/v1/models/${KEY}/presets/nope/apply`, { method: 'POST' })
  assert.equal(res.status, 404)
  assert.equal(cfg.lastPresetId?.[KEY], undefined)
})

test('POST /presets: an unknown model key → 404 (matches PUT /models/:key/profile)', async () => {
  const res = await fakeApp(defaultConfig()).request('/api/v1/models/nope%7Cq4%7C1/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', profile: { ctx: 4096 } }),
  })
  assert.equal(res.status, 404)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_model')
})

test('POST /presets: bad profile FIELDS are rejected, not just bad shape', async () => {
  // A pinned preset's profile goes verbatim to profileToArgs. Accepting these here would let a
  // preset be pinned that makes the model unloadable until the pin is cleared by hand.
  const app = fakeApp(defaultConfig())
  const bad: Array<Record<string, unknown>> = [
    { ctx: 1 },
    { ctx: 4096, nCpuMoe: null },
    { ctx: 4096, ngl: -1 },
    { ctx: 4096, gpu: { splitMode: 'nonsense', tensorSplit: [], mainGpu: 0, tensorParallelSize: 1 } },
    { ctx: 4096, gpu: { splitMode: 'layer', tensorSplit: 'not-an-array', mainGpu: 0, tensorParallelSize: 1 } },
    { ctx: 4096, gpu: { splitMode: 'layer', tensorSplit: [], mainGpu: -99, tensorParallelSize: 1 } },
    { ctx: 4096, gpu: { splitMode: 'layer', tensorSplit: [], mainGpu: 0, tensorParallelSize: 0 } },
  ]
  for (const profile of bad) {
    const res = await app.request(`/api/v1/models/${KEY}/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad fields', profile }),
    })
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(profile)}`)
  }
})
