// DELETE /api/v1/engines/:id (Disable, ?purge=1) and DELETE /api/v1/engines/backends/:id must not run while an engine
// update, download, upload or rebuild holds the engine-work slot (engineWorkBusy), as the install, update, zip and
// build routes already refuse. A purge under an update made its swap report "your existing build is unchanged" and
// left an orphan folder; under a rebuild the failing build moved its parked previous build back into the purged
// folder; a backend deleted mid-update was registered again. POST /api/v1/engines (Add, Enable) is refused too: a
// Disabled source-built card's Delete re-registers the engine there before it purges, so a refused purge alone left
// it Enabled again. Same "real Hono app, minimal Deps double" style as engines-release.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { availableBackends } from '../engines/download'
import { tmpDir } from '../test-support/tmp'

function harness(busy: 'download' | 'build' | null) {
  const dataDir = tmpDir('tllm-engine-delete-')
  const forkDir = join(dataDir, 'engines', 'build', 'myfork')
  mkdirSync(forkDir, { recursive: true })
  writeFileSync(join(forkDir, 'llama-server'), 'bin')
  const backend = availableBackends()[0]!
  const backendDir = join(dataDir, 'engines', `llama.cpp-b1-${backend.id}`)
  mkdirSync(backendDir, { recursive: true })
  writeFileSync(join(backendDir, 'llama-server'), 'bin')
  const engines = [
    { id: 'fork', name: 'My fork', kind: 'llama-server', binPath: join(forkDir, 'llama-server') },
    { id: 'be', name: 'llama.cpp', kind: 'llama-server', binPath: join(backendDir, 'llama-server') },
  ]
  const removed: string[] = []
  const added: string[] = []
  const cfg = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [], links: [], telemetry: { level: 'off', machineId: 'm' },
  }
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, dir: () => dataDir },
    manager: { status: () => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null }), currentOpts: () => null, stopAndWait: async () => {} },
    provision: { get: () => ({ active: busy === 'download', phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }) },
    build: { isActive: () => busy === 'build' },
    modelRouter: { poolEngineIds: () => new Set<string>(), stopPoolSlotsOnEngine: async () => {} },
    registry: {
      active: () => undefined,
      list: () => ({ engines: engines.filter((e) => !removed.includes(e.id)), activeEngineId: '' }),
      get: (id: string) => engines.find((e) => e.id === id && !removed.includes(id)),
      remove: (id: string) => { removed.push(id) },
      forgetCustomSource: () => {},
      add: async (name: string, binPath: string) => {
        added.push(binPath)
        return { engine: { id: 'fork2', name, binPath, kind: 'llama-server' }, warning: null }
      },
      recordCustomSource: () => {},
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, removed, added, forkDir, backendDir, backendId: backend.id }
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code
}

for (const busy of ['download', 'build'] as const) {
  test(`DELETE /engines/:id: Disable and Purge are 409 engine_already_running while a ${busy} runs, and remove nothing`, async () => {
    const h = harness(busy)
    for (const query of ['', '?purge=1']) {
      const res = await h.app.request(`/api/v1/engines/fork${query}`, { method: 'DELETE' })
      assert.equal(res.status, 409, query || 'disable')
      assert.equal(await errorCode(res), 'engine_already_running')
    }
    assert.deepEqual(h.removed, [])
    assert.equal(existsSync(h.forkDir), true)
  })

  test(`DELETE /engines/backends/:id is 409 engine_already_running while a ${busy} runs, and keeps its builds`, async () => {
    const h = harness(busy)
    const res = await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.deepEqual(h.removed, [])
    assert.equal(existsSync(h.backendDir), true)
  })

  test(`POST /engines (a Disabled card's Delete re-registers through it first) is 409 engine_already_running while a ${busy} runs, and registers nothing`, async () => {
    const h = harness(busy)
    const res = await h.app.request('/api/v1/engines', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My fork', binPath: join(h.forkDir, 'llama-server') }),
    })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.deepEqual(h.added, [])
  })
}

test('with no engine work running, a re-register, a purge and a backend delete still go through', async () => {
  const h = harness(null)
  const add = await h.app.request('/api/v1/engines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My fork', binPath: join(h.forkDir, 'llama-server') }),
  })
  assert.equal(add.status, 201)
  assert.deepEqual(h.added, [join(h.forkDir, 'llama-server')])
  assert.equal((await h.app.request('/api/v1/engines/fork?purge=1', { method: 'DELETE' })).status, 200)
  assert.equal(existsSync(h.forkDir), false)
  assert.equal((await h.app.request(`/api/v1/engines/backends/${h.backendId}`, { method: 'DELETE' })).status, 200)
  assert.equal(existsSync(h.backendDir), false)
  assert.deepEqual(h.removed, ['fork', 'be'])
})
