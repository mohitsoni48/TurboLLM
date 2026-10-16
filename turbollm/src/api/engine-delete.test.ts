// DELETE /api/v1/engines/:id (Disable, ?purge=1) and DELETE /api/v1/engines/backends/:id must not run while an engine
// update, download, upload or rebuild holds the engine-work slot (engineWorkBusy), as the install, update, zip and
// build routes already refuse. A purge under an update made its swap report "your existing build is unchanged" and
// left an orphan folder; under a rebuild the failing build moved its parked previous build back into the purged
// folder; a backend deleted mid-update was registered again. POST /api/v1/engines (Add, Enable) is refused too, as
// is DELETE /api/v1/engines/build (a Disabled source-built card's Delete). Same "real Hono app, minimal Deps double"
// style as engines-release.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs, { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
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
  const sources: { binPath: string }[] = []
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
      customSources: () => sources,
    },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, removed, added, sources, dataDir, forkDir, backendDir, backendId: backend.id }
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

  test(`POST /engines (Add, Enable) is 409 engine_already_running while a ${busy} runs, and registers nothing`, async () => {
    const h = harness(busy)
    const res = await h.app.request('/api/v1/engines', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My fork', binPath: join(h.forkDir, 'llama-server') }),
    })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.deepEqual(h.added, [])
  })

  test(`DELETE /engines/build is 409 engine_already_running while a ${busy} runs, and keeps the build`, async () => {
    const h = harness(busy)
    const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
    const res = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_already_running')
    assert.equal(existsSync(bin), true)
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

// DELETE /api/v1/engines/build: the Engines screen's Delete on a Disabled source-built catalog card. That Delete used to
// re-register the build through POST /engines, which probes the binary, so a build whose binary no longer starts (a
// driver or toolkit change left it unable to load libcuda) answered probe_failed and its folder stayed on disk. This
// route runs nothing and deletes only an unclaimed build/<slug> folder.

/** A Disabled catalog build on disk: build/<slug>/build/bin/llama-server, a binary that no longer starts. */
function disabledBuild(dataDir: string, slug: string): string {
  const binDir = join(dataDir, 'engines', 'build', slug, 'build', 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'llama-server')
  writeFileSync(bin, "#!/bin/sh\necho 'error while loading shared libraries: libcuda.so.1' >&2\nexit 127\n", { mode: 0o755 })
  return bin
}

test('DELETE /engines/build deletes a Disabled source build whose binary no longer starts, and registers nothing', async () => {
  const h = harness(null)
  const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
  const res = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal(existsSync(join(h.dataDir, 'engines', 'build', 'prismml-eng-llama.cpp-prism')), false)
  assert.deepEqual(h.added, [], 'no re-register, so no probe')
  assert.deepEqual(h.removed, [])
  assert.equal(existsSync(h.forkDir), true, 'the registered build beside it is untouched')
})

test('DELETE /engines/build refuses a folder an engine or a remembered source claims, and anything but a build/<slug> folder', async () => {
  const h = harness(null)
  const del = (binPath: string) => h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(binPath)}`, { method: 'DELETE' })

  let res = await del(join(h.forkDir, 'llama-server')) // the registered "My fork"
  assert.equal(res.status, 409)
  assert.equal(await errorCode(res), 'build_dir_taken')
  assert.equal(existsSync(h.forkDir), true)

  const remembered = disabledBuild(h.dataDir, 'my-custom-build')
  h.sources.push({ binPath: remembered })
  res = await del(remembered)
  assert.equal(res.status, 409)
  assert.equal(await errorCode(res), 'build_dir_taken')
  assert.equal(existsSync(remembered), true)

  const parked = disabledBuild(h.dataDir, '.myfork-1700000000000.prev') // a rebuild's parked previous build
  for (const binPath of [parked, join(h.backendDir, 'llama-server'), join(h.dataDir, 'engines', 'build', 'gone', 'llama-server'), '']) {
    res = await del(binPath)
    assert.equal(res.status, 404, binPath)
    assert.equal(await errorCode(res), 'engine_not_found')
  }
  assert.equal(existsSync(parked), true)
  assert.equal(existsSync(h.backendDir), true)
  assert.deepEqual(h.removed, [])
})

test('DELETE /engines/build whose folder stays locked past the retries is 409 engine_files_locked, and can be repeated', async (t) => {
  const h = harness(null)
  const bin = disabledBuild(h.dataDir, 'prismml-eng-llama.cpp-prism')
  const dir = join(h.dataDir, 'engines', 'build', 'prismml-eng-llama.cpp-prism')
  const realRmSync = fs.rmSync
  const locked = t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === dir) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return realRmSync(p, o)
  })
  syncBuiltinESMExports()
  try {
    const res = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
    assert.equal(res.status, 409)
    assert.equal(await errorCode(res), 'engine_files_locked')
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.ok((locked.mock.calls[0]?.arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the delete retries, as a Windows lock is brief')
  const again = await h.app.request(`/api/v1/engines/build?binPath=${encodeURIComponent(bin)}`, { method: 'DELETE' })
  assert.equal(again.status, 200)
  assert.equal(existsSync(dir), false)
})
