// Unit tests for daemon-pid.ts (F-035): pidfile read/write/remove and stopDaemon.
// All OS interactions are injected via hooks so no real processes are touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import {
  writePidfile,
  readPidfile,
  removePidfile,
  removeOwnPidfile,
  findRunningDaemon,
  claimDataDir,
  releaseDataDirClaim,
  daemonReachHost,
  resolveDaemonPort,
  stopDaemon,
  type ClaimHooks,
  type ClaimRecord,
  type StopHooks,
} from './daemon-pid.js'
import { tmpDir } from './test-support/tmp'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = tmpDir('turbollm-pid-test-')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Fake StopHooks where the target process starts alive and we can flip it.
 *  Returns the same object for both reading state (`hooks.alive`, `hooks.taskkillCalled`)
 *  and satisfying the StopHooks interface, so mutations are visible on the returned ref.
 *  `opts.confirm` controls the identity probe (default true = "it's TurboLLM"); `opts.platform`
 *  selects the branch so the Windows path is exercisable on any OS. */
function makeHooks(
  alive = true,
  opts: { confirm?: boolean; platform?: NodeJS.Platform } = {},
): StopHooks & { alive: boolean; signals: string[]; taskkillCalled: boolean; confirmCalled: boolean } {
  const hooks = {
    alive,
    signals: [] as string[],
    taskkillCalled: false,
    confirmCalled: false,
    platform: opts.platform ?? process.platform,
    processExists(_pid: number) { return hooks.alive },
    kill(_pid: number, signal: NodeJS.Signals) {
      hooks.signals.push(signal)
      // Simulate SIGTERM causing exit after one poll cycle.
      if (signal === 'SIGTERM') hooks.alive = false
    },
    taskkill(_pid: number) {
      hooks.taskkillCalled = true
      hooks.alive = false
    },
    async confirmTurbollm(_port: number) {
      hooks.confirmCalled = true
      return opts.confirm ?? true
    },
  }
  return hooks
}

// ── writePidfile / readPidfile / removePidfile ────────────────────────────────

test('writePidfile + readPidfile round-trips pid and port', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 12345, 6996)
    const data = readPidfile(dir)
    assert.deepEqual(data, { pid: 12345, port: 6996 })
  } finally {
    cleanup()
  }
})

test('readPidfile returns null when file is absent', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('readPidfile returns null for invalid JSON', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writeFileSync(join(dir, 'daemon.pid'), 'not-json')
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

// ── resolveDaemonPort ─────────────────────────────────────────────────────────

test('resolveDaemonPort: explicit port wins over pidfile and fallback', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 1, 7000)
    assert.equal(resolveDaemonPort(dir, 9000, 6996), 9000)
  } finally {
    cleanup()
  }
})

test('resolveDaemonPort: uses the running daemon pidfile port when no explicit port', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 1, 7000)
    // fallback differs from the pidfile — the actual bound port must win.
    assert.equal(resolveDaemonPort(dir, undefined, 6996), 7000)
  } finally {
    cleanup()
  }
})

test('resolveDaemonPort: falls back when no pidfile exists', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    assert.equal(resolveDaemonPort(dir, undefined, 6996), 6996)
  } finally {
    cleanup()
  }
})

test('resolveDaemonPort: ignores a zero/NaN explicit port and uses the pidfile', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 1, 7000)
    assert.equal(resolveDaemonPort(dir, 0, 6996), 7000)
    assert.equal(resolveDaemonPort(dir, Number('x') || undefined, 6996), 7000)
  } finally {
    cleanup()
  }
})

test('removePidfile deletes the file', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 1, 1)
    removePidfile(dir)
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('removePidfile is silent when file does not exist', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    // Should not throw
    removePidfile(dir)
  } finally {
    cleanup()
  }
})

// ── stopDaemon ────────────────────────────────────────────────────────────────

test('stopDaemon returns friendly message when no pidfile exists', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    const hooks = makeHooks(false)
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, false)
    assert.match(result.message, /No running TurboLLM daemon found/)
  } finally {
    cleanup()
  }
})

test('stopDaemon returns friendly message when pidfile exists but process is gone', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 99999, 6996)
    const hooks = makeHooks(false) // process already dead
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, false)
    assert.match(result.message, /No running TurboLLM daemon found/)
    // Pidfile should have been cleaned up
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('stopDaemon Unix branch sends SIGTERM and reports success (platform injected)', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 7000)
    const hooks = makeHooks(true, { platform: 'linux' })
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, true)
    assert.equal(result.port, 7000)
    assert.match(result.message, /TurboLLM daemon stopped/)
    assert.ok(hooks.signals.includes('SIGTERM'), 'SIGTERM should have been sent')
    assert.equal(hooks.taskkillCalled, false, 'taskkill must not run on the Unix branch')
    // Pidfile should be removed
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('stopDaemon Windows branch calls taskkill and reports success (platform injected)', async () => {
  // platform:'win32' selects the Windows branch regardless of the host OS, so this
  // covers the taskkill path even on a Linux CI runner.
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 7000)
    const hooks = makeHooks(true, { platform: 'win32' })
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, true)
    assert.equal(hooks.taskkillCalled, true, 'taskkill should be called on the Windows branch')
    assert.equal(hooks.signals.length, 0, 'no Unix signals on the Windows branch')
    assert.equal(readPidfile(dir), null)
  } finally {
    cleanup()
  }
})

test('stopDaemon refuses to kill when the PID is alive but not a TurboLLM daemon (recycled PID)', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 7000)
    // Process exists, but the identity probe says it's NOT TurboLLM → must not kill.
    const hooks = makeHooks(true, { confirm: false, platform: 'linux' })
    const result = await stopDaemon(dir, hooks)
    assert.equal(result.stopped, false)
    assert.ok(hooks.confirmCalled, 'identity probe should have run')
    assert.equal(hooks.signals.length, 0, 'must not send any kill signal')
    assert.equal(hooks.taskkillCalled, false, 'must not taskkill')
    assert.match(result.message, /not killing it automatically/i)
    assert.match(result.message, /kill -9 42/, 'should hand the user the manual command')
    // Pidfile is left intact — we did not confirm ownership, so we do not touch it.
    assert.deepEqual(readPidfile(dir), { pid: 42, port: 7000 })
  } finally {
    cleanup()
  }
})

// ── Second daemon on the same data dir (owner-scoped pidfile + start guard) ─────────

test('removeOwnPidfile: leaves another daemon\'s pidfile alone, removes its own', () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    // The running daemon (pid 42) owns the file; a second instance (pid 43) exiting must not delete it.
    writePidfile(dir, 42, 6996)
    removeOwnPidfile(dir, 43)
    assert.deepEqual(readPidfile(dir), { pid: 42, port: 6996 })
    removeOwnPidfile(dir, 42)
    assert.equal(readPidfile(dir), null)
    removeOwnPidfile(dir, 42) // absent: silent
  } finally {
    cleanup()
  }
})

// The stopped daemon removes its own pidfile as soon as its shutdown starts, so a daemon started
// during that shutdown passes the start guard, binds once the old listener closes and writes its
// own pidfile — possibly before --stop's exit poll sees the old pid gone. --stop must leave it.
test('stopDaemon keeps a pidfile a newer daemon wrote while the old one was stopping', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 6996)
    const hooks = makeHooks(true, { platform: 'linux' })
    hooks.kill = (_pid, signal) => {
      hooks.signals.push(signal)
      if (signal !== 'SIGTERM') return
      // Old daemon (42) exits; the new one (200) has already written its pidfile.
      writePidfile(dir, 200, 6996)
      hooks.alive = false
    }
    assert.equal((await stopDaemon(dir, hooks)).stopped, true)
    assert.deepEqual(readPidfile(dir), { pid: 200, port: 6996 })

    // Same for a pidfile whose pid is already gone: only that pid's record is removed.
    writePidfile(dir, 42, 6996)
    const dead = makeHooks(false)
    dead.processExists = () => {
      writePidfile(dir, 200, 6996) // replaced between the read and the clean-up
      return false
    }
    assert.equal((await stopDaemon(dir, dead)).stopped, false)
    assert.deepEqual(readPidfile(dir), { pid: 200, port: 6996 })
  } finally {
    cleanup()
  }
})

test('findRunningDaemon: a live, answering daemon blocks a start; stale/recycled/own pidfiles do not', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    assert.equal(await findRunningDaemon(dir, makeHooks(true), 43), null, 'no pidfile')
    writePidfile(dir, 42, 6996)
    assert.deepEqual(await findRunningDaemon(dir, makeHooks(true), 43), { pid: 42, port: 6996 })
    assert.equal(await findRunningDaemon(dir, makeHooks(false), 43), null, 'PID gone: stale pidfile')
    assert.equal(await findRunningDaemon(dir, makeHooks(true, { confirm: false }), 43), null, 'PID recycled / listener closed')
    const own = makeHooks(true)
    assert.equal(await findRunningDaemon(dir, own, 42), null, 'our own pidfile')
    assert.equal(own.confirmCalled, false)
  } finally {
    cleanup()
  }
})

// A daemon run elevated or as another user exists, but this user may not signal it: even the
// signal-0 liveness probe fails with EPERM. The default check read that as "gone", so a second
// start beside it was not refused and --stop deleted its pidfile. Real default hooks here, with
// only process.kill faked for a pid that stands in for that daemon (odd: no Windows pid is).
test('a live daemon this user may not signal (EPERM) blocks a start, and --stop keeps its pidfile', async (t) => {
  const standIn = http.createServer((_req, res) => {
    res.writeHead(200, { server: 'TurboLLM/9.9.9', 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '9.9.9' }))
  })
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve))
  const port = (standIn.address() as AddressInfo).port
  const pid = 4_194_289
  const realKill = process.kill.bind(process)
  t.mock.method(process, 'kill', (target: number, signal?: string | number) => {
    if (target === pid) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' })
    return realKill(target, signal)
  })
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, pid, port)
    assert.deepEqual(await findRunningDaemon(dir, undefined, 0), { pid, port }, 'start guard')
    const res = await stopDaemon(dir)
    assert.equal(res.stopped, false)
    assert.doesNotMatch(res.message, /No running TurboLLM daemon/)
    assert.deepEqual(readPidfile(dir), { pid, port }, 'the running daemon keeps its pidfile')
  } finally {
    cleanup()
    await new Promise<void>((resolve) => standIn.close(() => resolve()))
  }
})

// A daemon bound to one interface (--addr 192.168.1.5:…, daemon.host) never answers on
// 127.0.0.1, so the pidfile records the bound address and both the start guard and --stop probe
// THERE. The real-socket version of this is daemon-pid.bound-host.test.ts.
test('pidfile records the bound host; the start guard and --stop probe it', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    writePidfile(dir, 42, 6996, '192.168.1.5')
    assert.deepEqual(readPidfile(dir), { pid: 42, port: 6996, host: '192.168.1.5' })
    const probed: Array<[number, string | undefined]> = []
    const hooks = makeHooks(true, { platform: 'linux' })
    hooks.confirmTurbollm = async (port, host) => {
      probed.push([port, host])
      return true
    }
    assert.deepEqual(await findRunningDaemon(dir, hooks, 43), { pid: 42, port: 6996, host: '192.168.1.5' })
    assert.equal((await stopDaemon(dir, hooks)).stopped, true)
    assert.deepEqual(probed, [[6996, '192.168.1.5'], [6996, '192.168.1.5']])

    // A malformed host is dropped rather than put into the probe URL.
    writeFileSync(join(dir, 'daemon.pid'), JSON.stringify({ pid: 42, port: 6996, host: 7 }))
    assert.deepEqual(readPidfile(dir), { pid: 42, port: 6996 })
  } finally {
    cleanup()
  }
})

test('daemonReachHost: the bound address, loopback for a wildcard or unrecorded bind, IPv6 bracketed', () => {
  assert.equal(daemonReachHost(undefined), '127.0.0.1')
  assert.equal(daemonReachHost('0.0.0.0'), '127.0.0.1')
  assert.equal(daemonReachHost('::'), '127.0.0.1')
  assert.equal(daemonReachHost('127.0.0.1'), '127.0.0.1')
  assert.equal(daemonReachHost('192.168.1.5'), '192.168.1.5')
  assert.equal(daemonReachHost('::1'), '[::1]')
})

// ── Start claim (daemon.lock): two daemons started at once ────────────────────

/** ClaimHooks over a fake process table: pid → its start time (epoch ms). */
function claimHooks(procs: Map<number, number>, now = 1_000_000): ClaimHooks {
  return {
    processExists: (pid) => procs.has(pid),
    startTime: (pid) => procs.get(pid),
    now: () => now,
  }
}

// The pidfile is written only once a daemon has bound, a second or more after its guard, so two
// daemons started together both found no pidfile and both booted on one data dir (a fresh one
// could crash in a concurrent migration; otherwise both kept running and --stop saw only one).
// The guard as cli.ts runs it: claimDataDir, then findRunningDaemon.
test('two daemons starting at once on one data dir: only one gets past the start guard', async () => {
  const { dir, cleanup } = makeTmpDir()
  try {
    const a: ClaimRecord = { pid: 42, startedAt: 999_000 }
    const b: ClaimRecord = { pid: 43, startedAt: 999_500 }
    const procs = new Map([[a.pid, a.startedAt], [b.pid, b.startedAt]])
    const hooks = claimHooks(procs)
    const guard = async (self: ClaimRecord): Promise<string> => {
      const holder = claimDataDir(dir, hooks, self)
      if (holder) return `starting:${holder.pid}`
      return (await findRunningDaemon(dir, makeHooks(true), self.pid)) ? 'running' : 'start'
    }
    // Both booting before either has bound: no pidfile yet.
    assert.deepEqual(await Promise.all([guard(a), guard(b)]), ['start', 'starting:42'])

    // A binds, writes its pidfile, then gives up the claim: B is now refused by the pidfile.
    writePidfile(dir, a.pid, 6996)
    releaseDataDirClaim(dir, b.pid) // not B's claim: kept
    assert.ok(existsSync(join(dir, 'daemon.lock')), "another start's claim is never released")
    releaseDataDirClaim(dir, a.pid)
    assert.equal(existsSync(join(dir, 'daemon.lock')), false)
    assert.equal(await guard(b), 'running')
    releaseDataDirClaim(dir, b.pid) // B's exit gives up the claim it took for that check
    assert.equal(existsSync(join(dir, 'daemon.lock')), false)
  } finally {
    cleanup()
  }
})

test('a stale start claim is reclaimed; a live one, or one still being written, is not', () => {
  const { dir, cleanup } = makeTmpDir()
  const lock = join(dir, 'daemon.lock')
  const self: ClaimRecord = { pid: 50, startedAt: 999_900 }
  const claim = (procs: Map<number, number>, opts: { now?: number; unverifiable?: boolean } = {}) => {
    const hooks = claimHooks(procs, opts.now)
    if (opts.unverifiable) hooks.startTime = () => undefined
    return claimDataDir(dir, hooks, self)
  }
  const owner = (): number => (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid
  try {
    const left = (rec: unknown) => writeFileSync(lock, typeof rec === 'string' ? rec : JSON.stringify(rec))

    left({ pid: 42, startedAt: 990_000 })
    assert.deepEqual(claim(new Map([[42, 990_000]])), { pid: 42 }, 'live holder')
    assert.deepEqual(claim(new Map([[42, 992_000]])), { pid: 42 }, 'start time within the ps tolerance')
    assert.deepEqual(claim(new Map([[42, 990_000]]), { now: 990_000 + 600_000 }), { pid: 42 }, 'a verified holder never expires')

    assert.equal(claim(new Map()), null, 'holder dead (a boot killed before its handlers existed)')
    assert.equal(owner(), 50, 'reclaimed: the claim is now ours')

    left({ pid: 42, startedAt: 990_000 })
    assert.equal(claim(new Map([[42, 500_000]])), null, 'pid reused by a process that started at another time')
    assert.equal(owner(), 50)

    // Start time unreadable (no ps, a process this user may not inspect): honoured while young.
    left({ pid: 42, startedAt: 990_000 })
    assert.deepEqual(claim(new Map([[42, 0]]), { unverifiable: true }), { pid: 42 })
    assert.equal(claim(new Map([[42, 0]]), { now: 990_000 + 121_000, unverifiable: true }), null)
    assert.equal(owner(), 50)

    left({ pid: 50, startedAt: 1 })
    assert.equal(claim(new Map([[50, 999_900]])), null, 'a record with our own pid is an earlier process\'s')
    assert.equal(owner(), 50)

    // Empty: a start between its 'wx' create and its write. Honoured only while fresh.
    left('')
    assert.deepEqual(claimDataDir(dir, claimHooks(new Map(), Date.now()), self), { pid: null })
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    assert.equal(claimDataDir(dir, claimHooks(new Map(), Date.now()), self), null)
    assert.equal(owner(), 50)

    left({ pid: -1, startedAt: 990_000 })
    assert.equal(claim(new Map([[-1, 990_000]])), null, 'junk record')
    assert.equal(owner(), 50)
  } finally {
    cleanup()
  }
})

// Real processes and the default hooks (signal-0 probe, ps / PowerShell start time).
test('a live process holding the start claim blocks a start until it exits', async () => {
  const { dir, cleanup } = makeTmpDir()
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  const spawnedAt = Date.now()
  try {
    const pid = holder.pid as number
    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid, startedAt: spawnedAt }))
    assert.deepEqual(claimDataDir(dir), { pid })
    // The same pid recorded with another start time: a pid reused since the claim was left.
    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid, startedAt: spawnedAt - 3_600_000 }))
    assert.equal(claimDataDir(dir), null)
    releaseDataDirClaim(dir)

    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid, startedAt: spawnedAt }))
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()))
    holder.kill('SIGKILL')
    await exited
    assert.equal(claimDataDir(dir), null, 'holder gone: stale')
    assert.equal((JSON.parse(readFileSync(join(dir, 'daemon.lock'), 'utf8')) as { pid: number }).pid, process.pid)
    releaseDataDirClaim(dir)
    assert.equal(existsSync(join(dir, 'daemon.lock')), false)
  } finally {
    holder.kill('SIGKILL')
    cleanup()
  }
})
