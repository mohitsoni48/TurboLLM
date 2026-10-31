// The data-retention sweep (scalability review 2.4, retention.ts): raw gateway usage older than the configured days
// folds into daily totals, and each routine keeps its newest N runs, the older ones deleted with the conversation or
// Code session each made. In small transactions, yielding to the event loop between them, one sweep at a time.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { ROUTINE_RUN_BATCH_SIZE, RetentionSweeper, type RetentionDeps } from './retention'
import type { CodeSessionDeletion } from '../deps'
import type { SqlDb } from './store/sqlite-adapter'

const ON = { enabled: true, apiUsageRawDays: 90, routineRunsKept: 200 }
const DAY = 86_400_000

function rawDb(store: ConversationStore): SqlDb {
  return (store as unknown as { db: SqlDb }).db
}

function apiRows(store: ConversationStore, n: number, at: string): void {
  const ins = rawDb(store).prepare(`INSERT INTO api_usage (id, created_at, source, model_key, prompt_tokens, gen_tokens) VALUES (?,?,'openai','m',10,5)`)
  rawDb(store).exec('BEGIN')
  for (let i = 0; i < n; i++) ins.run(randomUUID(), at)
  rawDb(store).exec('COMMIT')
}

const rawApiRows = (store: ConversationStore) => (rawDb(store).prepare('SELECT COUNT(*) AS n FROM api_usage').get() as { n: number }).n

/** A message in `convId` written at `at` (ms). */
function messageAt(store: ConversationStore, convId: string, role: 'user' | 'assistant', at: number): void {
  const message = store.addMessage(convId, role, `${role} at ${at}`)
  rawDb(store).prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(at).toISOString(), message.id)
}

type Run = { id: string; convId: string; endedAt: number; conversationId?: string; codeSessionId?: string }

/** A routine with `n` finished runs a second apart, oldest first, each ending half a second after it started; chat
 *  runs each get their own agent conversation, code runs their own Code session, with the prompt and reply the run
 *  wrote while it ran. */
function routine(store: ConversationStore, flavor: 'chat' | 'code', n: number) {
  const r = store.createRoutine({ flavor, prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm' })
  const runs: Run[] = []
  const start = Date.now() - 10 * DAY
  for (let i = 0; i < n; i++) {
    const run = store.createRoutineRun({ routineId: r.id, configSnapshot: '{}' })
    const startedAt = start + i * 1000
    rawDb(store).prepare(`UPDATE routine_runs SET started_at = ?, ended_at = ?, status = 'ok' WHERE id = ?`)
      .run(new Date(startedAt).toISOString(), new Date(startedAt + 500).toISOString(), run.id)
    const conv = store.createConversation({ kind: flavor === 'chat' ? 'agent' : 'code', modelKey: 'm' })
    messageAt(store, conv.id, 'user', startedAt)
    messageAt(store, conv.id, 'assistant', startedAt + 100)
    if (flavor === 'chat') {
      store.updateRoutineRun(run.id, { conversationId: conv.id })
      runs.push({ id: run.id, convId: conv.id, endedAt: startedAt + 500, conversationId: conv.id })
    } else {
      const session = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/r' })
      store.updateRoutineRun(run.id, { codeSessionId: session.id })
      runs.push({ id: run.id, convId: conv.id, endedAt: startedAt + 500, codeSessionId: session.id })
    }
  }
  return { routineId: r.id, runs }
}

/** The Code session delete's cleanup as a store-only stand-in, recording each session it is asked for. */
function codeCleanup(store: ConversationStore, refuse: Record<string, CodeSessionDeletion> = {}) {
  const calls: string[] = []
  const deleteCodeSession = async (id: string): Promise<CodeSessionDeletion> => {
    calls.push(id)
    if (refuse[id]) return refuse[id]
    store.deleteCodeSession(id)
    return { deleted: true }
  }
  return { calls, deleteCodeSession }
}

function sweeper(store: ConversationStore, over: Partial<RetentionDeps> = {}) {
  const lines: string[] = []
  const s = new RetentionSweeper({ db: store, settings: () => ON, log: (l) => lines.push(l), ...over })
  return { s, lines }
}

test('disabled: the sweep deletes and folds nothing', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  apiRows(store, 10, new Date(Date.now() - 400 * DAY).toISOString())
  const { routineId } = routine(store, 'chat', 15)
  const { s } = sweeper(store, { settings: () => ({ ...ON, enabled: false, routineRunsKept: 10 }) })
  assert.equal(await s.sweep(), null)
  assert.equal(rawApiRows(store), 10)
  assert.equal(store.countRoutineRuns(routineId), 15)
  store.close()
})

test('gateway usage older than apiUsageRawDays folds into daily totals; the dashboard numbers stay the same', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  apiRows(store, 30, new Date(Date.now() - 120 * DAY).toISOString())
  apiRows(store, 5, new Date(Date.now() - 60 * DAY).toISOString())
  apiRows(store, 2, new Date().toISOString())
  const before = store.apiUsageStats('all')
  const { s, lines } = sweeper(store)
  const summary = await s.sweep()
  assert.equal(summary?.apiUsageRolledUp, 30)
  assert.equal(rawApiRows(store), 7)
  assert.deepEqual(store.apiUsageStats('all'), before)
  assert.equal(lines.length, 1, 'one summary line')
  assert.match(lines[0], /30 gateway usage rows/)
  store.close()
})

test('a sweep over 5k rows runs in batches of 500 and yields to the event loop between them', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  apiRows(store, 5000, new Date(Date.now() - 200 * DAY).toISOString())
  const { s } = sweeper(store)
  let ticks = 0
  let sweeping = true
  const tick = () => { if (!sweeping) return; ticks++; setImmediate(tick) }
  setImmediate(tick)
  const summary = await s.sweep()
  sweeping = false
  assert.ok(summary && summary.batches >= 10, `ran in ${summary?.batches} batches`)
  assert.ok(ticks >= 9, `the event loop ran ${ticks} times during the sweep`)
  assert.equal(rawApiRows(store), 0)
  store.close()
})

test('each routine keeps its newest runs; older ones go with their own conversations, running and parked ones stay', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const a = routine(store, 'chat', 205)
  const b = routine(store, 'chat', 3)
  store.updateRoutineRun(a.runs[0].id, { status: 'running' })
  store.updateRoutineRun(a.runs[1].id, { status: 'needs_approval' })
  const userChat = store.createConversation({ kind: 'chat', modelKey: 'm' })

  const { s } = sweeper(store)
  const summary = await s.sweep()

  assert.equal(summary?.routineRunsPruned, 3)
  assert.equal(summary?.conversationsDeleted, 3)
  const kept = new Set(store.listRoutineRuns(a.routineId).map((r) => r.id))
  assert.equal(kept.size, 202)
  for (const run of a.runs.slice(5)) assert.ok(kept.has(run.id) && store.getConversation(run.conversationId!), 'the newest 200 and their conversations stay')
  for (const run of a.runs.slice(0, 2)) assert.ok(kept.has(run.id) && store.getConversation(run.conversationId!), 'running and parked runs stay')
  for (const run of a.runs.slice(2, 5)) {
    assert.equal(store.getRoutineRun(run.id), null)
    assert.equal(store.getConversation(run.conversationId!), null)
  }
  assert.equal(store.countRoutineRuns(b.routineId), 3)
  assert.ok(store.getConversation(userChat.id))
  store.close()
})

test('a pruned Code run\'s session is deleted through the Code session delete\'s cleanup; one still running is kept', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const c = routine(store, 'code', 13)
  const busy = c.runs[1].codeSessionId!
  const { calls, deleteCodeSession } = codeCleanup(store, { [busy]: { deleted: false, reason: 'run_active' } })
  const { s } = sweeper(store, { settings: () => ({ ...ON, routineRunsKept: 10 }), deleteCodeSession })
  const summary = await s.sweep()

  assert.deepEqual(calls, c.runs.slice(0, 3).map((r) => r.codeSessionId))
  assert.equal(summary?.codeSessionsDeleted, 2)
  assert.equal(summary?.routineRunsPruned, 2)
  assert.ok(store.getRoutineRun(c.runs[1].id), 'the run whose session is busy stays, with it')
  assert.equal(store.getRoutineRun(c.runs[0].id), null)
  assert.equal(store.getAgentRun(c.runs[0].codeSessionId!), null)
  store.close()
})

test('a chat run the user went on with after it ended is kept past the newest 200, and still counts toward them', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const a = routine(store, 'chat', 203)
  const [continued, regenerated, untouched] = a.runs
  messageAt(store, continued.convId, 'user', continued.endedAt + 1)
  messageAt(store, continued.convId, 'assistant', continued.endedAt + 2)
  messageAt(store, regenerated.convId, 'assistant', regenerated.endedAt + 10 * 60_000)

  const summary = await sweeper(store).s.sweep()

  assert.equal(summary?.routineRunsPruned, 1)
  assert.equal(store.getRoutineRun(untouched.id), null)
  assert.equal(store.getConversation(untouched.convId), null)
  assert.ok(store.getRoutineRun(continued.id) && store.getRoutineRun(regenerated.id), 'the runs stay')
  assert.equal(store.getMessages(continued.convId).length, 4, 'with their chats, follow-ups included')
  assert.equal(store.getMessages(regenerated.convId).length, 3)
  assert.equal(store.countRoutineRuns(a.routineId), 202, 'the newest 200 are not shifted by the kept ones')
  store.close()
})

test('a Code run whose session has a user turn after the run is kept past the newest 200; an untouched one is pruned', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const c = routine(store, 'code', 202)
  const [continued, untouched] = c.runs
  messageAt(store, continued.convId, 'user', continued.endedAt + 30_000)
  const { calls, deleteCodeSession } = codeCleanup(store)

  const summary = await sweeper(store, { deleteCodeSession }).s.sweep()

  assert.deepEqual(calls, [untouched.codeSessionId], 'the continued session is never handed to the cleanup (its worktree stays)')
  assert.equal(summary?.routineRunsPruned, 1)
  assert.ok(store.getRoutineRun(continued.id))
  assert.ok(store.getAgentRun(continued.codeSessionId!))
  assert.equal(store.getRoutineRun(untouched.id), null)
  store.close()
})

test('routine runs are pruned in small batches (each cascading a whole chat), yielding between them', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  routine(store, 'chat', 260)
  const sizes: number[] = []
  const deleteRoutineRuns = store.deleteRoutineRuns.bind(store)
  store.deleteRoutineRuns = (runs) => { sizes.push(runs.length); return deleteRoutineRuns(runs) }

  const summary = await sweeper(store).s.sweep()

  assert.equal(summary?.routineRunsPruned, 60)
  assert.equal(ROUTINE_RUN_BATCH_SIZE, 25)
  assert.deepEqual(sizes, [25, 25, 10])
  store.close()
})

test('a Code run whose worktree cannot be removed (uncommitted work) keeps its run and session, and says so', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const c = routine(store, 'code', 12)
  const dirty = c.runs[0].codeSessionId!
  const { deleteCodeSession } = codeCleanup(store, { [dirty]: { deleted: false, reason: 'worktree_kept', worktreeNote: 'has local changes' } })
  const { s, lines } = sweeper(store, { settings: () => ({ ...ON, routineRunsKept: 10 }), deleteCodeSession })

  const summary = await s.sweep()

  assert.equal(summary?.routineRunsPruned, 1)
  assert.ok(store.getRoutineRun(c.runs[0].id), 'the run stays, so its session and worktree are still reachable')
  assert.ok(store.getAgentRun(dirty))
  assert.equal(store.getRoutineRun(c.runs[1].id), null)
  assert.ok(lines.some((l) => l.includes(dirty) && l.includes('has local changes')), lines.join('\n'))
  store.close()
})

test('without the Code session cleanup (Code not loaded), Code routine runs are left alone', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const c = routine(store, 'code', 12)
  const { s } = sweeper(store, { settings: () => ({ ...ON, routineRunsKept: 10 }) })
  assert.equal((await s.sweep())?.routineRunsPruned, 0)
  assert.equal(store.countRoutineRuns(c.routineId), 12)
  store.close()
})

test('single flight: a sweep asked for while one runs joins it', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  apiRows(store, 1200, new Date(Date.now() - 200 * DAY).toISOString())
  const { s, lines } = sweeper(store)
  const first = s.sweep()
  const second = s.sweep()
  assert.equal(first, second)
  await first
  assert.equal(lines.length, 1)
  store.close()
})

test('a failing sweep is logged, not thrown', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const { s, lines } = sweeper(store)
  store.close()
  assert.equal(await s.sweep(), null)
  assert.match(lines[0], /retention sweep failed/)
})

test('start(): the first sweep a minute after startup, then daily; stop() ends both', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let sweeps = 0
  const s = new RetentionSweeper({ db: {} as ConversationStore, settings: () => ON, log: () => {} })
  s.sweep = () => { sweeps++; return Promise.resolve(null) }
  s.start()
  t.mock.timers.tick(59_000)
  assert.equal(sweeps, 0, 'not during boot')
  t.mock.timers.tick(1_000)
  assert.equal(sweeps, 1)
  t.mock.timers.tick(DAY)
  assert.equal(sweeps, 2)
  s.stop()
  t.mock.timers.tick(2 * DAY)
  assert.equal(sweeps, 2)
})
