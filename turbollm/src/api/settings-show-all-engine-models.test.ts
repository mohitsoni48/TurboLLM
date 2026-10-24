// Settings → Models, "Show models for every engine" (config.showAllEngineModels): off by default, stored by
// PATCH /api/v1/settings and served by GET. The web lists every model with it on; a model still loads only on the
// selected engine (registry.engineForModel).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore } from '../config/config'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function app(store: ConfigStore) {
  const a = new Hono()
  registerApi(a, { version: 'test', store, manager: { status: () => ({ state: 'stopped', model: null }) } } as unknown as Deps)
  return a
}

test('showAllEngineModels is off by default, and PATCH /api/v1/settings turns it on and back off', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-show-all-'), 'config.json'))
  const a = app(store)
  const get = async () => ((await (await a.request('/api/v1/settings')).json()) as { showAllEngineModels?: boolean }).showAllEngineModels

  assert.equal(await get(), false)
  for (const on of [true, false]) {
    const res = await a.request('/api/v1/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showAllEngineModels: on }),
    })
    assert.equal(res.status, 200)
    assert.equal(store.snapshot().showAllEngineModels, on)
    assert.equal(await get(), on)
  }
})

test('a config written before the setting, or with a value that is not true, loads with it off', () => {
  const dir = tmpDir('tllm-show-all-')
  for (const value of [undefined, 'yes', 1]) {
    const path = join(dir, 'config.json')
    const raw = JSON.parse(JSON.stringify(ConfigStore.load(join(dir, 'seed.json')).snapshot())) as Record<string, unknown>
    if (value === undefined) delete raw.showAllEngineModels
    else raw.showAllEngineModels = value
    writeFileSync(path, JSON.stringify(raw))
    assert.equal(ConfigStore.load(path).snapshot().showAllEngineModels, false, String(value))
  }
})
