// ComfyUI acquiring the GPU in the middle of a model swap, against a real Manager: the user clicks Load
// on model B while A runs, and a render starts while A is still stopping (a graceful stop takes up to
// 8 s). acquire() used to return at once with A still resident, and B then loaded during the render.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { ComfyGuard } from './comfy-guard'
import { Manager, type StartOpts } from './manager'
import { freePort } from '../test-support/stand-in-engine'
import { tmpDir } from '../test-support/tmp'

/** A stand-in llama-server: answers /health on --port, and takes FAKE_TERM_DELAY_MS to exit on SIGTERM.
 *  It binds the port it is handed, so every test here pins that port (preferredPort) to a free ephemeral one: the
 *  8081+ walk is shared with other test files' engines in a parallel run, and two of them handed the same port made
 *  the second die with EADDRINUSE (see freePort). The Manager stops and waits for one engine before it starts the
 *  next, so one port per test serves every model it loads. */
const FAKE_ENGINE_JS = `
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500))
`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a render that starts while a swap is stopping the old model kills it, and the new model is not loaded under it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-swap-')
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const port = await freePort()
  const opts = (key: string): StartOpts => ({
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key, name: key, quant: '', ctx: 0, vision: false },
    modelPath: join(dir, `${key}.gguf`),
    extraArgs: [],
    preferredPort: port,
  })
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  await manager.load(opts('A'))
  assert.equal(manager.status().state, 'running')

  const swap = manager.load(opts('B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() })
  await sleep(300)
  assert.equal(manager.status().state, 'stopping')
  const t0 = Date.now()
  await guard.acquire()
  const acquireMs = Date.now() - t0
  await assert.rejects(swap, /ComfyUI is rendering/)

  assert.ok(acquireMs < 1000, `A was killed rather than left to its graceful stop (${acquireMs} ms)`)
  assert.equal(manager.status().state, 'error')
  assert.match(manager.status().err?.message ?? '', /ComfyUI is rendering/)
  assert.equal(guard.isBlocked(), true)
  assert.equal(guard.modelKeyLoadedOnRelease(), 'B', 'the gateway is told B comes up when the render ends')

  // The error says loading resumes when the queue finishes: release() loads B (A was killed, not suspended).
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'B')
})

// The release route answers before the reload, so the next prompt's acquire can come before the paused load reaches
// its start. That load used to restart with no ComfyUI check and came up under the new render.
test('a paused load the release resumes is refused again by an acquire that lands first, and that render\'s release loads it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-resume-')
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const port = await freePort()
  const opts = (key: string): StartOpts => ({
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key, name: key, quant: '', ctx: 0, vision: false },
    modelPath: join(dir, `${key}.gguf`),
    extraArgs: [],
    preferredPort: port,
  })
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  await guard.acquire()
  // A load of B reaches its start during the render: refused, and resumed when the queue finishes.
  await assert.rejects(manager.load(opts('B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() }), /ComfyUI is rendering/)

  const resumed = guard.release()
  await guard.acquire() // the next prompt
  await resumed

  assert.equal(manager.status().state, 'error', 'B did not start under the new render')
  assert.match(manager.status().err?.message ?? '', /ComfyUI is rendering/)
  assert.equal(guard.modelKeyLoadedOnRelease(), 'B')

  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'B')
})

/** A stand-in vLLM venv python: `-c` is the engine preflight (`import uvloop`), which takes 1 s while a `slow` file
 *  exists and first writes `probing`; anything else runs FAKE_ENGINE_JS. */
function fakeVllmPython(dir: string): string {
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'python')
  writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then',
    `  if [ -f "${join(dir, 'slow')}" ]; then : > "${join(dir, 'probing')}"; sleep 1; fi`,
    '  exit 0',
    'fi',
    `exec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"`,
    '',
  ].join('\n'))
  chmodSync(bin, 0o755)
  return bin
}

const vllmOpts = (bin: string, dir: string, key: string, port: number): StartOpts => ({
  engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'vllm', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
  model: { key, name: key, quant: '', ctx: 0, vision: false },
  modelPath: join(dir, key),
  extraArgs: [],
  preferredPort: port,
})

/** Resolves once the slow preflight has begun: the reload is past its pre-start hook and has not spawned. */
async function preflightBegun(dir: string): Promise<void> {
  while (!existsSync(join(dir, 'probing'))) await sleep(10)
}

// The reload's start awaits the engine preflight (vLLM and SGLang import uvloop first, about 1 s) after its pre-start
// hook. The next prompt's acquire landing there found the engine stopped and suspended nothing; the reload then
// brought the LLM up under that render, and nothing stopped it or reloaded it after.
test('an acquire during the reload\'s engine preflight: the model does not come up under the render, and its release reloads it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-preflight-')
  const bin = fakeVllmPython(dir)
  const port = await freePort()
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  await manager.load(vllmOpts(bin, dir, 'A', port))
  assert.equal(manager.status().state, 'running')
  await guard.acquire()

  writeFileSync(join(dir, 'slow'), '')
  const reloading = guard.release()
  await preflightBegun(dir)
  await guard.acquire() // the next prompt
  await reloading

  assert.equal(manager.status().state, 'stopped', 'A did not start under the new render')
  assert.equal(guard.isBlocked(), true)
  assert.equal(guard.snapshot().suspendedModelKey, 'A', 'still the model to reload')

  rmSync(join(dir, 'slow'))
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'A')
})

test('a paused load the release resumes is refused right before its spawn by an acquire during its preflight', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-preflight-resume-')
  const bin = fakeVllmPython(dir)
  const port = await freePort()
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  await guard.acquire()
  await assert.rejects(
    manager.load(vllmOpts(bin, dir, 'B', port), { beforeStart: () => guard.freeComfyUIBeforeLoad() }),
    /ComfyUI is rendering/,
  )

  writeFileSync(join(dir, 'slow'), '')
  const resumed = guard.release()
  await preflightBegun(dir)
  await guard.acquire() // the next prompt
  await resumed

  assert.equal(manager.status().state, 'error', 'B did not start under the new render')
  assert.match(manager.status().err?.message ?? '', /ComfyUI is rendering/)
  assert.equal(guard.modelKeyLoadedOnRelease(), 'B')

  rmSync(join(dir, 'slow'))
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'B')
})

// onLoadSettled is what cli.ts reports as telemetry's model_load. A load a render paused reported there as a failed
// load (load_failed), each time a render refused it, though the render's release resumes it and that load reports its
// own outcome.
test('a load a render paused, in its pre-start hook or right before its spawn, is not reported as a failed load; the load its release resumes is', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-paused-report-')
  const bin = fakeVllmPython(dir)
  const port = await freePort()
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  const reports: { ok: boolean; key: string }[] = []
  manager.onLoadSettled = (ok, _err, o) => reports.push({ ok, key: o.model.key })
  await guard.acquire()
  await assert.rejects(
    manager.load(vllmOpts(bin, dir, 'B', port), { beforeStart: () => guard.freeComfyUIBeforeLoad() }),
    /ComfyUI is rendering/,
  )
  assert.deepEqual(reports, [], 'refused in its pre-start hook: not reported')

  writeFileSync(join(dir, 'slow'), '')
  const resumed = guard.release()
  await preflightBegun(dir)
  await guard.acquire() // the next prompt
  await resumed
  assert.equal(manager.status().state, 'error', 'B did not start under the new render')
  assert.deepEqual(reports, [], 'refused right before its spawn: not reported')

  rmSync(join(dir, 'slow'))
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.deepEqual(reports, [{ ok: true, key: 'B' }], 'the load that ran is reported once')
})

/** A stand-in llama-server that binds its port only 1 s after it starts while a `slow-listen` file exists beside it,
 *  so a test can catch its load still starting. */
function slowListenEngine(dir: string, port: number): (key: string) => StartOpts {
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS.replace(
    /http\.createServer\((.*)\)\.listen\(port, '127\.0\.0\.1'\)/,
    `const listen = () => http.createServer($1).listen(port, '127.0.0.1')
setTimeout(listen, require('fs').existsSync(require('path').join(__dirname, 'slow-listen')) ? 1000 : 0)`,
  ))
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  return (key) => ({
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key, name: key, quant: '', ctx: 0, vision: false },
    modelPath: join(dir, `${key}.gguf`),
    extraArgs: [],
    preferredPort: port,
  })
}

async function untilStarting(manager: Manager): Promise<void> {
  while (manager.status().state !== 'starting') await sleep(10)
}

// A render whose acquire catches a load still starting kills it and keeps its model for the release, which reloads it
// with Manager.start. That load was reported as a failed load, and the reload that brought the model up reported
// nothing. The readiness wait is the longest part of a load, so this is how most loads a render paused were counted.
test('a load a render stops while it starts is not reported as a failed load; the reload of it after the render is, once', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-stopped-report-')
  const opts = slowListenEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  const reports: { ok: boolean; key: string }[] = []
  manager.onLoadSettled = (ok, _err, o) => reports.push({ ok, key: o.model.key })
  writeFileSync(join(dir, 'slow-listen'), '')
  const load = manager.load(opts('B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() })
  await untilStarting(manager)
  await guard.acquire()
  await load
  assert.equal(manager.status().state, 'stopped')
  assert.equal(guard.snapshot().suspendedModelKey, 'B')
  assert.deepEqual(reports, [], 'stopped while it started: not reported')

  const reload = guard.release()
  await untilStarting(manager)
  await guard.acquire() // the next prompt
  await reload
  assert.equal(manager.status().state, 'stopped')
  assert.deepEqual(reports, [], 'its reload, stopped while it started: not reported')

  rmSync(join(dir, 'slow-listen'))
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.deepEqual(reports, [{ ok: true, key: 'B' }], 'the reload that ran is reported once')

  // A model running when the render began was reported by its own load: its reload is not reported again.
  await guard.acquire()
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.deepEqual(reports, [{ ok: true, key: 'B' }])
})

// A release can land while the acquire is still killing that load (the kill waits for the process to exit). It takes
// the suspended model, and its reload is refused under the render the acquire goes on to hold, which keeps the model
// for that render's release. Marked as a load that reports only once the kill was over, the model was taken unmarked
// and its reload after the render was never reported.
test('a release landing while the render kills a starting load still has the reload of it reported once', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-kill-release-report-')
  const opts = slowListenEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  const reports: { ok: boolean; key: string }[] = []
  manager.onLoadSettled = (ok, _err, o) => reports.push({ ok, key: o.model.key })
  writeFileSync(join(dir, 'slow-listen'), '')
  const load = manager.load(opts('B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() })
  await untilStarting(manager)
  const acquired = guard.acquire()
  const released = guard.release() // the acquire is still killing B
  await acquired
  await released
  await load
  assert.equal(manager.status().state, 'stopped', 'the reload was refused under the render')
  assert.equal(guard.snapshot().suspendedModelKey, 'B')
  assert.deepEqual(reports, [])

  rmSync(join(dir, 'slow-listen'))
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.deepEqual(reports, [{ ok: true, key: 'B' }], 'the reload that ran is reported once')
})

// An engine update, delete or purge does not wait for a render: the model is already unloaded, so nothing refuses it.
// A purge (or an official llama.cpp backend's update, which registers the new build under a new id and deletes the old
// one's folder) removed the engine and its binary, and the reload then started that binary: engine_spawn_failed, ENOENT.
function fakeLlamaEngine(dir: string, port: number) {
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\necho spawned >> "${join(dir, 'spawns')}"\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const engine: StartOpts['engine'] = { id: 'fake', name: 'Fake llama.cpp', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }
  const opts = (key: string): StartOpts => ({
    engine, model: { key, name: key, quant: '', ctx: 0, vision: false }, modelPath: join(dir, `${key}.gguf`), extraArgs: [],
    preferredPort: port,
  })
  const registered = new Map([[engine.id, engine]])
  const spawns = () => (existsSync(join(dir, 'spawns')) ? readFileSync(join(dir, 'spawns'), 'utf8').split('\n').filter(Boolean).length : 0)
  // What a purge does to it: unregistered, and its folder deleted.
  const purge = () => {
    registered.delete(engine.id)
    rmSync(bin)
  }
  // What a release engine's update, a same-named zip re-upload or a TurboQuant release with a new archive layout can
  // do: the id is kept, but the new build folder puts the binary at another path (Registry.refresh or repairBinPath
  // records it) and the old one is gone. `missing`: nothing is at the new path (yet).
  const moved = join(dir, 'llama-server-new')
  const moveBinary = (o: { missing?: boolean } = {}) => {
    if (!o.missing) {
      writeFileSync(moved, readFileSync(bin))
      chmodSync(moved, 0o755)
    }
    registered.set(engine.id, { ...engine, binPath: moved, version: 'new build' })
    rmSync(bin)
  }
  return { opts, registered, spawns, purge, moveBinary, moved }
}

test('an engine purged during a render: release does not start its missing binary, and the model stays unloaded', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-purged-')
  const e = fakeLlamaEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  guard.setEngineLookup((id) => e.registered.get(id))
  t.after(() => guard.stop())
  await manager.load(e.opts('A'))

  // A render while the engine is still registered on the same binary (as after an update in place): A is reloaded.
  await guard.acquire()
  await guard.release()
  assert.equal(manager.status().state, 'running')
  assert.equal(e.spawns(), 2)

  await guard.acquire()
  e.purge()
  await guard.release()

  assert.equal(manager.status().state, 'stopped', 'nothing was started')
  assert.equal(manager.status().err, null)
  assert.equal(e.spawns(), 2)
  assert.equal(guard.isBlocked(), false)
  assert.equal(guard.snapshot().suspendedModelKey, null)
})

test('a paused load whose engine was purged during the render is not started, and its error says why', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-purged-paused-')
  const e = fakeLlamaEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  guard.setEngineLookup((id) => e.registered.get(id))
  t.after(() => guard.stop())
  await guard.acquire()
  await assert.rejects(manager.load(e.opts('B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() }), /ComfyUI is rendering/)

  e.purge()
  await guard.release()

  assert.equal(manager.status().state, 'error')
  assert.equal(
    manager.status().err?.message,
    'Fake llama.cpp was updated or removed while ComfyUI was rendering, so the model was not loaded again. Load it from Models.',
  )
  assert.equal(e.spawns(), 0)
})

// It used to be refused like a purged one, so the model stayed unloaded after the render, while an update that kept the
// binary's path was reloaded.
test('an engine updated to a binary at a new path during a render: release reloads the model on the new binary', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-moved-')
  const e = fakeLlamaEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  guard.setEngineLookup((id) => e.registered.get(id))
  t.after(() => guard.stop())
  await manager.load(e.opts('A'))

  await guard.acquire()
  e.moveBinary()
  await guard.release()

  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'A')
  assert.equal(manager.currentOpts()?.engine.binPath, e.moved, 'started from the new binary')
  assert.equal(manager.currentOpts()?.engine.version, 'new build', 'with the engine as registered now')
  assert.equal(e.spawns(), 2)
  assert.equal(guard.isBlocked(), false)
  assert.equal(guard.snapshot().suspendedModelKey, null)
})

test('a paused load whose engine moved to a new path during the render is started on the new binary', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-moved-paused-')
  const e = fakeLlamaEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  guard.setEngineLookup((id) => e.registered.get(id))
  t.after(() => guard.stop())
  await guard.acquire()
  await assert.rejects(manager.load(e.opts('B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() }), /ComfyUI is rendering/)

  e.moveBinary()
  await guard.release()

  assert.equal(manager.status().state, 'running')
  assert.equal(manager.status().model?.key, 'B')
  assert.equal(manager.currentOpts()?.engine.binPath, e.moved)
  assert.equal(e.spawns(), 1)
})

test('an engine moved to a binary that is missing during a render: release does not start the old, deleted binary', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-comfy-moved-missing-')
  const e = fakeLlamaEngine(dir, await freePort())
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  guard.setEngineLookup((id) => e.registered.get(id))
  t.after(() => guard.stop())
  await manager.load(e.opts('A'))

  await guard.acquire()
  e.moveBinary({ missing: true })
  await guard.release()

  assert.equal(manager.status().state, 'stopped', 'nothing was started')
  assert.equal(manager.status().err, null)
  assert.equal(e.spawns(), 1)
  assert.equal(guard.isBlocked(), false)
  assert.equal(guard.snapshot().suspendedModelKey, null)
})
