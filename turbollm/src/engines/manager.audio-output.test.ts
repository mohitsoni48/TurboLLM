// What the manager learns from the engine about a model that answers aloud (GET /v1/models, loadTiming.audioOutput):
// the flag is per load, only ever a "yes" from the running engine, and gone when the engine stops. Real loads against
// a stand-in engine, as manager.audio-input.test.ts runs them.
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

async function fakeEngine(dir: string): Promise<StartOpts> {
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  return {
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key: 'A', name: 'A', quant: '', ctx: 0, vision: false },
    modelPath: join(dir, 'A.gguf'),
    extraArgs: [],
    preferredPort: await freePort(),
  }
}

/** The probes run after the manager flips to running, without being awaited by the load: let them settle. */
const settle = () => new Promise<void>((r) => setImmediate(r))

async function loaded(t: { after: (fn: () => unknown) => void }, answer: boolean | null) {
  const dir = tmpDir('tllm-audio-output-')
  loadTiming.audioInput = async () => null
  loadTiming.audioOutput = async () => answer
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  await manager.load(await fakeEngine(dir))
  await settle()
  assert.equal(manager.status().state, 'running')
  return { manager, dir }
}

const skip = process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary'

test('a model the engine says answers aloud is reported as audioOut', { skip }, async (t) => {
  const { manager } = await loaded(t, true)
  assert.equal(manager.status().model?.audioOut, true)
})

test('"no" and "does not say" both leave the flag absent: there is no model-file fallback for output', { skip }, async (t) => {
  for (const answer of [false, null]) {
    const { manager } = await loaded(t, answer)
    assert.ok(!('audioOut' in manager.status().model!), `answer ${answer}`)
  }
})

test('the answer is forgotten when the engine stops, and a second load learns its own', { skip }, async (t) => {
  const { manager, dir } = await loaded(t, true)
  await manager.stopAndWait()
  assert.equal((manager as unknown as { audioOutput: unknown }).audioOutput, false, 'reset on termination')

  loadTiming.audioOutput = async () => null
  await manager.load(await fakeEngine(dir))
  await settle()
  assert.equal(manager.status().state, 'running')
  assert.ok(!('audioOut' in manager.status().model!), 'the first load\'s answer does not carry over')
})

test('whenModalitiesKnown waits for a probe that is still in flight, so a request that just routed a model in reads its answer', { skip }, async (t) => {
  const dir = tmpDir('tllm-audio-output-')
  loadTiming.audioInput = async () => null
  loadTiming.audioOutput = async () => {
    await new Promise((r) => setTimeout(r, 150))
    return true
  }
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  await manager.load(await fakeEngine(dir))
  assert.ok(!('audioOut' in manager.status().model!), 'the probe has not answered yet')
  await manager.whenModalitiesKnown()
  assert.equal(manager.status().model?.audioOut, true)
})
