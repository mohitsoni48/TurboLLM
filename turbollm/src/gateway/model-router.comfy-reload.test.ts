// A gateway request for the model a ComfyUI render unloaded, landing while release() reloads it, against a real
// ConfigStore, Manager, ComfyGuard and ModelRouter wired as cli.ts wires them, and a fake llama-server. The reload ran
// outside the router's swap lock, so doLoad found no running target: with keep-N 1 it evicted the starting primary as
// LRU and loaded the same model again (three spawns, not two); with keep-N 2 it loaded a second copy into a pool slot.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from '../api/engine-lifecycle'
import { ConfigStore, type Engine } from '../config/config'
import type { Deps } from '../deps'
import { ComfyGuard } from '../engines/comfy-guard'
import { Manager } from '../engines/manager'
import type { Registry } from '../engines/registry'
import type { ModelEntry, Scanner } from '../models/scanner'
import { freePort, realEngineSetUp } from '../test-support/stand-in-engine'
import { tmpDir } from '../test-support/tmp'
import { ModelRouter } from './model-router'

/** A stand-in llama-server: notes each spawn in $SPAWN_LOG, answers /health on --port once 1 s has passed (the model
 *  "loads"), and exits at once on SIGTERM. It binds the port it is handed, so setUp pins that port to a free ephemeral
 *  one through the model's saved profile (the router turns profile.port into preferredPort): the 8081+ walk is shared
 *  with other test files' engines in a parallel run, and two engines handed the same port made the second die with
 *  EADDRINUSE (see freePort). */
const FAKE_ENGINE_JS = `
const fs = require('fs')
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
fs.appendFileSync(process.env.SPAWN_LOG, args[args.indexOf('-m') + 1] + '\\n')
setTimeout(() => {
  http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
}, 1000)
process.on('SIGTERM', () => process.exit(0))
`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setUp(t: { after: (fn: () => unknown) => void }, keepN: number) {
  const dir = tmpDir('tllm-comfy-reload-')
  const spawnLog = join(dir, 'spawns.log')
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nSPAWN_LOG="${spawnLog}" exec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const engine: Engine = { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }
  const model = {
    key: 'model-a|Q4_K_M|1', name: 'model-a', path: join(dir, 'model-a.gguf'), dir, format: 'gguf', sizeBytes: 1,
    sizeLabel: '1 B', arch: 'llama', quant: 'Q4_K_M', nativeCtx: 4096, blockCount: 1, headCountKv: 1, headDim: 1,
    moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0,
    hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
  } as unknown as ModelEntry
  const port = await freePort()

  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => {
    c.comfyui.enabled = true
    c.gateway.autoSwap = true
    c.gateway.keepN = keepN
    c.modelProfiles[model.key] = { [engine.id]: { profile: { port }, updatedAt: '' } }
    // Registered and selected, as the registry double has it: release() reloads a model only on the selected engine.
    c.engines = [engine]
    c.activeEngineId = engine.id
  })
  const manager = new Manager(store)
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  const registry = { active: () => engine, layaEngine: () => undefined } as unknown as Registry
  const scanner = {
    list: () => ({ models: [model], scanning: false, lastScanAt: '' }),
    get: (key: string) => (key === model.key ? model : undefined),
  } as unknown as Scanner
  const router = new ModelRouter(store, registry, manager, scanner, guard)
  // As cli.ts wires them.
  guard.setPoolStopper(async () => {
    await Promise.all([...router.poolEngineIds()].map((id) => router.stopPoolSlotsOnEngine(id, { force: true })))
  })
  guard.setSwapLock((fn) => router.withSwapLock(fn))
  guard.setOnReloaded((modelKey, engineId) => router.reloadedAfterRender(modelKey, engineId))
  t.after(async () => {
    guard.stop()
    await router.stopPoolSlotsOnEngine('fake', { force: true })
    await manager.stopAndWait({ force: true })
  })
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length : 0)
  return { model, manager, guard, router, spawns }
}

/** Load the model, render, and route it again just after the render ends, while release() is reloading it. */
async function renderThenRouteDuringReload(r: Awaited<ReturnType<typeof setUp>>) {
  const first = await r.router.route(r.model.key)
  assert.ok('target' in first, JSON.stringify(first))
  await r.guard.acquire()
  const during = await r.router.route(r.model.key)
  assert.ok('status' in during && !during.permanent, 'a retryable 503 while ComfyUI renders')

  const reload = r.guard.release()
  await sleep(200)
  assert.equal(r.manager.status().state, 'starting', 'the reload is loading the model')
  const after = await r.router.route(r.model.key)
  await reload
  return after
}

test('a request for the model a render unloaded, landing while release() reloads it, waits for that reload (keep-N 1)', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const r = await setUp(t, 1)

  const after = await renderThenRouteDuringReload(r)

  assert.ok('target' in after, JSON.stringify(after))
  assert.equal(after.target, r.manager.target())
  assert.equal(r.spawns(), 2, 'loaded once, reloaded once: the starting reload is not evicted and loaded again')
  assert.deepEqual(r.router.aliveSlots().map((s) => [s.modelKey, s.state, s.primary]), [[r.model.key, 'running', true]])
})

test('with keep-N 2 that request gets the reloading primary, not a second copy in a pool slot', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const r = await setUp(t, 2)

  const after = await renderThenRouteDuringReload(r)

  assert.ok('target' in after, JSON.stringify(after))
  assert.equal(after.target, r.manager.target())
  assert.equal(r.spawns(), 2)
  assert.deepEqual(r.router.aliveSlots().map((s) => [s.modelKey, s.state, s.primary]), [[r.model.key, 'running', true]])
})

// ── A gateway load that a render overtakes during its engine preflight ───────────────────────────────────────────────
// vLLM and SGLang import uvloop first (about 1 s) after the load's pre-start hook. An acquire landing there found no
// engine to stop, and the load then spawned under the render: a pool slot was stopped only once its model was up, and
// the primary served the request during the render.

/** A stand-in vLLM venv python: `-c` is the preflight (`import uvloop`), which takes 1 s while a `slow` file exists and
 *  first writes `probing`; anything else is the server, which notes the model in $SPAWN_LOG and answers /health. Like
 *  the llama-server one it binds the port it is handed, so setUpVllm pins each model's port in its profile. */
const FAKE_VLLM_JS = `
const fs = require('fs')
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
fs.appendFileSync(process.env.SPAWN_LOG, args[args.indexOf('--model') + 1] + '\\n')
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

async function setUpVllm(t: { after: (fn: () => unknown) => void }, keepN: number) {
  const dir = tmpDir('tllm-comfy-preflight-')
  const spawnLog = join(dir, 'spawns.log')
  writeFileSync(join(dir, 'fake-vllm.js'), FAKE_VLLM_JS)
  const bin = join(dir, 'python')
  writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then',
    `  if [ -f "${join(dir, 'slow')}" ]; then : > "${join(dir, 'probing')}"; sleep 1; fi`,
    '  exit 0',
    'fi',
    `SPAWN_LOG="${spawnLog}" exec "${process.execPath}" "${join(dir, 'fake-vllm.js')}" "$@"`,
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  const engine: Engine = { id: 'fake', name: 'Fake', binPath: bin, kind: 'vllm', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }
  const entry = (name: string) => ({
    key: `${name}|bf16|1`, name, path: join(dir, name), dir, format: 'mlx', sizeBytes: 1,
    sizeLabel: '1 B', arch: 'llama', quant: 'bf16', nativeCtx: 4096, blockCount: 1, headCountKv: 1, headDim: 1,
    moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0,
    hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
  }) as unknown as ModelEntry
  const a = entry('model-a')
  const b = entry('model-b')
  // One port each: with keep-N 2, model-a runs in the primary while model-b would start in a pool slot.
  const portA = await freePort()
  const portB = await freePort()

  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => {
    c.comfyui.enabled = true
    c.gateway.autoSwap = true
    c.gateway.keepN = keepN
    c.modelProfiles[a.key] = { [engine.id]: { profile: { port: portA }, updatedAt: '' } }
    c.modelProfiles[b.key] = { [engine.id]: { profile: { port: portB }, updatedAt: '' } }
    // Registered and selected, as the registry double has it: release() reloads a model only on the selected engine.
    c.engines = [engine]
    c.activeEngineId = engine.id
  })
  const manager = new Manager(store)
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  const registry = { active: () => engine, layaEngine: () => undefined } as unknown as Registry
  // The library as the scanner has it: a test removes a model from it to stand for one deleted during a render.
  const library = [a, b]
  const scanner = {
    list: () => ({ models: library, scanning: false, lastScanAt: '' }),
    get: (key: string) => library.find((m) => m.key === key),
  } as unknown as Scanner
  const router = new ModelRouter(store, registry, manager, scanner, guard)
  guard.setPoolStopper(async () => {
    await Promise.all([...router.poolEngineIds()].map((id) => router.stopPoolSlotsOnEngine(id, { force: true })))
  })
  guard.setSwapLock((fn) => router.withSwapLock(fn))
  guard.setOnReloaded((modelKey, engineId) => router.reloadedAfterRender(modelKey, engineId))
  t.after(async () => {
    guard.stop()
    await router.stopPoolSlotsOnEngine('fake', { force: true })
    await manager.stopAndWait({ force: true })
  })
  const spawned = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean) : [])
  const slowPreflight = () => writeFileSync(join(dir, 'slow'), '')
  const fastPreflight = () => rmSync(join(dir, 'slow'), { force: true })
  const preflightBegun = async () => {
    while (!existsSync(join(dir, 'probing'))) await sleep(10)
  }
  return { a, b, store, library, manager, guard, router, spawned, slowPreflight, fastPreflight, preflightBegun }
}

const RENDERING = { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }

test('a render that begins during a pool-slot load\'s vLLM preflight: the slot engine never spawns, and the client may retry', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const r = await setUpVllm(t, 2)
  assert.ok('target' in (await r.router.route(r.a.key)))

  r.slowPreflight()
  const pending = r.router.route(r.b.key)
  await r.preflightBegun()
  await r.guard.acquire()
  const result = await pending

  assert.deepEqual(result, RENDERING)
  assert.deepEqual(r.spawned(), [r.a.path], 'model-b was never started under the render')
  assert.deepEqual(r.router.aliveSlots(), [])
})

test('a render that begins during a gateway load\'s vLLM preflight into the primary: refused before the spawn, loaded on release', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const r = await setUpVllm(t, 1)

  r.slowPreflight()
  const pending = r.router.route(r.b.key)
  await r.preflightBegun()
  await r.guard.acquire()
  const result = await pending

  assert.deepEqual(result, RENDERING, 'not served during the render')
  assert.deepEqual(r.spawned(), [])
  assert.equal(r.manager.status().state, 'error')
  assert.equal(r.guard.modelKeyLoadedOnRelease(), r.b.key, 'the load is paused, and resumed when the render ends')

  r.fastPreflight()
  await r.guard.release()
  assert.equal(r.manager.status().state, 'running')
  assert.equal(r.manager.status().model?.key, r.b.key)
  assert.deepEqual(r.spawned(), [r.b.path])
})

// ── The model last loaded, for a gateway load a render paused ─────────────────────────────────────────────
// A gateway load into the primary that a render refuses, in its pre-start hook (while it waits for the load gate or
// the reverse gate's /free call) or right before its vLLM or SGLang spawn, leaves the primary in 'error' with the
// guard's refusal; one the render kills while it starts leaves its opts with the guard. Either way the render's
// release() loads it on the Manager, which records nothing. config.lastLoaded kept naming the model the load replaced,
// so the next daemon start's resume, an Engines Start that names no model and the CLI launcher's last-used pick
// brought that one back.

test('a gateway load a render pauses in its vLLM preflight is the model last loaded once release() loads it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const r = await setUpVllm(t, 1)
  assert.ok('target' in (await r.router.route(r.a.key)))
  assert.deepEqual(r.store.snapshot().lastLoaded, { modelKey: r.a.key, engineId: 'fake' })

  r.slowPreflight()
  const pending = r.router.route(r.b.key)
  await r.preflightBegun()
  await r.guard.acquire()
  assert.deepEqual(await pending, RENDERING)
  r.fastPreflight()
  await r.guard.release()

  assert.equal(r.manager.status().state, 'running')
  assert.equal(r.manager.status().model?.key, r.b.key)
  assert.deepEqual(r.store.snapshot().lastLoaded, { modelKey: r.b.key, engineId: 'fake' })
})

test('a gateway load a render pauses in its pre-start hook is the model last loaded once release() loads it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, comfyFree, userModel, routineModel: otherModel } = await realEngineSetUp(t, { comfy: true })
  store.update((c) => { c.gateway.autoSwap = true })
  assert.ok('target' in (await modelRouter.route(userModel.key)))
  // The acquire lands during the swap's /free call: Manager.load has stopped the user's model, and the load is
  // refused by the pre-start hook once the call returns.
  comfyFree.hook = () => guard!.acquire()

  assert.deepEqual(await modelRouter.route(otherModel.key), RENDERING)
  assert.equal(guard!.modelKeyLoadedOnRelease(), otherModel.key)
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' }, 'nothing is recorded while it is paused')
  await guard!.release()

  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, otherModel.key)
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: otherModel.key, engineId: 'fake' })
})

// A render that kills the load while it starts keeps its opts for release(), which starts it on the Manager too.
test('a gateway load a render kills while it starts is the model last loaded once release() loads it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, userModel, routineModel: otherModel } = await realEngineSetUp(t, { comfy: true })
  store.update((c) => { c.gateway.autoSwap = true })
  assert.ok('target' in (await modelRouter.route(userModel.key)))
  // The stand-in engine answers /health 200 ms after it starts: the acquire lands while it is still 'starting'.
  let acquired: Promise<void> | undefined
  const watch = setInterval(() => {
    const st = manager.status()
    if (st.state === 'starting' && st.model?.key === otherModel.key) {
      clearInterval(watch)
      acquired = guard!.acquire()
    }
  }, 5)
  t.after(() => clearInterval(watch))

  assert.deepEqual(await modelRouter.route(otherModel.key), RENDERING)
  await acquired
  assert.equal(guard!.modelKeyLoadedOnRelease(), otherModel.key)
  await guard!.release()

  assert.equal(manager.status().model?.key, otherModel.key)
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: otherModel.key, engineId: 'fake' })
})

// The next prompt of an auto-queue usually acquires again while release() is loading: that render kills the resumed
// load as it starts and keeps it for its own release, which is then the one that brings it up.
test('a paused gateway load whose resume the next render kills is the model last loaded once that render ends', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, comfyFree, userModel, routineModel: otherModel } = await realEngineSetUp(t, { comfy: true })
  store.update((c) => { c.gateway.autoSwap = true })
  assert.ok('target' in (await modelRouter.route(userModel.key)))
  comfyFree.hook = () => guard!.acquire()
  assert.deepEqual(await modelRouter.route(otherModel.key), RENDERING)
  let acquired: Promise<void> | undefined
  const watch = setInterval(() => {
    const st = manager.status()
    if (st.state === 'starting' && st.model?.key === otherModel.key) {
      clearInterval(watch)
      acquired = guard!.acquire()
    }
  }, 5)
  t.after(() => clearInterval(watch))

  await guard!.release()
  await acquired
  assert.equal(guard!.modelKeyLoadedOnRelease(), otherModel.key, 'the second render keeps the resumed load')
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' })
  await guard!.release()

  assert.equal(manager.status().model?.key, otherModel.key)
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: otherModel.key, engineId: 'fake' })
})

// Only the gateway's own load. A loadExplicit() load the render paused is a routine's swap (the restore's is
// undoSwapRecord's): release() still resumes it when the routine had no model to restore, but it is not the user's
// pick, and recording it brought the routine's model back at the next start.
test("a routine's swap a render pauses is loaded by release() but is not the model last loaded", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, comfyFree, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const earlier = { modelKey: userModel.key, engineId: 'fake' }
  store.update((c) => { c.lastLoaded = { ...earlier } })
  comfyFree.hook = () => guard!.acquire()

  assert.deepEqual(await modelRouter.loadExplicit(routineModel.key), RENDERING)
  await guard!.release()

  assert.equal(manager.status().model?.key, routineModel.key, 'release() resumed the paused load')
  assert.deepEqual(store.snapshot().lastLoaded, earlier)
})

// Nor a model the library no longer has: one deleted during the render still starts from the opts Manager.load kept,
// and recording it would make the next start's resume skip it as not in the library.
test('a gateway load a render paused whose model left the library meanwhile is not the model last loaded', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const r = await setUpVllm(t, 1)
  assert.ok('target' in (await r.router.route(r.a.key)))

  r.slowPreflight()
  const pending = r.router.route(r.b.key)
  await r.preflightBegun()
  await r.guard.acquire()
  assert.deepEqual(await pending, RENDERING)
  r.library.splice(r.library.indexOf(r.b), 1)
  r.fastPreflight()
  await r.guard.release()

  assert.equal(r.manager.status().model?.key, r.b.key)
  assert.deepEqual(r.store.snapshot().lastLoaded, { modelKey: r.a.key, engineId: 'fake' })
})

// A manual Load (POST /api/v1/engine/start) records its model as soon as it is queued, and then waits for the swap
// lock, which release()'s resume of a paused gateway load holds. The resume's record of the paused load came after it:
// the user's model loaded next, but lastLoaded named the paused one, which the next daemon start's resume, an Engines
// Start that names no model and the CLI launcher's last-used pick brought back. The Load here names the model the paused
// load replaced, so the record it writes is the one there before.
test('a manual Load made while release() resumes a paused gateway load stays the model last loaded', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, registry, scanner, manager, modelRouter, guard, comfyFree, userModel, routineModel: otherModel } = await realEngineSetUp(t, { comfy: true })
  store.update((c) => { c.gateway.autoSwap = true })
  const d = {
    store, registry, scanner, manager, modelRouter, comfy: guard,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
  } as unknown as Deps
  const app = new Hono()
  app.post('/start', async (c) => startEngine(c, d, await c.req.json<EngineStartBody>()))
  assert.ok('target' in (await modelRouter.route(userModel.key)))
  comfyFree.hook = () => guard!.acquire()
  assert.deepEqual(await modelRouter.route(otherModel.key), RENDERING)

  const released = guard!.release()
  assert.equal(guard!.modelKeyReloading(), otherModel.key, 'the resume is under way')
  const res = await app.request('/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelKey: userModel.key }),
  })
  assert.equal(res.status, 202)
  await released
  while (manager.status().state !== 'running' || manager.status().model?.key !== userModel.key) await sleep(10)

  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' })
})
