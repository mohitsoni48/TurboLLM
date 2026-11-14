// turbollm/src/routines/execute.queue.test.ts
//
// Scalability review 4.3 (routines co-due on one single-slot gate) and 4.13 (a one-shot CLI routine between two of its
// gateway requests). Fake engine, fake router, fake fetch and fake timers: nothing spawns and nothing listens.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { executeRoutine, runCliRoutineBranch, acquireGateAmongRoutines, joinRoutineRuns } from './execute'
import { runCliCodeRoutine } from './cli-routine'
import { GenerationGate } from '../agents/gate'
import type { Deps } from '../deps'
import type { Manager } from '../engines/manager'
import type { ModelRouter } from '../gateway/model-router'
import type { Routine } from './schema'
import { tmpDir } from '../test-support/tmp'

const AGENT = { id: 'agent-1', name: 'a', systemPrompt: 'p', allowedTools: [], skills: [] }
const OK_STDOUT = '{"type":"result","subtype":"success","is_error":false,"result":"done"}\n'

/** An engine whose generation count and holds the test and the code under test both move, as Manager's own do. */
function countingManager(loadedKey: string): { manager: Manager; active: () => number; held: () => number } {
  let active = 0
  let held = 0
  const manager = {
    status: () => ({ state: 'running', model: { key: loadedKey } }),
    sessionStats: () => ({ activeRequests: active }),
    generationStart: () => { active++ },
    generationEnd: () => { active = Math.max(0, active - 1) },
    hold: () => { held++; return () => { held-- } },
    isHeld: () => held > 0,
    target: () => 'http://engine.invalid.local:1',
    currentOpts: () => null,
  } as unknown as Manager
  return { manager, active: () => active, held: () => held }
}

function harness(opts: { loadedKey: string; gate?: GenerationGate; poolSlot?: Manager }): { d: Deps; db: ConversationStore; loaded: string[]; active: () => number; held: () => number } {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const { manager, active, held } = countingManager(opts.loadedKey)
  const loaded: string[] = []
  const modelRouter = {
    loadExplicit: async (key: string) => { loaded.push(`${key} (held=${held()})`); return { target: 'http://x', ...(opts.poolSlot ? { manager: opts.poolSlot } : {}) } },
    reloadAfterRender: () => {},
  } as unknown as ModelRouter
  const snapshot = { customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 }, daemon: { port: 6996 } }
  const d = {
    db, manager, modelRouter,
    registry: { active: () => ({ kind: 'llama-server' }) },
    store: { snapshot: () => snapshot, read: () => snapshot, dir: () => tmpDir('execute-queue-test-') },
    gate: opts.gate,
    bench: { isRunning: () => false },
  } as unknown as Deps
  return { d, db, loaded, active, held }
}

function chatRoutine(db: ConversationStore, modelKey: string): Routine {
  return db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60 * 60_000 }, modelKey, agentId: 'agent-1' })
}

function cliRoutine(db: ConversationStore, modelKey: string): Routine {
  return db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey, workspacePath: '/repo', codingAgent: 'claude_cli' })
}

/** Moves the fake clock forward a second at a time, letting every promise the timers release settle in between. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1000) {
    mock.timers.tick(Math.min(1000, left))
    await new Promise((r) => setImmediate(r))
  }
}

// 4.3. A routine due at the same moment as another queues behind it on the gate. The gate gives a waiter up after 180 s,
// which skipped every routine past the second on a single-slot engine and rescheduled it a whole period later, so five
// routines set for 09:00 lost their run every day. A routine waiting behind other ROUTINES stays in line for its own run
// deadline instead (ADR-319's "skip if busy" is about the engine, the user's generation, not about a run queue).
test('routines due together on a single-slot gate all run, one after another', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = globalThis.fetch
  try {
    const { d, db } = harness({ loadedKey: 'm', gate: new GenerationGate(() => 1) })
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 100_000))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 })
    }) as typeof fetch
    const runs = Array.from({ length: 5 }, () => {
      const routine = chatRoutine(db, 'm')
      return { routine, run: db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) }) }
    })
    const done = runs.map(({ routine, run }) => executeRoutine(d, routine, run))
    await advance(5 * 100_000 + 10_000)
    assert.deepEqual(await Promise.all(done), ['ok', 'ok', 'ok', 'ok', 'ok'])
    assert.deepEqual(runs.map(({ run }) => db.getRoutineRun(run.id)!.status), ['ok', 'ok', 'ok', 'ok', 'ok'])
  } finally {
    globalThis.fetch = original
    mock.timers.reset()
  }
})

// Review M3. One deadline used to bound the wait in line AND the run: the fourth of five 3-minute routines waited 9
// minutes, got one for its run and was aborted mid-run, the fifth timed out waiting and was worded as a gate leak. The
// wait has its own budget now (ten minutes, one run's length); a run's deadline starts once it holds the gate.
test('five 3-minute routines due together: each runs with its full budget or skips cleanly as queue_timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = globalThis.fetch
  const warn = mock.method(console, 'warn', () => {})
  try {
    const { d, db } = harness({ loadedKey: 'm', gate: new GenerationGate(() => 1) })
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 180_000))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 })
    }) as typeof fetch
    const runs = Array.from({ length: 5 }, () => {
      const routine = chatRoutine(db, 'm')
      return { routine, run: db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) }) }
    })
    const done = runs.map(({ routine, run }) => executeRoutine(d, routine, run))
    await advance(5 * 180_000 + 10_000)
    assert.deepEqual(await Promise.all(done), ['ok', 'ok', 'ok', 'ok', 'skipped'])
    const rows = runs.map(({ run }) => db.getRoutineRun(run.id)!)
    assert.equal(rows[3]!.status, 'ok', 'the fourth waited nine minutes and still got its whole run')
    assert.equal(rows[4]!.skipReason, 'queue_timeout')
    assert.equal(warn.mock.callCount(), 0, 'waiting behind other routines is not a leaked hold: no warning per 3-minute retry')
  } finally {
    warn.mock.restore()
    globalThis.fetch = original
    mock.timers.reset()
  }
})

// A pi Code routine's session takes the gate itself before each request and holds nothing between two of them: a
// routine behind it is still waiting for a routine, not for the user.
test('a routine waits behind the gate holds of a running pi Code routine', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const warn = mock.method(console, 'warn', () => {})
  try {
    const gate = new GenerationGate(() => 1)
    const leave = joinRoutineRuns(gate) // the pi routine's run, whose session holds the gate request by request
    const piRequest = await gate.acquire('bg')
    let acquired = false
    const waiting = acquireGateAmongRoutines(gate, new AbortController().signal).then((release) => { acquired = true; return release })
    await advance(400_000)
    assert.equal(acquired, false, 'still in line after two gate timeouts')
    piRequest()
    const release = await waiting
    release()
    leave()
    assert.equal(warn.mock.callCount(), 0)
  } finally {
    warn.mock.restore()
    mock.timers.reset()
  }
})

test("a routine queued behind the USER's generation still skips as gate_timeout after the gate's wait", async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = globalThis.fetch
  try {
    const gate = new GenerationGate(() => 1)
    const { d, db } = harness({ loadedKey: 'm', gate })
    let fetched = false
    globalThis.fetch = (async () => { fetched = true; return new Response('{}', { status: 200 }) }) as typeof fetch
    const releaseUser = await gate.acquire('fg') // the user's chat turn, held for good
    const routine = chatRoutine(db, 'm')
    const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    const done = executeRoutine(d, routine, run)
    await advance(200_000)
    assert.equal(await done, 'skipped')
    assert.equal(db.getRoutineRun(run.id)!.skipReason, 'gate_timeout')
    assert.equal(fetched, false)
    releaseUser()
  } finally {
    globalThis.fetch = original
    mock.timers.reset()
  }
})

// 4.13. The CLI makes one gateway request per turn and runs its local tools in between: the engine's generation count
// reads zero then, and a routine due at that moment on another model swapped its model in under the running CLI.
test('a one-shot CLI routine keeps the engine held between its gateway requests', async () => {
  const { d, db, loaded, active, held } = harness({ loadedKey: 'cli-model' })
  const routine = cliRoutine(db, 'cli-model')
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let cliRunning!: () => void
  const running = new Promise<void>((r) => { cliRunning = r })
  let cliFinishes!: () => void
  const finish = new Promise<void>((r) => { cliFinishes = r })
  const cli = runCliRoutineBranch(d, routine, run, (r, deps) => runCliCodeRoutine(r, {
    ...deps,
    isAvailable: async () => true,
    permissionModeChoices: async () => [],
    runProcess: async () => { cliRunning(); await finish; return { exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' } },
  }))
  try {
    await running
    assert.equal(held(), 1, 'the CLI is between two gateway requests: the engine still reads as in use')
    assert.equal(active(), 0, 'but no generation is in flight: the engine card shows no live generation')

    const other = chatRoutine(db, 'another-model')
    const otherRun = db.createRoutineRun({ routineId: other.id, configSnapshot: JSON.stringify(other) })
    assert.equal(await executeRoutine(d, other, otherRun), 'skipped')
    assert.equal(db.getRoutineRun(otherRun.id)!.skipReason, 'model_busy')
    assert.deepEqual(loaded, [], "the other routine's model was never loaded under the running CLI")

  } finally {
    cliFinishes() // a failed assertion above must not leave the CLI (and its wall-clock timer) hanging
  }
  assert.equal(await cli, 'ok')
  assert.equal(held(), 0, 'the hold ends with the run')
})

test("a one-shot CLI routine lets go of the engine before it restores the user's model", async () => {
  const { d, db, loaded } = harness({ loadedKey: 'user-model' })
  const routine = cliRoutine(db, 'cli-model')
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const status = await runCliRoutineBranch(d, routine, run, (r, deps) => runCliCodeRoutine(r, {
    ...deps,
    isAvailable: async () => true,
    permissionModeChoices: async () => [],
    runProcess: async () => ({ exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' }),
  }))
  assert.equal(status, 'ok')
  // The swap happens with nothing held; the restore, which the router refuses on a generating engine, with nothing held either.
  assert.deepEqual(loaded, ['cli-model (held=0)', 'user-model (held=0)'])
})

// Review M4. A CLI whose model sits in a keep-N pool slot used to hold the primary too, refusing the user's loads onto it
// (503 busy) and suspending its idle watchdog for the whole run.
test("a CLI routine whose model sits in a pool slot holds that slot and leaves the primary alone", async () => {
  const slot = countingManager('cli-model')
  const { d, db, held } = harness({ loadedKey: 'user-model', poolSlot: slot.manager })
  const routine = cliRoutine(db, 'cli-model')
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const status = await runCliRoutineBranch(d, routine, run, (r, deps) => runCliCodeRoutine(r, {
    ...deps,
    isAvailable: async () => true,
    permissionModeChoices: async () => [],
    runProcess: async () => {
      assert.equal(slot.held(), 1, "the pool slot serving the run is held")
      assert.equal(held(), 0, "the user's primary is not")
      return { exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' }
    },
  }))
  assert.equal(status, 'ok')
  assert.equal(slot.held(), 0)
})
