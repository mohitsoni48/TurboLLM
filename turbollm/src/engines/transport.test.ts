// How the Manager reaches an engine it spawned (plan D-5, architecture §6.3): its own loopback port, no credentials, and
// a stop by signal that resolves once the process is gone. The seam lets D-6 add an engine the daemon does not spawn;
// the spawned path is today's code moved, so the Manager's own tests (manager*.test.ts) are the proof it is unchanged.
// The stand-in process here is a plain `node -e` that never opens a socket.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { SpawnedTransport } from './transport'

const ENGINE_PORT = 1

/** A process that runs until it is ended, and the promise the Manager's `exited` is: resolved at its 'close'. */
function idleProcess(t: TestContext): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  return { child, exited }
}

const hasEnded = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

test('a spawned engine is reached on its own loopback port, the URL Manager.target() has always returned', (t) => {
  const { child, exited } = idleProcess(t)
  assert.equal(new SpawnedTransport(child, ENGINE_PORT, exited).target(), `http://127.0.0.1:${ENGINE_PORT}`)
})

test('a spawned engine needs no credentials of its own', (t) => {
  const { child, exited } = idleProcess(t)
  assert.deepEqual(new SpawnedTransport(child, ENGINE_PORT, exited).headers(), {})
})

test('stop() resolves once the engine process has exited', async (t) => {
  const { child, exited } = idleProcess(t)
  await new SpawnedTransport(child, ENGINE_PORT, exited).stop()
  assert.ok(hasEnded(child), 'the process is gone when stop() resolves')
})

test('kill() ends the engine process without the grace period', async (t) => {
  const { child, exited } = idleProcess(t)
  const started = Date.now()
  new SpawnedTransport(child, ENGINE_PORT, exited).kill()
  await exited
  assert.ok(hasEnded(child))
  assert.ok(Date.now() - started < 4000, 'well inside the 8 s graceful grace')
})
