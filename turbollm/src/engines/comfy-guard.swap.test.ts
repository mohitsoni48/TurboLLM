// ComfyUI acquiring the GPU in the middle of a model swap, against a real Manager: the user clicks Load
// on model B while A runs, and a render starts while A is still stopping (a graceful stop takes up to
// 8 s). acquire() used to return at once with A still resident, and B then loaded during the render.
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
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
