import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChildTunnel, killTrackedTunnelsSync, reapStaleTunnels } from './child-process'
import { tmpDir } from '../test-support/tmp'

test('ChildTunnel: a binary that cannot be spawned rejects the start instead of crashing the daemon', async () => {
  // ENOENT on every platform: the cached cloudflared/ngrok was deleted or quarantined after
  // provisioning. Node reports it only as an 'error' event (no 'exit'); unlistened, that event
  // is an uncaught exception that kills this test process — and the daemon.
  const dataDir = tmpDir('child-tunnel-')
  const t = new ChildTunnel(dataDir)
  await assert.rejects(
    t.spawnAndWait(join(dataDir, 'missing-cloudflared'), ['tunnel'], /https:\/\/\S+/, 5_000),
    (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
  )
  assert.equal(t.alive(), false, 'nothing is tracked as running')
  await t.stop() // and a later stop() has nothing to wait for
})

// ── reapStaleTunnels: only a pid that is provably still our provider is killed ──────────────
// A daemon killed without its exit handler (power loss, OS update reboot) leaves tunnel pidfiles
// behind, and on the next boot their pids usually belong to unrelated processes — which SIGKILL /
// `taskkill /F /T` would take down with their whole tree. Same rule as reapStaleTerminals.

function tunnelPidFiles(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'run')).filter((n) => /^tunnel-\d+\.pid$/.test(n))
  } catch {
    return []
  }
}

function spawnUnrelated(): Promise<{ pid: number; kill: () => void; exited: Promise<void> }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'])
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      const exited = new Promise<void>((r) => child.once('exit', () => r()))
      resolve({ pid: child.pid!, kill: () => child.kill('SIGKILL'), exited })
    })
    child.once('error', reject)
  })
}

function writeTunnelPidFile(dataDir: string, pid: number, startedAt?: number): void {
  mkdirSync(join(dataDir, 'run'), { recursive: true })
  // owner 0: ownerless, i.e. the daemon that wrote it is gone.
  writeFileSync(join(dataDir, 'run', `tunnel-${pid}.pid`), JSON.stringify({ pid, owner: 0, ...(startedAt !== undefined ? { startedAt } : {}) }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('reapStaleTunnels: reaps a provider orphaned by a dead daemon, verified by the start time its pidfile recorded', async () => {
  const dataDir = tmpDir('child-tunnel-reap-')
  const t = new ChildTunnel(dataDir)
  try {
    await t.spawnAndWait(process.execPath, ['-e', "console.log('https://orphan.example.com'); setInterval(() => {}, 60000)"], /https:\/\/\S+/, 10_000)
    const [name] = tunnelPidFiles(dataDir)
    assert.ok(name, 'the provider is tracked')
    const rec = JSON.parse(readFileSync(join(dataDir, 'run', name), 'utf8')) as { pid: number; startedAt?: number }
    assert.equal(typeof rec.startedAt, 'number', 'the pidfile records when the provider was spawned')
    // The daemon that owned it dies without its exit handler: only the owner changes.
    writeTunnelPidFile(dataDir, rec.pid, rec.startedAt)

    assert.equal(reapStaleTunnels(dataDir), 1)
    for (let i = 0; i < 50 && t.alive(); i++) await sleep(100)
    assert.equal(t.alive(), false, 'the orphaned provider is dead')
    assert.equal(tunnelPidFiles(dataDir).length, 0)
  } finally {
    await t.stop()
  }
})

test('reapStaleTunnels: does NOT kill a recycled pid, or one whose pidfile predates the recorded start time', async () => {
  const dataDir = tmpDir('child-tunnel-reap-')
  const recycled = await spawnUnrelated()
  const legacy = await spawnUnrelated()
  try {
    writeTunnelPidFile(dataDir, recycled.pid, Date.now() - 60 * 60_000) // spawned an hour before this process existed
    writeTunnelPidFile(dataDir, legacy.pid) // the pre-fix format: no start time, cannot be verified

    assert.equal(reapStaleTunnels(dataDir), 0)
    await sleep(200)
    assert.doesNotThrow(() => process.kill(recycled.pid, 0), 'the unrelated process is still running')
    assert.doesNotThrow(() => process.kill(legacy.pid, 0), 'an unverifiable pid is left running')
    assert.equal(tunnelPidFiles(dataDir).length, 0, 'the stale pidfiles are still cleared')
  } finally {
    recycled.kill()
    legacy.kill()
    await Promise.all([recycled.exited, legacy.exited])
  }
})

// After an unclean exit and a reboot (or in a container, where pids repeat) the new daemon can get
// its predecessor's pid, so a leftover pidfile names IT as the owner. That record must still go
// through the start-time check, not be taken as this daemon's own provider and SIGKILLed /
// `taskkill /F /T`ed by the exit handler.
test('a leftover pidfile whose owner is our own pid is not taken for a provider we spawned', async () => {
  const dataDir = tmpDir('child-tunnel-reap-')
  const unrelated = await spawnUnrelated()
  const t = new ChildTunnel(dataDir)
  try {
    await t.spawnAndWait(process.execPath, ['-e', "console.log('https://ours.example.com'); setInterval(() => {}, 60000)"], /https:\/\/\S+/, 10_000)
    const [ours] = tunnelPidFiles(dataDir)
    const writeLeftover = () => writeFileSync(join(dataDir, 'run', `tunnel-${unrelated.pid}.pid`),
      JSON.stringify({ pid: unrelated.pid, owner: process.pid, startedAt: Date.now() - 60 * 60_000 }))
    writeLeftover()

    assert.equal(reapStaleTunnels(dataDir), 0, 'nothing is provably a stale provider')
    assert.deepEqual(tunnelPidFiles(dataDir), [ours], 'the leftover record is cleared; our live provider is still tracked')
    assert.equal(t.alive(), true, 'our own provider is not reaped')

    // The exit handler's own check, without the reaper's help: a leftover record still there at
    // exit (the reaper's rmSync failed on a Windows file lock, say) is not ours to kill either.
    writeLeftover()
    killTrackedTunnelsSync(dataDir) // this daemon's exit handler
    for (let i = 0; i < 50 && t.alive(); i++) await sleep(100)
    assert.equal(t.alive(), false, 'the provider we spawned is killed on exit')
    // Not process.kill(pid, 0): a killed child stays a zombie until Node reaps it, and that passes.
    const state = await Promise.race([unrelated.exited.then(() => 'exited'), sleep(300).then(() => 'running')])
    assert.equal(state, 'running', 'the unrelated process is still running')
  } finally {
    unrelated.kill()
    await unrelated.exited
    await t.stop()
  }
})
