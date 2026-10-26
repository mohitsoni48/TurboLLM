// PUT /api/v1/models/:key/hidden (Models → Library, a model's "Hide"/"Unhide") and the `hidden` mark GET /api/v1/models
// puts on each model, through the real routes and a real ConfigStore on a temp file, so a hidden model is shown to
// stay hidden across a daemon restart. Who may call the route is server.model-hidden.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore } from '../config/config'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { tmpDir } from '../test-support/tmp'

const KEY = 'gemma-3-270m|Q4_K_M|253'
const OTHER = 'qwen2.5-0.5b|Q8_0|531'

function entry(key: string): ModelEntry {
  return { key, name: key.split('|')[0], path: `/models/${key.split('|')[0]}.gguf`, dir: '/models', format: 'gguf' } as unknown as ModelEntry
}

/** The real routes over `store`, with a library of KEY and OTHER (or `library`). `deleted` is what the scanner still
 *  lists after a DELETE: [] when the file was the last copy of its key. */
function app(store: ConfigStore, opts: { library?: ModelEntry[]; afterDelete?: ModelEntry[] } = {}): Hono {
  let models = opts.library ?? [entry(KEY), entry(OTHER)]
  const hono = new Hono()
  registerApi(hono, {
    version: 'test',
    store,
    scanner: {
      get: (k: string) => models.find((m) => m.key === k),
      list: () => ({ models, scanning: false, lastScanAt: '' }),
      delete: async () => { models = opts.afterDelete ?? []; return [] },
    },
    db: { lastGenTpsByModel: () => new Map() },
    manager: { status: () => ({ state: 'stopped', model: null }) },
    modelRouter: { loadedModelKeys: () => new Set<string>() },
    downloads: { provenance: () => [] },
    registry: { active: () => undefined, layaEngine: () => undefined },
  } as unknown as Deps)
  return hono
}

function freshStore(): { store: ConfigStore; path: string } {
  const path = join(tmpDir('tllm-hidden-route-'), 'config.json')
  return { store: ConfigStore.load(path), path }
}

function setHidden(a: Hono, key: string, body: unknown) {
  return a.request(`/api/v1/models/${encodeURIComponent(key)}/hidden`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function hiddenMarks(a: Hono): Promise<Record<string, unknown>> {
  const { models } = (await (await a.request('/api/v1/models')).json()) as { models: { key: string; hidden?: unknown }[] }
  return Object.fromEntries(models.map((m) => [m.key, m.hidden]))
}

test('hiding a model marks it hidden in GET /models, and only it; unhiding clears the mark', async () => {
  const { store } = freshStore()
  const a = app(store)
  assert.deepEqual(await hiddenMarks(a), { [KEY]: false, [OTHER]: false })
  const res = await setHidden(a, KEY, { hidden: true })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { key: KEY, hidden: true })
  assert.deepEqual(await hiddenMarks(a), { [KEY]: true, [OTHER]: false })
  const detail = (await (await a.request(`/api/v1/models/${encodeURIComponent(KEY)}`)).json()) as { hidden?: unknown }
  assert.equal(detail.hidden, true)
  assert.equal((await setHidden(a, KEY, { hidden: false })).status, 200)
  assert.deepEqual(await hiddenMarks(a), { [KEY]: false, [OTHER]: false })
  assert.deepEqual(store.snapshot().hiddenModels, [])
})

test('a hidden model stays hidden after the daemon restarts', async () => {
  const { store, path } = freshStore()
  assert.equal((await setHidden(app(store), KEY, { hidden: true })).status, 200)
  const restarted = ConfigStore.load(path)
  assert.deepEqual(restarted.snapshot().hiddenModels, [KEY])
  assert.deepEqual(await hiddenMarks(app(restarted)), { [KEY]: true, [OTHER]: false })
})

test('a key no scanned model has is refused, and nothing is stored', async () => {
  const { store } = freshStore()
  const res = await setHidden(app(store), 'not|in|library', { hidden: true })
  assert.equal(res.status, 404)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_such_model')
  // Nor a key that names a built-in of the map-style config fields.
  assert.equal((await setHidden(app(store), '__proto__', { hidden: true })).status, 404)
  assert.deepEqual(store.snapshot().hiddenModels, [])
})

test('a body without a true or false `hidden` is refused, and nothing is stored', async () => {
  const { store } = freshStore()
  const a = app(store)
  for (const body of [{}, { hidden: 'true' }, { hidden: 1 }, { hidden: null }, null, [true]]) {
    const res = await setHidden(a, KEY, body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_config_value')
  }
  assert.deepEqual(store.snapshot().hiddenModels, [])
})

test('deleting the last copy of a hidden model drops its key; deleting one of two copies keeps it', async () => {
  {
    const { store } = freshStore()
    const a = app(store)
    await setHidden(a, KEY, { hidden: true })
    assert.equal((await a.request(`/api/v1/models/${encodeURIComponent(KEY)}`, { method: 'DELETE' })).status, 200)
    assert.deepEqual(store.snapshot().hiddenModels, [])
  }
  {
    const { store } = freshStore()
    const a = app(store, { afterDelete: [entry(KEY)] })
    await setHidden(a, KEY, { hidden: true })
    assert.equal((await a.request(`/api/v1/models/${encodeURIComponent(KEY)}`, { method: 'DELETE' })).status, 200)
    assert.deepEqual(store.snapshot().hiddenModels, [KEY])
  }
})

test('a hidden key whose model is no longer scanned is harmless: GET /models lists what is scanned', async () => {
  const { store } = freshStore()
  store.update((cfg) => { cfg.hiddenModels = ['gone|Q4_K_M|1', KEY] })
  assert.deepEqual(await hiddenMarks(app(store)), { [KEY]: true, [OTHER]: false })
})
