// MAJ-1 (stage-6 review): a fallback to the Android CPU server while the in-app SDK was down is undone on the SDK's
// return (android-engines.ts) unless the user picked an engine meanwhile. The user's pick is a tap on "Use", which is
// this route, so the route forgets the fallback, even when the pick is the CPU server itself.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, defaultConfig, type Engine } from '../config/config'
import type { Deps } from '../deps'
import { Registry } from '../engines/registry'
import { tmpDir } from '../test-support/tmp'
import { registerApi } from './routes'

function engine(id: string, kind: string): Engine {
  return { id, name: id, binPath: '', kind, version: '1', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }
}

const LITERT = engine('litert-row', 'turbollm-sdk')
const CPU = engine('cpu-row', 'llama-server')

function appAfterFallback() {
  const path = join(tmpDir('tllm-sdk-fallback-route-'), 'config.json')
  writeFileSync(path, JSON.stringify({
    ...defaultConfig(),
    engines: [LITERT, CPU],
    activeEngineId: CPU.id,
    androidSdkFallback: { from: LITERT.id, to: CPU.id },
  }))
  const store = ConfigStore.load(path)
  const d = {
    store,
    registry: new Registry(store),
    manager: { status: () => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null }), clearError: () => {} },
    bench: { isRunning: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, fallbackOnDisk: () => ConfigStore.load(path).snapshot().androidSdkFallback }
}

for (const picked of [LITERT, CPU]) {
  test(`MAJ-1: activating ${picked.id} by hand forgets the Android SDK fallback`, async () => {
    const { app, fallbackOnDisk } = appAfterFallback()
    assert.deepEqual(fallbackOnDisk(), { from: LITERT.id, to: CPU.id })

    const res = await app.request(`/api/v1/engines/${picked.id}/activate`, { method: 'POST' })

    assert.equal(res.status, 200)
    assert.equal(fallbackOnDisk(), undefined)
  })
}
