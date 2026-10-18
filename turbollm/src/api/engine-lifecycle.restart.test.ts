// The Engines card's Restart (`POST /api/v1/engine/restart`, shown while the model runs or after its load failed)
// starts the model on the engine the user selected, as a manual Load does. It reloaded the last load attempted as
// Manager.restart() keeps it, engine included, so after an install or Enable selected another engine (neither stops
// the model nor clears its error), or a stop and an Engines switch, Restart brought the model back on the engine the
// user had left. Real routes, a real Manager and ModelRouter, and two stand-in llama-server binaries (POSIX shell
// wrappers, so these skip on Windows).
import assert from 'node:assert/strict'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Engine } from '../config/config'
import type { Deps } from '../deps'
import { freePort, realEngineSetUp } from '../test-support/stand-in-engine'
import { registerApi } from './routes'

const skip = process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary'

/** realEngineSetUp's engine `fake` (A) and a second stand-in `fake-b` (B) at a binary of its own, each model pinned
 *  to a free port on both. `select(engine)` makes it the engine registry.active() names, as an activation does
 *  (undefined: none selected). */
async function setUp(t: { after: (fn: () => unknown) => void }) {
  const h = await realEngineSetUp(t)
  const a = h.registry.active() as Engine
  const binB = join(dirname(a.binPath), 'llama-server-b')
  copyFileSync(a.binPath, binB)
  const b: Engine = { ...a, id: 'fake-b', name: 'Fake B', binPath: binB }
  const ports = await Promise.all([h.userModel, h.brokenModel].map(() => freePort()))
  h.store.update((c) => {
    ;[h.userModel, h.brokenModel].forEach((m, i) => { c.modelProfiles[m.key]![b.id] = { profile: { port: ports[i] }, updatedAt: '' } })
  })
  let selected: Engine | undefined = a
  Object.assign(h.registry, { active: () => selected })
  const restarts: number[] = []
  const restart = h.manager.restart.bind(h.manager)
  h.manager.restart = (...args) => { restarts.push(1); return restart(...args) }
  const app = new Hono()
  registerApi(app, {
    version: 'test', store: h.store, registry: h.registry, scanner: h.scanner, manager: h.manager, modelRouter: h.modelRouter,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
  } as unknown as Deps)
  const post = async (path: string, body: unknown = {}) =>
    (await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status
  /** Polls until `ok()` holds (up to 6 s), then asserts it. */
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
    const st = h.manager.status()
    assert.ok(ok(), `${what}: state ${st.state}, engine ${h.manager.restartOpts()?.engine.id}, model ${h.manager.restartOpts()?.model.key}`)
  }
  return { ...h, a, b, restarts, post, until, select: (e: Engine | undefined) => { selected = e } }
}

test('Restart after another engine is selected starts the model on the selected engine', { skip }, async (t) => {
  const h = await setUp(t)
  const runningOn = (id: string) => () => h.manager.status().state === 'running' && h.manager.currentOpts()?.engine.id === id

  // A stop, an Engines switch to B, then Restart.
  assert.equal(await h.post('/api/v1/engine/start', { modelKey: h.userModel.key }), 202)
  await h.until(runningOn('fake'), 'loaded on A')
  assert.equal(await h.post('/api/v1/engine/stop'), 202)
  await h.until(() => h.manager.status().state === 'stopped', 'stopped')
  h.select(h.b)
  assert.equal(await h.post('/api/v1/engine/restart'), 202)
  await h.until(runningOn('fake-b'), 'restarted on B')
  assert.ok(h.manager.launchCommand()?.startsWith(h.b.binPath), h.manager.launchCommand() ?? '')
  assert.equal(h.manager.currentOpts()?.model.key, h.userModel.key)
  assert.deepEqual(h.store.snapshot().lastLoaded, { modelKey: h.userModel.key, engineId: 'fake-b' })

  // A model still running on B while an install or Enable selects A (neither stops it): Restart moves it to A.
  h.select(h.a)
  assert.equal(await h.post('/api/v1/engine/restart'), 202)
  await h.until(runningOn('fake'), 'restarted on A')
  assert.ok(h.manager.launchCommand()?.startsWith(h.a.binPath), h.manager.launchCommand() ?? '')

  // A load that failed on A, its error kept while B is selected: Restart (shown for 'error') retries it on B.
  assert.equal(await h.post('/api/v1/engine/start', { modelKey: h.brokenModel.key }), 202)
  await h.until(() => h.manager.status().state === 'error' && h.manager.restartOpts()?.model.key === h.brokenModel.key, 'failed on A')
  assert.equal(h.manager.restartOpts()?.engine.id, 'fake')
  h.select(h.b)
  assert.equal(await h.post('/api/v1/engine/restart'), 202)
  await h.until(() => h.manager.status().state === 'error' && h.manager.restartOpts()?.engine.id === 'fake-b', 'retried on B')
  assert.equal(h.manager.restartOpts()?.model.key, h.brokenModel.key)
  assert.ok(h.manager.launchCommand()?.startsWith(h.b.binPath), h.manager.launchCommand() ?? '')
  assert.deepEqual(h.restarts, [], 'Manager.restart() reloads the engine last used')
})

test('Restart on the engine still selected reloads the same launch with Manager.restart()', { skip }, async (t) => {
  const h = await setUp(t)

  assert.equal(await h.post('/api/v1/engine/start', { modelKey: h.userModel.key }), 202)
  await h.until(() => h.manager.status().state === 'running', 'loaded on A')
  const before = h.manager.currentOpts()
  const pid = h.manager.status().pid
  assert.equal(await h.post('/api/v1/engine/restart'), 202)
  await h.until(() => h.manager.status().state === 'running' && h.manager.status().pid !== pid, 'restarted')
  assert.deepEqual(h.restarts, [1])
  assert.equal(h.manager.currentOpts(), before)
  assert.equal(h.manager.currentOpts()?.engine.id, 'fake')
})

test('Restart with no engine selected is refused, as a Load is, and loads nothing', { skip }, async (t) => {
  const h = await setUp(t)

  assert.equal(await h.post('/api/v1/engine/start', { modelKey: h.userModel.key }), 202)
  await h.until(() => h.manager.status().state === 'running', 'loaded on A')
  const pid = h.manager.status().pid
  h.select(undefined)
  assert.equal(await h.post('/api/v1/engine/restart'), 409)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual([h.manager.status().state, h.manager.status().pid, h.restarts], ['running', pid, []])
})
