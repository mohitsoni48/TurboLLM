// The idle unload (Settings → Idle timeout, daemon.idleTtlMinutes): the watchdog stops a model nothing has used for
// that long, and never while work it cannot see in the engine's generation count still needs the model, as
// `holdsEngine` reports (cli.ts wires the chat's: a turn holding its slot, or a reply's title or memory call). A
// turn's generation and that work restart its clock: the timeout counts from the model's last use.
// Driven on a real Manager and a stand-in llama-server; the watchdog's minute and the clock are mocked.
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager, type StartOpts } from './manager'
import { freePort } from '../test-support/stand-in-engine'
import { tmpDir } from '../test-support/tmp'

/** A stand-in llama-server: answers /health on --port, and exits at once on SIGTERM. */
const FAKE_ENGINE_JS = `
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

const MINUTE = 60_000

/** A Manager running the stand-in with an idle timeout of `ttl` minutes. The watchdog's interval and the clock are
 *  mocked from before the load (the interval is armed as the engine starts), so `t.mock.timers.tick` runs it. */
async function idleManager(t: TestContext, ttl: number): Promise<Manager> {
  const dir = tmpDir('tllm-idle-')
  writeFileSync(join(dir, 'fake-engine.js'), FAKE_ENGINE_JS)
  const bin = join(dir, 'llama-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-engine.js')}" "$@"\n`)
  chmodSync(bin, 0o755)
  const opts: StartOpts = {
    engine: { id: 'fake', name: 'Fake', binPath: bin, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
    model: { key: 'A', name: 'A', quant: '', ctx: 0, vision: false },
    modelPath: join(dir, 'A.gguf'),
    extraArgs: [],
    preferredPort: await freePort(),
  }
  const store = ConfigStore.load(join(dir, 'config.json'))
  store.update((c) => { c.daemon.idleTtlMinutes = ttl })
  const manager = new Manager(store)
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  t.after(async () => {
    t.mock.timers.reset()
    await manager.stopAndWait({ force: true })
  })
  await manager.load(opts)
  assert.equal(manager.status().state, 'running')
  return manager
}

test('a chat that holds the engine keeps the model past the idle timeout; once it lets go, the timeout unloads it', {
  skip: process.platform === 'win32' && 'the stand-in engine is a POSIX shell wrapper',
}, async (t) => {
  const manager = await idleManager(t, 1)
  let held = true
  manager.holdsEngine = () => held

  t.mock.timers.tick(MINUTE + 1) // the TTL has passed since the load
  t.mock.timers.tick(10 * MINUTE)
  assert.equal(manager.status().state, 'running', 'a held chat (a title call, a compaction) keeps the model')

  held = false
  t.mock.timers.tick(MINUTE)
  assert.equal(manager.status().state, 'running', 'the timeout counts from when it let go, not from the load')
  t.mock.timers.tick(MINUTE)
  assert.notEqual(manager.status().state, 'running', 'a full timeout after it let go, the watchdog unloads it')
})

// The clock restarted only at a load and a gateway request, so a model in active chat use was unloaded between two
// replies once the timeout had passed since it was loaded, and the next send answered "Load a model first.".
test('a chat or Code turn restarts the idle clock: a turn just before the timeout keeps the model, a full timeout after its end unloads it', {
  skip: process.platform === 'win32' && 'the stand-in engine is a POSIX shell wrapper',
}, async (t) => {
  const manager = await idleManager(t, 1)
  manager.holdsEngine = () => false

  t.mock.timers.tick(50_000)
  manager.generationStart() // a reply, 50 s after the load
  t.mock.timers.tick(5_000)
  manager.generationEnd() // it ends 55 s after the load
  t.mock.timers.tick(MINUTE + 5_000 - 55_000) // the watchdog's tick at a minute after the load, the TTL + 5 s
  assert.equal(manager.status().state, 'running', 'used 10 s ago: kept')
  t.mock.timers.tick(MINUTE)
  assert.notEqual(manager.status().state, 'running', 'the next tick, more than a full timeout after the reply ended, unloads it')
})

test('with nothing held the idle timeout unloads the model as before, and 0 never does', {
  skip: process.platform === 'win32' && 'the stand-in engine is a POSIX shell wrapper',
}, async (t) => {
  const disabled = await idleManager(t, 0)
  disabled.holdsEngine = () => false
  t.mock.timers.tick(24 * 60 * MINUTE)
  assert.equal(disabled.status().state, 'running', 'an idle timeout of 0 never unloads')
  t.mock.timers.reset()

  const unwired = await idleManager(t, 1) // a pool slot's Manager: no holdsEngine
  t.mock.timers.tick(MINUTE)
  assert.equal(unwired.status().state, 'running', 'not before the TTL has passed')
  t.mock.timers.tick(MINUTE)
  assert.notEqual(unwired.status().state, 'running', 'unloaded once it has')
})
