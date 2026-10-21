// TerminalManager multi-listener regression tests.
//
// Contract under test: a terminal id can have MORE THAN ONE attached WebSocket listener at
// once (a Code session's terminal opened in two browser tabs) — registering a second listener
// must not silently replace the first, and unregistering one listener must not silence or
// remove any other listener still attached to the same terminal id.
//
// registerWsListener/unregisterWsListener/the private broadcast() fan-out are exercised
// directly rather than through create() — create() spawns a real PTY via node-pty, which is
// unnecessary weight for testing listener bookkeeping. Same "reach into internals via a
// narrow cast" pattern already used by model-router.test.ts for its own private state.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TerminalManager, reapStaleTerminals, killTrackedTerminalsSync } from './terminal-manager'
import { tmpDir } from '../test-support/tmp'

type Handler = { onData?: (data: string) => void; onClose?: () => void }

function privates(m: TerminalManager) {
  return m as unknown as { broadcast(id: string, fn: (h: Handler) => void): void; listeners: Map<string, Set<Handler>> }
}

// ── cleanupIdle TTL: a genuinely abandoned terminal is reaped; a viewed one never is ────────
// Regression for a real gap: cleanupIdle() existed but was never actually scheduled anywhere (no
// caller ran it on an interval), and even if it had been, it measured age since CREATION, not
// since the last viewer disconnected — a terminal actively open for 6+ minutes would have
// qualified for cleanup, while a genuinely abandoned one (every tab closed) never would have been
// swept at all. Fixed: an idle clock that only runs while ZERO WebSocket listeners are attached,
// self-scheduled inside the class. These tests seed sessions/infoMap/idleSince directly via the
// same narrow-cast pattern as model-router.test.ts's extraSlots, rather than spawning a real PTY
// (unnecessary weight for exercising this bookkeeping — same rationale as the file header above).

/** Minimal fake PTYSession — just enough surface for kill()'s dispose()/getPid() calls and
 *  registerWsListener's scrollback replay. */
function fakeSession(pid = 0) {
  let disposed = false
  return {
    dispose: () => { disposed = true },
    getPid: () => pid,
    isExited: () => disposed,
    getScrollback: () => '',
    wasDisposed: () => disposed,
  }
}

type SeededManager = {
  sessions: Map<string, ReturnType<typeof fakeSession>>
  infoMap: Map<string, { id: string; codeSessionId: string | null; cwd: string; cols: number; rows: number; createdAt: string; agentExited?: boolean }>
  idleSince: Map<string, number>
  listeners: Map<string, Set<Handler>>
  registerWsListener: (id: string, h: Handler) => void
  unregisterWsListener: (id: string, h: Handler) => void
  cleanupIdle: (maxAgeMs?: number) => void
  findByCodeSessionId: (codeSessionId: string) => string | null
  markAgentExited: (codeSessionId: string) => void
  isAgentExited: (terminalId: string) => boolean
}

function seededManager(): SeededManager {
  return new TerminalManager() as unknown as SeededManager
}

function seedTerminal(
  m: ReturnType<typeof seededManager>,
  id: string,
  codeSessionId: string | null = null,
): ReturnType<typeof fakeSession> {
  const session = fakeSession()
  m.sessions.set(id, session as never)
  m.infoMap.set(id, { id, codeSessionId, cwd: '/scratch', cols: 80, rows: 24, createdAt: new Date().toISOString() })
  return session
}

test('cleanupIdle: a terminal with an active listener is never killed, no matter its idle-clock state', () => {
  const m = seededManager()
  const session = seedTerminal(m, 't1')
  const handler: Handler = { onData: () => {} }
  m.registerWsListener('t1', handler as { onData: (d: string) => void })
  // Force a stale-looking idle timestamp directly — simulates "somehow old" without waiting;
  // registerWsListener already deleted the entry, so re-seed it to prove cleanupIdle still
  // can't act on a currently-attached terminal even if idleSince were (incorrectly) present.
  m.idleSince.set('t1', Date.now() - 1_000_000)

  m.cleanupIdle(0)

  assert.equal(session.wasDisposed(), false, 'a terminal with a live listener must survive cleanupIdle regardless of maxAgeMs')
  assert.ok(m.infoMap.has('t1'))
})

test('cleanupIdle: switching away and back within the TTL never kills the terminal', () => {
  const m = seededManager()
  const session = seedTerminal(m, 't2')
  const handler: Handler = { onData: () => {} }
  m.registerWsListener('t2', handler as { onData: (d: string) => void })
  m.unregisterWsListener('t2', handler) // navigate away — idle clock starts now
  assert.ok(m.idleSince.has('t2'), 'idle clock must start the moment the last listener detaches')

  m.registerWsListener('t2', handler as { onData: (d: string) => void }) // navigate back, well within the TTL
  assert.equal(m.idleSince.has('t2'), false, 'reconnecting must clear the idle clock')

  m.cleanupIdle(300_000)
  assert.equal(session.wasDisposed(), false, 'a quick switch-away-and-back must never kill the CLI')
})

test('cleanupIdle: a terminal idle past maxAgeMs with no listener attached is killed', () => {
  const m = seededManager()
  const session = seedTerminal(m, 't3')
  m.idleSince.set('t3', Date.now() - 400_000) // no listener ever attached in this test — genuinely abandoned

  m.cleanupIdle(300_000)

  assert.equal(session.wasDisposed(), true, 'a terminal idle well past the TTL with no viewer must be reaped')
  assert.equal(m.infoMap.has('t3'), false)
})

test('cleanupIdle: a terminal idle for LESS than maxAgeMs is left alone', () => {
  const m = seededManager()
  const session = seedTerminal(m, 't4')
  m.idleSince.set('t4', Date.now() - 1_000) // 1s idle, well under a 5-minute TTL

  m.cleanupIdle(300_000)

  assert.equal(session.wasDisposed(), false)
  assert.ok(m.infoMap.has('t4'))
})

test('cleanupIdle: a terminal created with its own idle TTL (a routine run) uses it instead of maxAgeMs', () => {
  const m = seededManager()
  const ttl = (m as unknown as { idleTtl: Map<string, number> }).idleTtl
  const session = seedTerminal(m, 't5')
  ttl.set('t5', 35 * 60_000)
  m.idleSince.set('t5', Date.now() - 6 * 60_000) // never viewed, six minutes old

  m.cleanupIdle(300_000)
  assert.equal(session.wasDisposed(), false, 'its owner, not the 5-minute default, decides when it ends')

  m.idleSince.set('t5', Date.now() - 36 * 60_000)
  m.cleanupIdle(300_000)
  assert.equal(session.wasDisposed(), true, 'past its own TTL it still ages out')
  assert.equal(ttl.has('t5'), false)
})

// ── Output while nobody watches: an agent still printing its work is not idle ─────────────
// Regression: the idle clock counted only from the moment the last viewer left, so an agent CLI
// working on a long task with every tab closed was killed 5 minutes in, mid-task, exactly like an
// abandoned terminal. Output now restarts the clock while no viewer is attached, up to a 6-hour
// cap after the last viewer left (a TUI repainting on a timer must still be reaped), and never
// for a terminal with its own idle TTL (a routine's run decides). onOutput is what create()'s PTY
// onData calls; it is driven directly here, as the rest of this file drives the bookkeeping.

type OutputPrivates = { onOutput(id: string, data: string): void; lastOutput: Map<string, number> }
const output = (m: SeededManager) => m as unknown as OutputPrivates

test('cleanupIdle: an unwatched terminal that is still printing is kept past maxAgeMs', () => {
  const m = seededManager()
  const session = seedTerminal(m, 'o1')
  m.idleSince.set('o1', Date.now() - 400_000) // the last viewer left over six minutes ago

  output(m).onOutput('o1', 'Compiling…\r\n')
  m.cleanupIdle(300_000)

  assert.equal(session.wasDisposed(), false, 'output just now: the agent is working, not abandoned')
  assert.ok(m.infoMap.has('o1'))
})

test('cleanupIdle: an unwatched terminal quiet for maxAgeMs since its last output is killed', () => {
  const m = seededManager()
  const session = seedTerminal(m, 'o2')
  m.idleSince.set('o2', Date.now() - 20 * 60_000)
  output(m).onOutput('o2', 'done\r\n')
  output(m).lastOutput.set('o2', Date.now() - 6 * 60_000) // that output was six minutes ago

  m.cleanupIdle(300_000)

  assert.equal(session.wasDisposed(), true, 'five minutes without output still reaps it')
  assert.equal(output(m).lastOutput.has('o2'), false)
})

test('cleanupIdle: output keeps an unwatched terminal for at most 6 hours after its last viewer left', () => {
  const m = seededManager()
  const session = seedTerminal(m, 'o3')
  m.idleSince.set('o3', Date.now() - (6 * 60 - 1) * 60_000)
  output(m).onOutput('o3', '\x1b[H12:00:01')
  m.cleanupIdle(300_000)
  assert.equal(session.wasDisposed(), false, 'still within the cap')

  m.idleSince.set('o3', Date.now() - (6 * 60 + 1) * 60_000)
  output(m).onOutput('o3', '\x1b[H12:00:02') // a TUI repainting on a timer never goes quiet
  m.cleanupIdle(300_000)
  assert.equal(session.wasDisposed(), true, 'past the cap it is reaped although it keeps printing')
})

test('cleanupIdle: output does not extend a terminal created with its own idle TTL', () => {
  const m = seededManager()
  const ttl = (m as unknown as { idleTtl: Map<string, number> }).idleTtl
  const session = seedTerminal(m, 'o4')
  ttl.set('o4', 35 * 60_000)
  m.idleSince.set('o4', Date.now() - 36 * 60_000)

  output(m).onOutput('o4', 'still going\r\n')
  m.cleanupIdle(300_000)

  assert.equal(session.wasDisposed(), true, "a routine's run, not its output, decides when its terminal ends")
})

test('onOutput: output reaches every attached viewer and starts no clock while one is attached', () => {
  const m = seededManager()
  seedTerminal(m, 'o5')
  const received: string[] = []
  const handler: Handler = { onData: (d) => received.push(d) }
  m.registerWsListener('o5', handler as { onData: (d: string) => void })

  output(m).onOutput('o5', 'hello')
  assert.deepEqual(received, ['hello'])
  assert.equal(output(m).lastOutput.has('o5'), false)

  m.unregisterWsListener('o5', handler)
  output(m).onOutput('o5', 'unseen')
  assert.deepEqual(received, ['hello'], 'a viewer that left gets nothing more')
  assert.equal(output(m).lastOutput.has('o5'), true)
  m.registerWsListener('o5', handler as { onData: (d: string) => void })
  assert.equal(output(m).lastOutput.has('o5'), false, 'a viewer attaching clears it with the idle clock')
})

test('registerWsListener: two listeners on the same id both receive broadcast data', () => {
  const m = new TerminalManager()
  const received1: string[] = []
  const received2: string[] = []
  const h1: Handler = { onData: (d) => received1.push(d) }
  const h2: Handler = { onData: (d) => received2.push(d) }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.registerWsListener('term1', h2 as { onData: (data: string) => void })
  privates(m).broadcast('term1', (h) => h.onData?.('hello'))

  assert.deepEqual(received1, ['hello'])
  assert.deepEqual(received2, ['hello'])
})

test('unregisterWsListener: removing one listener does not silence the other', () => {
  const m = new TerminalManager()
  const received1: string[] = []
  const received2: string[] = []
  const h1: Handler = { onData: (d) => received1.push(d) }
  const h2: Handler = { onData: (d) => received2.push(d) }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.registerWsListener('term1', h2 as { onData: (data: string) => void })
  m.unregisterWsListener('term1', h1)
  privates(m).broadcast('term1', (h) => h.onData?.('world'))

  assert.deepEqual(received1, [], 'unregistered listener must not receive further broadcasts')
  assert.deepEqual(received2, ['world'], 'the still-attached listener must be untouched')
})

test('unregisterWsListener: a second registration does not overwrite the first (no silent steal)', () => {
  const m = new TerminalManager()
  const received1: string[] = []
  const h1: Handler = { onData: (d) => received1.push(d) }
  const h2: Handler = { onData: () => {} }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.registerWsListener('term1', h2 as { onData: (data: string) => void })
  assert.equal(privates(m).listeners.get('term1')?.size, 2)

  privates(m).broadcast('term1', (h) => h.onData?.('still here'))
  assert.deepEqual(received1, ['still here'])
})

test('unregisterWsListener: removing the last listener clears the map entry', () => {
  const m = new TerminalManager()
  const h1: Handler = { onData: () => {} }

  m.registerWsListener('term1', h1 as { onData: (data: string) => void })
  m.unregisterWsListener('term1', h1)

  assert.equal(privates(m).listeners.has('term1'), false)
})

test('unregisterWsListener: unregistering an id with no listeners is a safe no-op', () => {
  const m = new TerminalManager()
  assert.doesNotThrow(() => m.unregisterWsListener('nonexistent', { onData: () => {} }))
})

test('broadcast: onClose fans out to every attached listener', () => {
  const m = new TerminalManager()
  let closed1 = false
  let closed2 = false
  m.registerWsListener('term1', { onData: () => {}, onClose: () => { closed1 = true } })
  m.registerWsListener('term1', { onData: () => {}, onClose: () => { closed2 = true } })

  privates(m).broadcast('term1', (h) => h.onClose?.())

  assert.equal(closed1, true)
  assert.equal(closed2, true)
})

// ── Orphan-safety pidfile: reapStaleTerminals / killTrackedTerminalsSync ─────────────
// Regression for a real, live bug: cli.ts's shutdown handlers (SIGINT/SIGTERM/SIGHUP, and
// the sync 'exit' safety net) killed tracked engines and tunnels but never touched
// terminal-agent PTYs at all — found live as 11 orphaned claude.exe + 6 orphaned
// powershell.exe processes after a day of Code-terminal testing with repeated daemon
// restarts. These pin the same owner-scoped pidfile contract engines/tunnels already have
// (mirrors manager.reap.test.ts; a plain shell has no port for a portAlive cross-check, so the
// pidfile's recorded start time stands in for it — see the pid-reuse tests below).

function spawnFakeShell(): Promise<{ pid: number; kill: () => void; waitExit: () => Promise<void> }> {
  // A real, long-lived child process standing in for an orphaned terminal shell.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'])
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      const exited = new Promise<void>((r) => child.once('exit', () => r()))
      resolve({ pid: child.pid!, kill: () => child.kill('SIGKILL'), waitExit: () => exited })
    })
    child.once('error', reject)
  })
}

function writeTerminalPidFile(dir: string, pid: number, owner?: number, startedAt?: number): void {
  const run = join(dir, 'run')
  mkdirSync(run, { recursive: true })
  writeFileSync(
    join(run, `terminal-${pid}.pid`),
    JSON.stringify({ pid, ...(owner !== undefined ? { owner } : {}), ...(startedAt !== undefined ? { startedAt } : {}) }),
  )
}

function terminalPidFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'run')).filter((n) => /^terminal-\d+\.pid$/.test(n))
  } catch {
    return []
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('reapStaleTerminals: reaps a tracked shell with no live owner, and clears its pidfile', async () => {
  const dir = tmpDir('tllm-term-reap-')
  const shell = await spawnFakeShell()
  try {
    // No owner field (ownerless), and a spawn time matching the live process — so it is provably
    // still the shell that pidfile was written for.
    writeTerminalPidFile(dir, shell.pid, undefined, Date.now())

    const killed = reapStaleTerminals(dir)

    assert.equal(killed, 1, 'should report one orphan killed')
    await Promise.race([shell.waitExit(), sleep(5000)])
    assert.throws(() => process.kill(shell.pid, 0), 'the orphaned shell should be dead')
    assert.equal(terminalPidFiles(dir).length, 0, 'pidfile should be removed after reaping')
  } finally {
    shell.kill()
  }
})

// The pid-reuse case: a daemon killed without its exit handler (power loss, OS update
// reboot) leaves a pidfile behind, and on the next boot that pid belongs to some unrelated
// process — which `taskkill /F /T` would take down with its whole tree. Only a pid whose process
// started when the pidfile says the shell did may be killed.
test('reapStaleTerminals: does NOT kill a recycled pid whose process started at a different time', async () => {
  const dir = tmpDir('tllm-term-reap-')
  const unrelated = await spawnFakeShell()
  try {
    // Written an hour before this process existed — e.g. before a reboot.
    writeTerminalPidFile(dir, unrelated.pid, 0, Date.now() - 60 * 60_000)

    const killed = reapStaleTerminals(dir)

    assert.equal(killed, 0, 'a pid that is no longer our shell must not be killed')
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'the unrelated process should still be running')
    assert.equal(terminalPidFiles(dir).length, 0, 'the stale pidfile is still cleared')
  } finally {
    unrelated.kill()
  }
})

test('reapStaleTerminals: a pidfile with no recorded start time cannot be verified, so nothing is killed', async () => {
  const dir = tmpDir('tllm-term-reap-')
  const shell = await spawnFakeShell()
  try {
    writeTerminalPidFile(dir, shell.pid) // the pre-fix format: pid only

    assert.equal(reapStaleTerminals(dir), 0)
    assert.doesNotThrow(() => process.kill(shell.pid, 0), 'an unverifiable pid must be left running')
    assert.equal(terminalPidFiles(dir).length, 0, 'the stale pidfile is still cleared')
  } finally {
    shell.kill()
  }
})

test('reapStaleTerminals: does NOT reap a shell still owned by a live daemon', async () => {
  const dir = tmpDir('tllm-term-reap-')
  const shell = await spawnFakeShell()
  try {
    // owner = this (alive) test process — a live daemon manages this terminal; a starting
    // daemon must leave it alone, or a restart-overlap would reap the incoming daemon's
    // freshly-launched terminal.
    writeTerminalPidFile(dir, shell.pid, process.pid)

    const killed = reapStaleTerminals(dir)

    assert.equal(killed, 0, 'a terminal owned by a live daemon must not be reaped')
    assert.doesNotThrow(() => process.kill(shell.pid, 0), 'the shell should still be running')
    assert.equal(terminalPidFiles(dir).length, 1, "the live owner's pidfile must be left in place")
  } finally {
    shell.kill()
  }
})

test('killTrackedTerminalsSync: kills only shells owned by THIS process', async () => {
  const dir = tmpDir('tllm-term-reap-')
  const owned = await spawnFakeShell()
  const other = await spawnFakeShell()
  try {
    writeTerminalPidFile(dir, owned.pid, process.pid) // ours
    writeTerminalPidFile(dir, other.pid, other.pid + 1_000_000) // some other (fake, alive-looking) owner

    killTrackedTerminalsSync(dir)

    await Promise.race([owned.waitExit(), sleep(5000)])
    assert.throws(() => process.kill(owned.pid, 0), 'the owned shell should be dead')
    assert.doesNotThrow(() => process.kill(other.pid, 0), "another daemon's shell must be left untouched")
    assert.equal(terminalPidFiles(dir).length, 1, "only the owned pidfile should be removed")
  } finally {
    owned.kill()
    other.kill()
  }
})

// ── agentExited: the shell outliving the agent must not look like a live agent terminal ──────
// pty-session.ts runs the launch command with `-NoExit` (Windows) / `exec bash` (POSIX) so the
// user is left at a usable prompt when the agent quits. That means the PTY is still alive after
// the agent dies, and findByCodeSessionId — which only checks isExited() — happily returns it.
// Found live: one failed `--resume` left a Code session pinned to a bare PowerShell prompt, and
// every reopen redisplayed the same stale error instead of relaunching, making an
// already-deployed launch fix look like it had changed nothing.

test('markAgentExited flags the Code session’s terminal, and only that one', () => {
  const m = seededManager()
  seedTerminal(m, 't1', 'sess-a')
  seedTerminal(m, 't2', 'sess-b')

  m.markAgentExited('sess-a')

  assert.equal(m.isAgentExited('t1'), true)
  assert.equal(m.isAgentExited('t2'), false, 'a sibling session must be untouched')
})

test('a terminal is not agent-exited until it is reported as such', () => {
  const m = seededManager()
  seedTerminal(m, 't1', 'sess-a')
  assert.equal(m.isAgentExited('t1'), false)
})

test('the PTY stays findable after the agent exits — the shell is alive, so the route must decide', () => {
  const m = seededManager()
  const session = seedTerminal(m, 't1', 'sess-a')

  m.markAgentExited('sess-a')

  // Precisely the trap: the session has NOT exited, so the old reuse check passed and handed
  // back a dead-end shell. findByCodeSessionId still finds it by design; isAgentExited is what
  // lets the terminal route tear it down and relaunch instead of reattaching.
  assert.equal(session.isExited(), false, 'the shell outlives the agent on purpose')
  assert.equal(m.findByCodeSessionId('sess-a'), 't1')
  assert.equal(m.isAgentExited('t1'), true, 'so reuse must be gated on this, not on isExited()')
})

test('markAgentExited on a session with no terminal is a no-op, not a throw', () => {
  const m = seededManager()
  assert.doesNotThrow(() => m.markAgentExited('nobody'))
  assert.equal(m.isAgentExited('nobody'), false)
})
