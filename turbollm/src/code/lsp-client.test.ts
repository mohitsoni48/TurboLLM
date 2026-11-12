// LspClient lifecycle against a fake in-process language server (PassThrough stdio + vscode-jsonrpc on the far side):
// no real server or npx is ever spawned. Covers a server dying after the handshake and the start-failure cooldown.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import { LspClient, type LspSpawn } from './lsp-client'
import type { LspServerSpec } from './lsp-registry'

// Not 'typescript': that language first resolves tsserver through a real npx.
const spec = { language: 'python', languageId: 'python', npxArgs: ['-y', 'fake-server'] } as unknown as LspServerSpec

class FakeProc extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill() { this.killed = true; this.emit('exit', null) }
}

function fakeServer() {
  const procs: FakeProc[] = []
  const spawn: LspSpawn = () => {
    const proc = new FakeProc()
    const server = createMessageConnection(new StreamMessageReader(proc.stdin), new StreamMessageWriter(proc.stdout))
    server.onRequest('initialize', () => ({ capabilities: {} }))
    server.onNotification(() => {})
    server.listen()
    procs.push(proc)
    return proc as never
  }
  return { spawn, procs }
}

test('a server that dies after the handshake is not respawned inside the cooldown, then retried once after it', async () => {
  const clock = { t: 0 }
  const { spawn, procs } = fakeServer()
  const client = new LspClient(spec, process.cwd(), { spawn, now: () => clock.t })
  assert.deepEqual(await client.ensureStarted(), { ok: true })
  procs[0].emit('exit', 1) // the server crashed on its own
  clock.t = 1000
  const cooling = await client.ensureStarted()
  assert.equal(cooling.ok, false, 'the crash is reported as-is inside the cooldown')
  assert.deepEqual(await client.getDiagnostics('/x.py', 'x'), [], 'no diagnostics, and no turn latency')
  assert.equal(procs.length, 1, 'no respawn per edit')
  clock.t = 61_000
  assert.deepEqual(await client.ensureStarted(), { ok: true })
  assert.equal(procs.length, 2, 'one retry after the cooldown')
  client.dispose()
})

test('the initialize and diagnostics timeout timers are cleared once settled', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  const before = timers()
  const { spawn, procs } = fakeServer()
  const client = new LspClient(spec, process.cwd(), { spawn })
  await client.ensureStarted()
  assert.equal(timers(), before, 'initialize left no 60 s timer behind')
  // The fake server pushes diagnostics for whatever it is sent.
  const diagnosticsPromise = client.getDiagnostics('/x.py', 'x')
  setTimeout(() => {
    for (const w of (client as never as { waitersByUri: Map<string, Array<() => void>> }).waitersByUri.values()) for (const f of w) f()
  }, 10)
  await diagnosticsPromise
  assert.equal(timers(), before, 'a push before the 5 s wait left no timer behind')
  client.dispose()
  void procs
})

test('a spawn failure is cached only for the cooldown, then the next call retries', async () => {
  const clock = { t: 0 }
  let attempts = 0
  const healthy = fakeServer()
  const spawn: LspSpawn = (...args) => {
    if (++attempts === 1) throw new Error('npx: network down')
    return healthy.spawn(...args)
  }
  const client = new LspClient(spec, process.cwd(), { spawn, now: () => clock.t })
  assert.deepEqual(await client.ensureStarted(), { ok: false, error: 'npx: network down' })
  clock.t = 1000
  assert.deepEqual(await client.ensureStarted(), { ok: false, error: 'npx: network down' }, 'cached inside the cooldown')
  assert.equal(attempts, 1)
  clock.t = 61_000
  assert.deepEqual(await client.ensureStarted(), { ok: true })
  assert.equal(attempts, 2)
  client.dispose()
})

test('dispose then ensureStarted starts a fresh server', async () => {
  const { spawn, procs } = fakeServer()
  const client = new LspClient(spec, process.cwd(), { spawn })
  await client.ensureStarted()
  client.dispose()
  assert.equal(procs[0].killed, true)
  assert.deepEqual(await client.ensureStarted(), { ok: true })
  assert.equal(procs.length, 2)
  client.dispose()
})
