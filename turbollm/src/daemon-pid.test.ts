// Unit tests for daemon-pid.ts (F-035): pidfile read/write/remove and stopDaemon.
// All OS interactions are injected via hooks so no real processes are touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  writePidfile,
  readPidfile,
  removePidfile,
  resolveDaemonPort,
  stopDaemon,
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
