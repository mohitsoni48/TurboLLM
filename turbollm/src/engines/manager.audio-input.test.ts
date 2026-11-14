// What the manager learns from the engine once it is ready: whether its model takes audio (GET /props, loadTiming
// .audioInput). The answer overrides what the model's file declared, and is per load: a model that hears must not leave
// the next one looking as if it does. Real loads against a stand-in engine, as manager.stop.test.ts runs them.
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { ConfigStore } from '../config/config'
import { loadTiming, Manager, type StartOpts } from './manager'
import { freePort } from '../test-support/stand-in-engine'
import { tmpDir } from '../test-support/tmp'

const real = { ...loadTiming }
afterEach(() => Object.assign(loadTiming, real))

const FAKE_ENGINE_JS = `
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

async function fakeEngine(dir: string, audio?: boolean): Promise<StartOpts> {
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  return {
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key: 'A', name: 'A', quant: '', ctx: 0, vision: false, ...(audio === undefined ? {} : { audio }) },
    modelPath: join(dir, 'A.gguf'),
    extraArgs: [],
    preferredPort: await freePort(),
  }
}

/** The audio probe runs after the manager flips to running, without being awaited by the load: let it settle. */
const settle = () => new Promise<void>((r) => setImmediate(r))

async function loaded(t: { after: (fn: () => unknown) => void }, answer: boolean | null, modelAudio?: boolean) {
  const dir = tmpDir('tllm-audio-input-')
  loadTiming.audioInput = async () => answer
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  await manager.load(await fakeEngine(dir, modelAudio))
  await settle()
  assert.equal(manager.status().state, 'running')
  return { manager, dir }
}

const skip = process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary'

test('a model the engine says hears audio is reported as audio', { skip }, async (t) => {
  const { manager } = await loaded(t, true)
  assert.equal(manager.status().model?.audio, true)
})

test('an engine that does not say leaves the model as it was loaded', { skip }, async (t) => {
  const { manager } = await loaded(t, null)
  assert.ok(!('audio' in manager.status().model!))
  const withFlag = await loaded(t, null, true)
  assert.equal(withFlag.manager.status().model?.audio, true, 'the load-time flag stands')
})

test('an engine that says no overrides a load-time audio flag', { skip }, async (t) => {
  const { manager } = await loaded(t, false, true)
  assert.equal(manager.status().model?.audio, false)
})

test('the answer is forgotten when the engine stops, and a second load learns its own', { skip }, async (t) => {
  const { manager, dir } = await loaded(t, true)
  assert.equal(manager.status().model?.audio, true)
  await manager.stopAndWait()
  assert.equal((manager as unknown as { audioInput: unknown }).audioInput, null, 'reset on termination')

  loadTiming.audioInput = async () => null
  await manager.load(await fakeEngine(dir))
  await settle()
  assert.equal(manager.status().state, 'running')
  assert.ok(!('audio' in manager.status().model!), 'the first load\'s answer does not carry over')
})
