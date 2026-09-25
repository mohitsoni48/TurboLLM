// Orphan-reaping regression tests. The reported bug: a daemon that dies without a
// clean shutdown (terminal window closed, killed, crashed) leaves llama-server running
// "independently" — still holding the model in RAM/VRAM and draining its queue — while
// a freshly started daemon shows "no model loaded". The fix tracks each engine in a
// pidfile and reaps survivors on the next startup. These tests pin that contract:
//   • a tracked process whose engine port is still alive → killed, pidfile removed
//   • a tracked entry whose port is dead → NOT killed (pid may be recycled), file cleared
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { reapStaleEngines } from './manager'
import { tmpDir } from '../test-support/tmp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Spawn a real child process that listens on an ephemeral loopback port and prints it.
 *  Stands in for an orphaned llama-server: a separate OS process holding an engine port. */
function spawnFakeEngine(): Promise<{ pid: number; port: number; kill: () => void; waitExit: () => Promise<void> }> {
  const child = spawn(process.execPath, [
    '-e',
    "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
  ])
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
      const m = out.match(/(\d+)/)
      if (m) {
        const exited = new Promise<void>((r) => child.once('exit', () => r()))
        resolve({
          pid: child.pid!,
          port: Number(m[1]),
          kill: () => child.kill('SIGKILL'),
          waitExit: () => exited,
        })
      }
    })
    child.once('error', reject)
  })
}

function writePidFile(dir: string, pid: number, port: number, owner?: number): void {
  const run = join(dir, 'run')
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, `engine-${pid}.pid`), JSON.stringify({ pid, port, ...(owner !== undefined ? { owner } : {}) }))
}

function pidFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'run')).filter((n) => /^engine-\d+\.pid$/.test(n))
  } catch {
    return []
  }
}

test('reaps a tracked engine whose port is still alive, and clears its pidfile', async () => {
  const dir = tmpDir('tllm-reap-')
  const eng = await spawnFakeEngine()
  try {
    writePidFile(dir, eng.pid, eng.port)

    const killed = await reapStaleEngines(dir)

    assert.equal(killed, 1, 'should report one orphan killed')
    await Promise.race([eng.waitExit(), sleep(5000)])
    assert.throws(() => process.kill(eng.pid, 0), 'the orphaned process should be dead')
    assert.equal(pidFiles(dir).length, 0, 'pidfile should be removed after reaping')
  } finally {
    eng.kill() // belt-and-suspenders in case the assert above failed before the kill landed
  }
})

test('does NOT reap an engine still owned by a live daemon (restart-overlap safety)', async () => {
  const dir = tmpDir('tllm-reap-')
  const eng = await spawnFakeEngine()
  try {
    // owner = this (alive) test process → a live daemon manages this engine; a starting
    // daemon must leave it (and its pidfile) untouched, or a restart would reap the
    // incoming daemon's freshly-loaded engine.
    writePidFile(dir, eng.pid, eng.port, process.pid)

    const killed = await reapStaleEngines(dir)

    assert.equal(killed, 0, 'an engine owned by a live daemon must not be reaped')
    assert.doesNotThrow(() => process.kill(eng.pid, 0), 'the engine should still be running')
    assert.equal(pidFiles(dir).length, 1, "the live owner's pidfile must be left in place")
  } finally {
    eng.kill()
  }
})

test('does NOT kill when the tracked port is dead (recycled-pid guard), but clears the file', async () => {
  const dir = tmpDir('tllm-reap-')
  // A pid that is extremely unlikely to exist, paired with a port nothing is listening on.
  // portAlive() returns false → reap must skip the kill entirely and just clear the file.
  writePidFile(dir, 999_999, 1) // port 1 is not bound by us

  const killed = await reapStaleEngines(dir)

  assert.equal(killed, 0, 'nothing should be killed when the engine port is dead')
  assert.equal(pidFiles(dir).length, 0, 'the stale pidfile should still be cleared')
  assert.ok(existsSync(join(dir, 'run')), 'run dir remains')
})
