// A gateway request for the model a ComfyUI render unloaded, landing while release() reloads it, against a real
// ConfigStore, Manager, ComfyGuard and ModelRouter wired as cli.ts wires them, and a fake llama-server. The reload ran
// outside the router's swap lock, so doLoad found no running target: with keep-N 1 it evicted the starting primary as
// LRU and loaded the same model again (three spawns, not two); with keep-N 2 it loaded a second copy into a pool slot.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { ComfyGuard } from '../engines/comfy-guard'
import { Manager } from '../engines/manager'
import type { Registry } from '../engines/registry'
import type { ModelEntry, Scanner } from '../models/scanner'
import { tmpDir } from '../test-support/tmp'
import { ModelRouter } from './model-router'

/** A stand-in llama-server: notes each spawn in $SPAWN_LOG, answers /health on --port once 1 s has passed (the model
 *  "loads"), and exits at once on SIGTERM. */
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

function setUp(t: { after: (fn: () => unknown) => void }, keepN: number) {
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

  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => {
    c.comfyui.enabled = true
    c.gateway.autoSwap = true
    c.gateway.keepN = keepN
  })
  const manager = new Manager(store)
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  const registry = { active: () => engine, layaEngine: () => undefined, litertLmEngine: () => undefined } as unknown as Registry
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
  t.after(async () => {
    guard.stop()
    await router.stopPoolSlotsOnEngine('fake', { force: true })
    await manager.stopAndWait({ force: true })
  })
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length : 0)
  return { model, manager, guard, router, spawns }
}

/** Load the model, render, and route it again just after the render ends, while release() is reloading it. */
async function renderThenRouteDuringReload(r: ReturnType<typeof setUp>) {
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
  const r = setUp(t, 1)

  const after = await renderThenRouteDuringReload(r)

  assert.ok('target' in after, JSON.stringify(after))
  assert.equal(after.target, r.manager.target())
  assert.equal(r.spawns(), 2, 'loaded once, reloaded once: the starting reload is not evicted and loaded again')
  assert.deepEqual(r.router.aliveSlots().map((s) => [s.modelKey, s.state, s.primary]), [[r.model.key, 'running', true]])
})

test('with keep-N 2 that request gets the reloading primary, not a second copy in a pool slot', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const r = setUp(t, 2)

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
 *  first writes `probing`; anything else is the server, which notes the model in $SPAWN_LOG and answers /health. */
const FAKE_VLLM_JS = `
const fs = require('fs')
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
fs.appendFileSync(process.env.SPAWN_LOG, args[args.indexOf('--model') + 1] + '\\n')
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

function setUpVllm(t: { after: (fn: () => unknown) => void }, keepN: number) {
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

  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => {
    c.comfyui.enabled = true
    c.gateway.autoSwap = true
    c.gateway.keepN = keepN
  })
  const manager = new Manager(store)
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  const registry = { active: () => engine, layaEngine: () => undefined, litertLmEngine: () => undefined } as unknown as Registry
  const scanner = {
    list: () => ({ models: [a, b], scanning: false, lastScanAt: '' }),
    get: (key: string) => [a, b].find((m) => m.key === key),
  } as unknown as Scanner
  const router = new ModelRouter(store, registry, manager, scanner, guard)
  guard.setPoolStopper(async () => {
    await Promise.all([...router.poolEngineIds()].map((id) => router.stopPoolSlotsOnEngine(id, { force: true })))
  })
  guard.setSwapLock((fn) => router.withSwapLock(fn))
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
  return { a, b, manager, guard, router, spawned, slowPreflight, fastPreflight, preflightBegun }
}

const RENDERING = { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }

test('a render that begins during a pool-slot load\'s vLLM preflight: the slot engine never spawns, and the client may retry', {
  skip: process.platform === 'win32' && 'uses a POSIX shell script as the fake engine interpreter',
}, async (t) => {
  const r = setUpVllm(t, 2)
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
  const r = setUpVllm(t, 1)

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
