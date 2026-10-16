// ComfyUI acquiring the GPU in the middle of a model swap, against a real Manager: the user clicks Load
// on model B while A runs, and a render starts while A is still stopping (a graceful stop takes up to
// 8 s). acquire() used to return at once with A still resident, and B then loaded during the render.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { ComfyGuard } from './comfy-guard'
import { Manager, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

/** A stand-in llama-server: answers /health on --port, and takes FAKE_TERM_DELAY_MS to exit on SIGTERM. */
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
  const opts = (key: string): StartOpts => ({
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key, name: key, quant: '', ctx: 0, vision: false },
    modelPath: join(dir, `${key}.gguf`),
    extraArgs: [],
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
  const opts = (key: string): StartOpts => ({
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key, name: key, quant: '', ctx: 0, vision: false },
    modelPath: join(dir, `${key}.gguf`),
    extraArgs: [],
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

const vllmOpts = (bin: string, dir: string, key: string): StartOpts => ({
  engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'vllm', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
  model: { key, name: key, quant: '', ctx: 0, vision: false },
  modelPath: join(dir, key),
  extraArgs: [],
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
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  await manager.load(vllmOpts(bin, dir, 'A'))
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
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.comfyui.enabled = true })
  const manager = new Manager(store)
  t.after(() => manager.stopAndWait({ force: true }))
  const guard = new ComfyGuard(store, manager, 30, async () => ({ ok: true, status: 200 }))
  t.after(() => guard.stop())
  await guard.acquire()
  await assert.rejects(
    manager.load(vllmOpts(bin, dir, 'B'), { beforeStart: () => guard.freeComfyUIBeforeLoad() }),
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
