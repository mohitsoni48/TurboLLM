// Runs do not RESUME across a restart (spec 27 §6.4) — but their records must survive, so a
// client that reconnects after a daemon bounce gets an honest `failed` answer instead of a
// 404 that looks like the run never existed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { ConversationStore } from '../chat/db.js'
import { PublicRunManager } from './run-manager.js'
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
