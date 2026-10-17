// Runs do not RESUME across a restart (spec 27 §6.4) — but their records must survive, so a
// client that reconnects after a daemon bounce gets an honest `failed` answer instead of a
// 404 that looks like the run never existed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { ConversationStore } from '../chat/db.js'
import { PublicRunManager, type PublicRun, type RunRecordRow, type RunRecordStore } from './run-manager.js'
import { tmpDir } from '../test-support/tmp'

const SCOPE = { tenant: 'acme', owner: 'u1' }

test('a completed run is readable after the manager is rebuilt', async () => {
  const dir = tmpDir('turbollm-run-durable-')
  const db = new ConversationStore(dir)
  try {
    const first = new PublicRunManager({ db })
    const run = first.start({
      scope: SCOPE, chatId: 'c1', messageId: 'm1',
      body: async ({ emit }) => { await emit({ event: 'delta', data: { content: 'x' } }); return { status: 'complete' } },
    })
    await first.settled(run.id)

    // A fresh manager over the same DB — i.e. the daemon restarted.
    const second = new PublicRunManager({ db })
    const seen = second.get(run.id)
    assert.equal(seen?.status, 'complete')
    assert.equal(seen?.chatId, 'c1')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// The final write ran before the done frame was emitted, so once the run left memory its row
// reported one frame fewer than the run had while it was live (2 here instead of 3).
test('a completed run read back from the DB reports the event_seq of its done frame', async () => {
  const dir = tmpDir('turbollm-run-durable-seq-')
  const db = new ConversationStore(dir)
  try {
    const first = new PublicRunManager({ db })
    const run = first.start({
      scope: SCOPE, chatId: 'c1', messageId: 'm1',
      body: async ({ emit }) => {
        await emit({ event: 'delta', data: { delta: 'a' } })
        await emit({ event: 'delta', data: { delta: 'b' } })
        return { status: 'complete' }
      },
    })
    await first.settled(run.id)
    assert.equal(first.get(run.id)?.eventSeq, 3, 'two deltas and the done frame, numbered from 1')

    const second = new PublicRunManager({ db })
    assert.equal(second.get(run.id)?.eventSeq, 3)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('a run still streaming at restart is reconciled to failed/daemon_restarted', async () => {
  const dir = tmpDir('turbollm-run-orphan-')
  const db = new ConversationStore(dir)
  try {
    db.upsertExtRun({
      id: 'run_orphan', chatId: 'c1', messageId: 'm1', tenant: 'acme', owner: 'u1',
      status: 'streaming', eventSeq: 12, error: null,
      createdAt: new Date().toISOString(), endedAt: null,
    })

    const runs = new PublicRunManager({ db })
    runs.reconcileOnStartup()

    const seen = runs.get('run_orphan')
    assert.equal(seen?.status, 'failed')
    assert.equal(seen?.error?.code, 'daemon_restarted')
    assert.ok(seen?.endedAt)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('listing runs is tenant-scoped and survives a restart', async () => {
  const dir = tmpDir('turbollm-run-list-')
  const db = new ConversationStore(dir)
  try {
    const runs = new PublicRunManager({ db })
    const mine = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: async () => ({ status: 'complete' }) })
    runs.start({ scope: { tenant: 'globex', owner: 'u1' }, chatId: 'c2', messageId: 'm2', body: async () => ({ status: 'complete' }) })
    await runs.settled(mine.id)

    const rebuilt = new PublicRunManager({ db })
    assert.deepEqual(rebuilt.list('acme').map((r) => r.id), [mine.id])
    assert.equal(rebuilt.list('globex').length, 1)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('listing runs is owner-scoped even when reading back from the persisted DB rows', async () => {
  const dir = tmpDir('turbollm-run-list-owner-')
  const db = new ConversationStore(dir)
  try {
    const runs = new PublicRunManager({ db })
    const mine = runs.start({ scope: { tenant: 'acme', owner: 'u1' }, chatId: 'c1', messageId: 'm1', body: async () => ({ status: 'complete' }) })
    const theirs = runs.start({ scope: { tenant: 'acme', owner: 'u2' }, chatId: 'c2', messageId: 'm2', body: async () => ({ status: 'complete' }) })
    await runs.settled(mine.id)
    await runs.settled(theirs.id)

    // A fresh manager over the same DB (i.e. the daemon restarted) — the in-memory map is empty,
    // so this exercises the `db.listExtRuns` fallback path specifically, not the in-memory filter.
    const rebuilt = new PublicRunManager({ db })
    assert.deepEqual(rebuilt.list('acme', 'u1').map((r) => r.id), [mine.id], 'owner u1 must not see owner u2\'s persisted run')
    assert.deepEqual(rebuilt.list('acme', 'u2').map((r) => r.id), [theirs.id])
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// The owner filter ran in JS AFTER the tenant-wide `LIMIT 100`, so once a run left the
// in-memory map, an owner whose runs were older than 100 other owners' runs got an empty list.
test("an owner's persisted runs are listed even when other owners in the tenant have 100+ newer runs", () => {
  const dir = tmpDir('turbollm-run-list-limit-')
  const db = new ConversationStore(dir)
  try {
    const row = (id: string, owner: string, createdAt: string) => ({
      id, chatId: 'c', messageId: 'm', tenant: 'acme', owner, status: 'complete' as const,
      eventSeq: 0, error: null, createdAt, endedAt: createdAt,
    })
    db.upsertExtRun(row('run_b', 'u-b', '2026-01-01T00:00:00.000Z'))
    for (let i = 0; i < 100; i++) db.upsertExtRun(row(`run_a${i}`, 'u-a', new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString()))

    // A fresh manager: nothing in memory, so this reads the persisted rows only.
    const runs = new PublicRunManager({ db })
    assert.deepEqual(runs.list('acme', 'u-b').map((r) => r.id), ['run_b'])
    assert.equal(runs.list('acme', 'u-a').length, 100)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('with no db the manager still works, purely in memory', async () => {
  const runs = new PublicRunManager()
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: async () => ({ status: 'complete' }) })
  await runs.settled(run.id)
  assert.equal(runs.get(run.id)?.status, 'complete')
})

/** An in-memory ext_runs table whose writes throw (as node:sqlite does on a full disk or a locked
 *  or closed DB) while `fails(run)` says so. Rows are copies, as SQLite's are. */
function flakyRunStore(fails: (r: PublicRun) => boolean): RunRecordStore & { rows: Map<string, RunRecordRow> } {
  const rows = new Map<string, RunRecordRow>()
  return {
    rows,
    upsertExtRun(r) {
      if (fails(r)) throw new Error('database or disk is full')
      rows.set(r.id, { ...r })
    },
    getExtRun: (id) => rows.get(id) ?? null,
    listExtRuns: (tenant, owner) => [...rows.values()].filter((r) => r.tenant === tenant && (owner === undefined || r.owner === owner)),
    markStreamingExtRunsFailed: () => 0,
  }
}

/** Drains a subscription, or rejects when it is still open after `ms`. */
function drainWithin(sub: AsyncIterable<{ event: string; data: unknown }>, ms = 2_000) {
  const out: Array<{ event: string; data: unknown }> = []
  const drained = (async () => { for await (const ev of sub) out.push(ev); return out })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`stream still open after ${ms} ms: ${out.map((e) => e.event).join(',')}`)), ms) })
  return Promise.race([drained, timeout]).finally(() => clearTimeout(timer))
}

// The final write ran after the done frame and before 'idle', so when it threw (disk full, DB
// locked) 'idle' never went out: every attached SSE stream stayed open with the done frame
// delivered, and settled() rejected. The row kept the 'complete' status written before it, with
// no ended_at, so once prune() dropped the run from memory that row reported it running and
// isChatActive() refused every turn and edit on its chat for good: a restart did not clear it
// either (see the next test).
test('a run whose final record write fails still closes its streams, and its stale row never blocks the chat', async () => {
  let failing = true
  const db = flakyRunStore((r) => failing && r.endedAt !== null)
  const runs = new PublicRunManager({ db })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({
    scope: SCOPE, chatId: 'c1', messageId: 'm1',
    body: async ({ emit }) => { await gate; await emit({ event: 'delta', data: { content: 'x' } }); return { status: 'complete' } },
  })
  const sub = runs.subscribe(run.id, 0)
  release()
  const events = await drainWithin(sub)
  assert.deepEqual(events.map((e) => e.event), ['delta', 'done'])
  await runs.settled(run.id)
  assert.equal(runs.get(run.id)?.status, 'complete', 'the reply was generated: a lost record write does not change that')
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false)

  // A cutoff 1 ms ahead: prune()'s test is a strict `<`, so with 0 a run that ended in this same
  // millisecond would be skipped and the assertions below would pass without prune() running.
  runs.prune(-1)
  assert.equal(db.rows.get(run.id)?.endedAt, null, 'the row is still stale')
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false, 'the stale row must not read as a running run')
  assert.equal(runs.get(run.id)?.endedAt !== null, true)

  // Once the DB takes writes again, the next prune saves the record and only then drops the run.
  failing = false
  runs.prune(-1)
  assert.equal(db.rows.get(run.id)?.status, 'complete')
  assert.ok(db.rows.get(run.id)?.endedAt)
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false)
})

// reconcileOnStartup() closed only queued/streaming rows, so the row a failed final write left
// ('complete', no ended_at) still read as a running run after a restart, and isChatActive()
// refused every turn and edit on its chat for good.
test('a run whose final record write failed before the daemon exited leaves its chat free after the restart', async () => {
  const dir = tmpDir('turbollm-run-final-write-')
  const conv = new ConversationStore(dir)
  try {
    const db: RunRecordStore = {
      upsertExtRun: (r) => { if (r.endedAt !== null) throw new Error('database or disk is full'); conv.upsertExtRun(r) },
      getExtRun: (id) => conv.getExtRun(id),
      listExtRuns: (t, o, l) => conv.listExtRuns(t, o, l),
      markStreamingExtRunsFailed: (c, m) => conv.markStreamingExtRunsFailed(c, m),
    }
    const first = new PublicRunManager({ db })
    const run = first.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: async () => ({ status: 'complete' }) })
    await first.settled(run.id)
    assert.equal(conv.getExtRun(run.id)?.endedAt, null, 'the final write did not land')

    // The daemon exits before a prune() retry lands; the next one starts over the same DB.
    const second = new PublicRunManager({ db: conv })
    second.reconcileOnStartup()
    assert.equal(second.isChatActive(SCOPE, 'c1'), false)
    const seen = second.get(run.id)
    assert.equal(seen?.status, 'complete', 'the reply was generated: the restart keeps that outcome')
    assert.ok(seen?.endedAt)
  } finally {
    conv.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// The first write ran in start() itself and its throw went out of the generate route: a bare 500,
// with the chat's reservation and the tenant's concurrency slot never released. A failed
// 'streaming' write rejected settled() before the body ran, leaving the run 'streaming' in memory
// for good: no done frame, its streams open and its chat refused until the daemon restarted.
for (const which of ['queued', 'streaming'] as const) {
  test(`a run whose ${which} record cannot be written ends at once as failed, with its streams closed and its chat free`, async () => {
    const db = flakyRunStore((r) => r.status === which)
    const runs = new PublicRunManager({ db })
    let bodySawAborted: boolean | undefined
    const run = runs.start({
      scope: SCOPE, chatId: 'c1', messageId: 'm1',
      body: async ({ emit, signal }) => {
        bodySawAborted = signal.aborted
        if (!signal.aborted) await emit({ event: 'delta', data: { content: 'x' } })
        return { status: signal.aborted ? 'aborted' : 'complete' }
      },
    })
    const events = await drainWithin(runs.subscribe(run.id, 0))
    await runs.settled(run.id)
    assert.equal(bodySawAborted, true, 'the body runs only to settle its message, as for a run cancelled at once')
    assert.deepEqual(events.map((e) => e.event), ['error', 'done'])
    assert.equal((events[0].data as { type: string }).type, 'storage')
    assert.equal((events[1].data as { status: string }).status, 'failed')
    const seen = runs.get(run.id)
    assert.equal(seen?.status, 'failed')
    assert.equal(seen?.error?.type, 'storage')
    assert.ok(seen?.endedAt)
    assert.equal(runs.isChatActive(SCOPE, 'c1'), false)
    assert.equal(db.rows.get(run.id)?.status, 'failed', 'the terminal write lands when the DB takes it')
  })
}

// A run whose record could not be written never ran its body before (the queued write threw out
// of start(), a failed streaming write rejected the run ahead of the body). Its body now runs,
// with the signal already aborted, to settle its placeholder message, so an error it throws must
// not go out as an engine_error frame next to the storage one: the client would see two errors
// for one cause, and the first of them not the cause.
test('a run whose record cannot be written reports only its storage error, even when its body throws', async () => {
  const db = flakyRunStore((r) => r.status === 'queued')
  const runs = new PublicRunManager({ db })
  const run = runs.start({
    scope: SCOPE, chatId: 'c1', messageId: 'm1',
    body: async () => { throw new Error('the operation was aborted') },
  })
  const events = await drainWithin(runs.subscribe(run.id, 0))
  await runs.settled(run.id)
  assert.deepEqual(events.map((e) => e.event), ['error', 'done'])
  assert.equal((events[0].data as { code: string }).code, 'run_not_recorded')
  assert.equal(runs.get(run.id)?.error?.code, 'run_not_recorded')
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false)
})
