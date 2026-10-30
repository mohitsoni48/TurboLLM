// Stopping an engine (a Stop, a model swap's stop inside the load gate, a pool eviction, an update's stop): it must end
// as soon as the engine can be ended, and leave nothing running behind it.
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
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

/** The stand-in binds its port at once and exits when it is taken, so its model is pinned to a free port: on the
 *  8081+ walk, an engine test in a parallel run could take the same port first (EADDRINUSE, state 'error'). */
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

// A plain `taskkill /PID <pid> /T` only posts WM_CLOSE to the process's windows. The engines are console programs with
// none (spawned windowsHide with piped stdio), so Windows refuses it ("This process can only be terminated forcefully
// (with /F option)") and every stop sat out the 8 s grace before the force kill, inside the load gate for a model swap.
// Faked here on POSIX with a `taskkill` stand-in that refuses the same way.
test('stopAndWait() on Windows: taskkill /F /T at once, instead of a plain taskkill and the 8 s wait', {
  skip: process.platform === 'win32' && 'fakes Windows on a POSIX host',
}, async (t) => {
  const dir = tmpDir('tllm-winstop-')
  const argsFile = join(dir, 'taskkill-args')
  writeFileSync(join(dir, 'taskkill'), [
    '#!/bin/sh',
    `echo "$@" >> '${argsFile}'`,
    'case " $* " in *" /F "*) kill -9 "$2"; exit 0 ;; esac',
    'echo "ERROR: The process with PID $2 could not be terminated." >&2',
    'echo "Reason: This process can only be terminated forcefully (with /F option)." >&2',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 })
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  await manager.load(await fakeEngine(dir))
  assert.equal(manager.status().state, 'running')
  const pid = manager.status().pid

  const actualPlatform = process.platform
  const actualPath = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${actualPath ?? ''}`
  try {
    const started = Date.now()
    let stopped: Promise<void>
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      stopped = manager.stopAndWait()
    } finally {
      Object.defineProperty(process, 'platform', { value: actualPlatform })
    }
    await stopped
    const took = Date.now() - started
    assert.equal(readFileSync(argsFile, 'utf8').split('\n')[0], `/PID ${pid} /F /T`, 'the first taskkill forces the tree')
    assert.ok(took < 4000, `stopAndWait() took ${took} ms`)
    assert.equal(manager.status().state, 'stopped')
  } finally {
    process.env.PATH = actualPath
  }
})

// The stop raced the engine's exit against an 8 s sleep (and stopAndWait's wait against a 10 s one) it never cleared:
// ref'd timers that, after a prompt exit, held the event loop (a test file, a CLI run) open for the rest of them.
test('stopAndWait(): an engine that exits promptly leaves no grace timer behind', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const dir = tmpDir('tllm-stoptimer-')
  const manager = new Manager(ConfigStore.load(join(dir, 'config.json')))
  t.after(() => manager.stopAndWait({ force: true }))
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  await manager.load(await fakeEngine(dir))
  assert.equal(manager.status().state, 'running')
  // Counted right before the stop, so the count is the stop's alone: a timer an earlier test left behind (a failed
  // load's 200-500 ms polls) has fired during this load's own readiness wait.
  const before = timers()

  await manager.stopAndWait()

  assert.equal(manager.status().state, 'stopped')
  assert.equal(timers(), before, 'no timer is left holding the process open')
})
