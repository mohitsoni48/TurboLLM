// The daemon's 'exit' handler (killTrackedEnginesSync) cannot await, so on Windows it used to run one synchronous
// `taskkill` per engine with no timeout: a single hung taskkill blocked the daemon's exit for good. It now sends ONE
// `taskkill /F /T /PID a /PID b …` with a timeout, as util/tether.ts's killTetheredSync does. Platform and spawnSync
// are stubbed, so nothing real is ever killed and this runs on every OS.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { killTrackedEnginesSync } from './manager'
import { tmpDir } from '../test-support/tmp'

type SyncCall = { file: string; args: readonly string[]; options: { timeout?: number } | undefined }

function onPlatform<T>(t: TestContext, platform: NodeJS.Platform, calls: SyncCall[], f: () => T, result: object = { status: 0 }): T {
  const s = t.mock.method(childProcess, 'spawnSync', ((file: string, args: readonly string[], options?: { timeout?: number }) => {
    calls.push({ file, args, options })
    return result
  }) as unknown as typeof childProcess.spawnSync)
  syncBuiltinESMExports()
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    return f()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    s.mock.restore()
    syncBuiltinESMExports()
  }
}

/** Pidfiles as manager.ts writes them, owned by this process. Pids are made up and never signalled. */
function writePidFiles(dir: string, pids: number[], owner = process.pid): string[] {
  const run = join(dir, 'run')
  mkdirSync(run, { recursive: true })
  return pids.map((pid) => {
    const file = join(run, `engine-${pid}.pid`)
    writeFileSync(file, JSON.stringify({ pid, port: 0, owner, startedAt: Date.now(), group: false }))
    return file
  })
}

test('Windows exit kill: all owned engines go in one taskkill with a timeout', (t) => {
  const dir = tmpDir('tllm-exit-kill-')
  const files = writePidFiles(dir, [4101, 4102, 4103])
  const calls: SyncCall[] = []
  onPlatform(t, 'win32', calls, () => killTrackedEnginesSync(dir))
  assert.equal(calls.length, 1, 'one taskkill, not one per engine')
  assert.equal(calls[0]!.file, 'taskkill')
  assert.deepEqual([...calls[0]!.args].slice(0, 2), ['/F', '/T'])
  const pids = calls[0]!.args.flatMap((a, i, all) => (all[i - 1] === '/PID' ? [a] : []))
  assert.deepEqual(pids.sort(), ['4101', '4102', '4103'])
  assert.equal(calls[0]!.options?.timeout, 10_000, 'a hung taskkill must not block the daemon exit')
  for (const f of files) assert.equal(existsSync(f), false, 'pidfiles are removed')
})

test('Windows exit kill: an engine owned by another daemon is left alone, and no owned engine means no taskkill', (t) => {
  const dir = tmpDir('tllm-exit-kill-other-')
  const [mine] = writePidFiles(dir, [4201])
  const [theirs] = writePidFiles(dir, [4202], process.pid + 1)
  const calls: SyncCall[] = []
  onPlatform(t, 'win32', calls, () => killTrackedEnginesSync(dir))
  assert.deepEqual(calls[0]!.args.filter((a) => /^\d+$/.test(a)), ['4201'])
  assert.equal(existsSync(mine!), false)
  assert.equal(existsSync(theirs!), true, "another daemon's pidfile stays")

  const empty = tmpDir('tllm-exit-kill-none-')
  const none: SyncCall[] = []
  onPlatform(t, 'win32', none, () => killTrackedEnginesSync(empty))
  assert.deepEqual(none, [], 'nothing to kill, nothing spawned')
})

test('POSIX exit kill never spawns taskkill', (t) => {
  const dir = tmpDir('tllm-exit-kill-posix-')
  const calls: SyncCall[] = []
  // Empty run dir: killPosix would signal real pids, so only the no-engine case is safe to drive here.
  onPlatform(t, 'linux', calls, () => killTrackedEnginesSync(dir))
  assert.deepEqual(calls, [])
})

// L5: a taskkill that timed out (spawnSync sets error/signal) did not finish, so the engines may still be alive: their
// pidfiles are the startup reaper's only way to find them, so they must stay.
test('Windows exit kill: pidfiles stay when the taskkill timed out or was signalled', (t) => {
  for (const result of [{ status: null, error: Object.assign(new Error('spawnSync taskkill ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, { status: null, signal: 'SIGTERM' }]) {
    const dir = tmpDir('tllm-exit-kill-timeout-')
    const files = writePidFiles(dir, [4301, 4302])
    onPlatform(t, 'win32', [], () => killTrackedEnginesSync(dir), result)
    for (const f of files) assert.equal(existsSync(f), true, 'the reaper must still find these')
  }
})
