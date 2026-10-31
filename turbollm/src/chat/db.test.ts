// Scalability review, Tier 2 (docs/plans/2026-10-31-scalability-review.md). Desktop runs
// node:sqlite synchronously on the event loop, so any query that walks a whole history table
// blocks every HTTP and SSE request while it runs. These tests pin two things per fixed path:
// the answer is what it always was, and the work no longer grows with stored history (measured
// as rows handed to JavaScript, and as SQLite's own query plan: SEARCH via an index, not SCAN).
// One SQL class serves desktop's node:sqlite and Android's sql.js, so each check runs on both.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { registerChatRoutes } from './chat-routes'
import { SearchIndexBackfill } from './search-index-backfill'
import { openSqlDb, preloadSqlJs, type SqlDb } from './store/sqlite-adapter'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

type Backend = 'node:sqlite' | 'sql.js'
const BACKENDS: Backend[] = ['node:sqlite', 'sql.js']

/** Runs `fn` against a fresh store on `backend`, closing (and for sql.js, deleting) it after. */
async function withStore(backend: Backend, fn: (store: ConversationStore) => void | Promise<void>): Promise<void> {
  if (backend === 'node:sqlite') {
    const store = new ConversationStore(IN_MEMORY_DATA_DIR)
    try { await fn(store) } finally { store.close() }
    return
  }
  const actual = process.platform
  Object.defineProperty(process, 'platform', { value: 'android' })
  const dir = tmpDir('tllm-scale-sqljs-')
  let store: ConversationStore | null = null
  try {
    await preloadSqlJs()
    store = new ConversationStore(dir)
    await fn(store)
  } finally {
    store?.close()
    Object.defineProperty(process, 'platform', { value: actual })
    rmSync(dir, { recursive: true, force: true })
  }
}

function rawDb(store: ConversationStore): SqlDb {
  return (store as unknown as { db: SqlDb }).db
}

/** Every statement `fn` prepares, and how many rows those statements handed back to JS. */
function observe<T>(store: ConversationStore, fn: () => T): { result: T; rows: number; sqls: string[] } {
  const db = rawDb(store)
  const prepare = db.prepare
  let rows = 0
  const sqls: string[] = []
  db.prepare = (sql: string) => {
    sqls.push(sql)
    const stmt = prepare.call(db, sql)
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown
        if (typeof value !== 'function') return value
        if (prop === 'all') return (...a: unknown[]) => { const r = (value as (...x: unknown[]) => unknown[]).apply(target, a); rows += r.length; return r }
        if (prop === 'get') return (...a: unknown[]) => { const r = (value as (...x: unknown[]) => unknown).apply(target, a); if (r) rows++; return r }
        return (value as (...x: unknown[]) => unknown).bind(target)
      },
    })
  }
  try {
    return { result: fn(), rows, sqls }
  } finally {
    db.prepare = prepare
  }
}

/** SQLite's own plan for `sql` (unbound parameters read as NULL, which EXPLAIN never evaluates). */
function planOf(store: ConversationStore, sql: string): string[] {
  return (rawDb(store).prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail)
}

/** Plans of every data statement `sqls` holds, flattened. */
function plansOf(store: ConversationStore, sqls: string[]): string[] {
  return sqls.filter((s) => /^\s*(SELECT|UPDATE|WITH|DELETE)/i.test(s)).flatMap((s) => planOf(store, s))
}

/** No SCAN of `tables`, except a walk of one of `partialIndexes`, which hold only the rows the
 *  query wants (and so stay small however big the table grows). */
function assertNoScan(plan: string[], tables: string[], partialIndexes: string[] = []): void {
  for (const t of tables) {
    const scans = plan.filter((d) => new RegExp(`^SCAN ${t}\\b`).test(d) && !partialIndexes.some((i) => d.includes(`USING INDEX ${i}`)))
    assert.deepEqual(scans, [], `expected no full SCAN of ${t}; plan was:\n${plan.join('\n')}`)
  }
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const DAY = 86_400_000

/** Bulk-inserts `n` assistant messages straight into the table (a real history at scale, without
 *  20k round trips through addMessage). */
function bulkMessages(store: ConversationStore, convId: string, n: number, row: (i: number) => { stats: string; modelKey: string | null; createdAt: string; toolCalls?: string | null }): void {
  const db = rawDb(store)
  const start = (db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE conv_id = ?').get(convId) as { s: number }).s
  const ins = db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,stats,model_key,created_at,tool_calls) VALUES (?,?,?,'assistant','x',?,?,?,?)`)
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const r = row(i)
    ins.run(randomUUID(), convId, start + i + 1, r.stats, r.modelKey, r.createdAt, r.toolCalls ?? null)
  }
  db.exec('COMMIT')
}

function setCreatedAt(store: ConversationStore, table: string, id: string, createdAt: string): void {
  rawDb(store).prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(createdAt, id)
}

// ── 2.1 lastGenTpsByModel ─────────────────────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`lastGenTpsByModel: the newest reply with a usable t/s wins, per model (${backend})`, () => withStore(backend, (store) => {
    const a = store.createConversation({ modelKey: 'model-a' })
    const b = store.createConversation({ modelKey: 'model-b' })
    const c = store.createConversation({ modelKey: 'model-c' })
    const oldA = store.addMessage(a.id, 'assistant', 'x', { stats: { tps: 30.04 } as never })
    const newerNoTps = store.addMessage(a.id, 'assistant', 'x', { stats: { genTokens: 5 } as never })
    const newerGarbage = store.addMessage(a.id, 'assistant', 'x', { stats: {} as never })
    const newestStringTps = store.addMessage(a.id, 'assistant', 'x', { stats: {} as never })
    rawDb(store).prepare('UPDATE messages SET stats = ? WHERE id = ?').run('not json{', newerGarbage.id)
    rawDb(store).prepare('UPDATE messages SET stats = ? WHERE id = ?').run('{"tps":"99"}', newestStringTps.id)
    setCreatedAt(store, 'messages', oldA.id, iso(4000))
    setCreatedAt(store, 'messages', newerNoTps.id, iso(3000))
    setCreatedAt(store, 'messages', newerGarbage.id, iso(2000))
    setCreatedAt(store, 'messages', newestStringTps.id, iso(1000))
    const zero = store.addMessage(b.id, 'assistant', 'x', { stats: { tps: 0 } as never })
    setCreatedAt(store, 'messages', zero.id, iso(100))
    store.addMessage(c.id, 'assistant', 'x', { stats: { tps: 12.34 } as never })
    store.addMessage(c.id, 'user', 'x')
    store.addMessage(store.createConversation().id, 'assistant', 'x', { stats: { tps: 50 } as never }) // no model

    assert.deepEqual([...store.lastGenTpsByModel().entries()].sort(), [['model-a', 30], ['model-c', 12.3]])
  }))

  test(`lastGenTpsByModel: work does not grow with history — index seeks only (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ modelKey: 'm' })
    const models = ['m1', 'm2', 'm3']
    bulkMessages(store, conv.id, 20_000, (i) => ({ stats: JSON.stringify({ tps: (i % 50) + 1, genTokens: 3 }), modelKey: models[i % 3], createdAt: iso((20_000 - i) * 1000) }))
    // The newest row for m3 has no t/s: the one before it must win, not the absent one.
    bulkMessages(store, conv.id, 1, () => ({ stats: '{"genTokens":1}', modelKey: 'm3', createdAt: iso(0) }))

    const { result, rows, sqls } = observe(store, () => store.lastGenTpsByModel())
    assert.deepEqual([...result.entries()].sort(), [['m1', 49], ['m2', 50], ['m3', 48]])
    assert.ok(rows <= 3 * models.length + 2, `handed ${rows} rows to JS for ${models.length} models`)
    const plan = plansOf(store, sqls)
    assertNoScan(plan, ['messages'])
    assert.ok(plan.some((d) => /^SEARCH messages USING (COVERING )?INDEX idx_messages_model_tps/.test(d)), plan.join('\n'))
  }))
}

// ── 2.8 messages(created_at) index, startup reconcile ─────────────────────────────

for (const backend of BACKENDS) {
  test(`migration 53 adds the created_at, t/s and unfinished-reply indexes (${backend})`, () => withStore(backend, (store) => {
    const db = rawDb(store)
    assert.ok((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 53)
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((r) => r.name)
    for (const n of ['idx_messages_created', 'idx_messages_model_tps', 'idx_messages_unfinished', 'idx_conversations_kind_updated', 'idx_agent_runs_updated', 'idx_routine_runs_routine_started']) {
      assert.ok(names.includes(n), `missing ${n}`)
    }
  }))

  test(`the startup reconcile and the daily roll-ups use an index, not a table scan (${backend})`, () => withStore(backend, (store) => {
    const { sqls } = observe(store, () => store.abortUnfinishedReplies())
    const plan = plansOf(store, sqls)
    assertNoScan(plan, ['messages', 'conversations'], ['idx_messages_unfinished'])
    assert.ok(plan.some((d) => d.includes('idx_messages_unfinished')), plan.join('\n'))

    const daily = observe(store, () => store.chatDailyStats('2026-10-01'))
    assert.ok(plansOf(store, daily.sqls).every((d) => !/^SCAN messages\b/.test(d)), plansOf(store, daily.sqls).join('\n'))
    const codeDaily = plansOf(store, observe(store, () => store.codeDailyStats('2026-10-01')).sqls)
    assert.ok(codeDaily.some((d) => /^SEARCH m USING INDEX idx_messages_created/.test(d)), codeDaily.join('\n'))
  }))
}

test('migration 53 is idempotent: reopening a migrated file database keeps its data and version', () => {
  const dir = tmpDir('tllm-scale-reopen-')
  try {
    const first = new ConversationStore(dir)
    const conv = first.createConversation()
    first.addMessage(conv.id, 'assistant', 'kept', { stats: { tps: 7 } as never })
    rawDb(first).exec('PRAGMA user_version = 52') // as if a crash landed between the index and the version bump
    first.close()
    const again = new ConversationStore(dir)
    try {
      assert.ok((rawDb(again).prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 53)
      assert.equal(again.lastGenTpsByModel().size, 0, 'the conversation has no model key')
      assert.equal(again.getMessages(conv.id)[0].content, 'kept')
    } finally {
      again.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration 53 announces its index build over a long history before it starts, and stays quiet over a short one', () => {
  const dir = tmpDir('tllm-scale-v53-log-')
  const log = console.log
  const lines: string[] = []
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  try {
    const first = new ConversationStore(dir)
    const conv = first.createConversation()
    first.addMessage(conv.id, 'user', 'short history')
    rawDb(first).exec('PRAGMA user_version = 52')
    first.close()
    new ConversationStore(dir).close()
    assert.deepEqual(lines.filter((l) => l.startsWith('[db]')), [])

    const second = new ConversationStore(dir)
    rawDb(second).prepare(`INSERT INTO messages (rowid,id,conv_id,seq,role,content,stats,created_at) VALUES (250000,?,?,2,'user','x','{}',?)`).run(randomUUID(), conv.id, iso(0))
    rawDb(second).exec('PRAGMA user_version = 52')
    second.close()
    new ConversationStore(dir).close()
    assert.equal(lines.filter((l) => /^\[db\] indexing 250000 chat messages/.test(l)).length, 1, lines.join('\n'))
  } finally {
    console.log = log
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2.3 dashboards ────────────────────────────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`tokenUsageStats: 7d/30d/all answer from SQL aggregates, not every message (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ modelKey: 'model-a' })
    bulkMessages(store, conv.id, 3000, () => ({ stats: '{"promptTokens":10,"genTokens":5}', modelKey: 'model-a', createdAt: iso(90 * DAY) }))
    bulkMessages(store, conv.id, 3, (i) => ({ stats: i === 2 ? '{"promptTokens":"9","genTokens":1}' : '{"promptTokens":100,"genTokens":50}', modelKey: 'model-b', createdAt: iso(i * 1000) }))
    bulkMessages(store, conv.id, 1, () => ({ stats: 'garbage{', modelKey: 'model-b', createdAt: iso(5000) }))

    for (const range of ['7d', '30d', 'all'] as const) {
      const { result, rows, sqls } = observe(store, () => store.tokenUsageStats(range))
      assert.ok(rows < 400, `${range}: handed ${rows} rows to JS`)
      // The range's own reads seek the created_at index (the lifetime aggregate scans by design).
      assertNoScan(plansOf(store, sqls.filter((s) => s.includes('$since'))), ['messages'])
      assert.equal(result.lifetimeTotalTokens, 3000 * 15 + 2 * 150 + 1)
      if (range === 'all') {
        assert.equal(result.messages, 3004)
        assert.equal(result.totalTokens, 3000 * 15 + 2 * 150 + 1)
      } else {
        assert.equal(result.messages, 4)
        assert.equal(result.totalTokens, 2 * 150 + 1, 'string token counts and unparsable stats count as 0')
        assert.deepEqual(result.byModel.map((m) => [m.modelKey, m.totalTokens]), [['model-b', 301]])
      }
    }
  }))

  test(`apiUsageStats: the range is a WHERE clause and totals are SQL sums (${backend})`, () => withStore(backend, (store) => {
    for (let i = 0; i < 1500; i++) store.recordApiUsage({ source: 'openai', modelKey: 'm1', promptTokens: 10, genTokens: 0 })
    rawDb(store).prepare('UPDATE api_usage SET created_at = ?').run(iso(60 * DAY))
    store.recordApiUsage({ source: 'anthropic', modelKey: 'm2', promptTokens: 7, genTokens: 3 })

    const { result, rows, sqls } = observe(store, () => store.apiUsageStats('7d'))
    assert.ok(rows < 20, `handed ${rows} rows to JS`)
    assert.equal(result.requests, 1)
    assert.equal(result.totalTokens, 10)
    assert.equal(result.lifetimeTotalTokens, 15_010)
    assert.deepEqual(result.bySource, [{ source: 'anthropic', requests: 1, totalTokens: 10 }])
    const plan = plansOf(store, sqls.filter((s) => s.includes('$since')))
    assert.ok(plan.some((d) => /^SEARCH api_usage USING INDEX idx_api_usage_created/.test(d)), plan.join('\n'))
  }))

  test(`codeStats: a 7d range reads only that window's tool calls (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ kind: 'code', modelKey: 'cm' })
    const run = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/r' })
    const edit = (path: string) => JSON.stringify([{ id: '1', name: 'edit', args: { path }, result: 'ok', diff: '--- a\n+++ b\n@@\n-x\n+y' }])
    bulkMessages(store, conv.id, 800, (i) => ({ stats: '{}', modelKey: 'cm', createdAt: iso(40 * DAY), toolCalls: edit(`old${i}.ts`) }))
    bulkMessages(store, conv.id, 2, (i) => ({ stats: '{}', modelKey: 'cm', createdAt: iso(i * 1000), toolCalls: edit(`new${i}.ts`) }))
    setCreatedAt(store, 'agent_runs', run.id, iso(1000))

    const { result, rows, sqls } = observe(store, () => store.codeStats('7d'))
    assert.ok(rows < 50, `handed ${rows} rows to JS`)
    const plan = plansOf(store, sqls.filter((s) => s.includes('m.created_at >= $since')))
    assert.ok(plan.some((d) => /^SEARCH m USING INDEX idx_messages_created/.test(d)), plan.join('\n'))
    assert.equal(result.filesTouched, 2)
    assert.equal(result.diffAdded, 2)
    assert.equal(result.sessions, 1)
  }))
}

// ── 2.6 conversation and agent-run lists ──────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`listConversationsPage: keyset pages over (updated_at, id), slim rows (${backend})`, () => withStore(backend, (store) => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(store.createConversation({ title: `c${i}` }).id)
    rawDb(store).prepare('UPDATE conversations SET updated_at = ?').run(iso(0)) // all tied: the id breaks the tie
    store.setConversationCompaction(ids[0], { summary: 'a long summary', upToMessageId: 'x', tokensBefore: 1 })
    rawDb(store).prepare('UPDATE conversations SET updated_at = ?').run(iso(0))
    store.createConversation({ kind: 'agent' })

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const p = store.listConversationsPage('chat', { limit: 2, cursor })
      seen.push(...p.conversations.map((c) => c.id))
      for (const c of p.conversations) assert.equal(c.compactionSummary, undefined, 'list rows leave the summary out')
      if (!p.nextCursor) break
      cursor = p.nextCursor
    }
    assert.deepEqual(seen, [...ids].sort().reverse())
    assert.equal(store.listConversations(undefined, 'chat').length, 5, 'the unpaged call still returns up to 200')
    assert.throws(() => store.listConversationsPage('chat', { cursor: 'nope' }), /invalid_cursor/)

    const plan = plansOf(store, observe(store, () => store.listConversationsPage('chat', { limit: 2, cursor })).sqls)
    assertNoScan(plan, ['conversations'])
    assert.ok(!plan.some((d) => d.includes('TEMP B-TREE')), plan.join('\n'))
  }))

  test(`listAgentRunsPage: keyset pages, status filter kept, slim rows (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ kind: 'code' })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(store.createAgentRun({ convId: conv.id, title: `r${i}`, allowedTools: [], repoRoot: '/r' }).id)
    store.updateAgentRun(ids[1], { status: 'running', compactionSummary: 'big' })
    rawDb(store).prepare('UPDATE agent_runs SET updated_at = ?').run(iso(0))

    const first = store.listAgentRunsPage({ limit: 3 })
    const second = store.listAgentRunsPage({ limit: 3, cursor: first.nextCursor! })
    assert.deepEqual([...first.runs, ...second.runs].map((r) => r.id), [...ids].sort().reverse())
    assert.equal(second.nextCursor, null)
    assert.ok([...first.runs, ...second.runs].every((r) => r.compactionSummary === undefined))
    assert.deepEqual(store.listAgentRunsPage({ statuses: ['running'] }).runs.map((r) => r.id), [ids[1]])
    assert.equal(store.listAgentRuns().length, 5)
    // No filter: an index walk in (updated_at, id) order that LIMIT stops early, never a sort of the table.
    const plan = plansOf(store, observe(store, () => store.listAgentRunsPage({ limit: 3, cursor: first.nextCursor! })).sqls)
    assert.ok(plan.some((d) => d.includes('idx_agent_runs_updated')) && !plan.some((d) => d.includes('TEMP B-TREE')), plan.join('\n'))
  }))
}

test('GET /api/v1/conversations pages with ?limit and ?cursor, and adds nextCursor beside the same list', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const log = console.log
  console.log = () => {}
  try {
    for (let i = 0; i < 3; i++) store.createConversation({ title: `c${i}` })
    const app = new Hono()
    registerChatRoutes(app, { db: store, store: { snapshot: () => ({}), read: () => ({}), dir: () => IN_MEMORY_DATA_DIR } } as unknown as Deps)
    const all = await (await app.request('/api/v1/conversations')).json() as { conversations: unknown[]; nextCursor: string | null }
    assert.equal(all.conversations.length, 3)
    assert.equal(all.nextCursor, null)
    const p1 = await (await app.request('/api/v1/conversations?limit=2')).json() as { conversations: Array<{ id: string; running: boolean }>; nextCursor: string }
    assert.equal(p1.conversations.length, 2)
    assert.equal(p1.conversations[0].running, false)
    const p2 = await (await app.request(`/api/v1/conversations?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json() as { conversations: unknown[]; nextCursor: string | null }
    assert.equal(p2.conversations.length, 1)
    assert.equal(p2.nextCursor, null)
    assert.equal((await app.request('/api/v1/conversations?cursor=garbage')).status, 400)
  } finally {
    console.log = log
    store.close()
  }
})

// ── 2.9 code-session history after a marker ───────────────────────────────────────

for (const backend of BACKENDS) {
  test(`getActiveMessagesAfter: only the active rows after an active marker, null for an unusable marker (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ kind: 'code' })
    store.addMessage(conv.id, 'user', 'old')
    const marker = store.addMessage(conv.id, 'assistant', 'old reply')
    const after1 = store.addMessage(conv.id, 'user', 'new')
    const gone = store.addMessage(conv.id, 'assistant', 'regenerated away')
    store.deactivateMessage(gone.id)
    const after2 = store.addMessage(conv.id, 'assistant', 'new reply')

    assert.deepEqual(store.getActiveMessagesAfter(conv.id, marker.id)!.map((m) => m.id), [after1.id, after2.id])
    assert.equal(store.getActiveMessagesAfter(conv.id, 'missing'), null)
    assert.equal(store.getActiveMessagesAfter(conv.id, gone.id), null, 'an inactive marker is not found, as before')
    assert.equal(store.getActiveMessagesAfter(store.createConversation().id, marker.id), null, 'another conversation\'s marker')
  }))
}

// ── 2.10 memory ───────────────────────────────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`memory facts: keyset pages newest first, and a bounded recent window for dedupe (${backend})`, () => withStore(backend, (store) => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(store.addMemoryFact({ factText: `fact ${i}` }).id)
    rawDb(store).prepare('UPDATE memory_facts SET created_at = ?').run(iso(0))
    const p1 = store.listMemoryFactsPage({ limit: 3 })
    const p2 = store.listMemoryFactsPage({ limit: 3, cursor: p1.nextCursor! })
    assert.deepEqual([...p1.facts, ...p2.facts].map((f) => f.id), [...ids].sort().reverse())
    assert.equal(p2.nextCursor, null)
    assert.equal(store.recentMemoryFactTexts(2).length, 2)
    assert.equal(store.listMemoryFacts().length, 5)
  }))
}

test('GET /api/v1/memory pages with ?limit and ?cursor and keeps the facts array', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  const log = console.log
  console.log = () => {}
  try {
    for (let i = 0; i < 3; i++) store.addMemoryFact({ factText: `fact ${i}` })
    const app = new Hono()
    registerChatRoutes(app, { db: store, store: { snapshot: () => ({}), read: () => ({}), dir: () => IN_MEMORY_DATA_DIR } } as unknown as Deps)
    const all = await (await app.request('/api/v1/memory')).json() as { facts: unknown[]; nextCursor: string | null }
    assert.equal(all.facts.length, 3)
    assert.equal(all.nextCursor, null)
    const p1 = await (await app.request('/api/v1/memory?limit=2')).json() as { facts: unknown[]; nextCursor: string }
    assert.equal(p1.facts.length, 2)
    const p2 = await (await app.request(`/api/v1/memory?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json() as { facts: unknown[] }
    assert.equal(p2.facts.length, 1)
    assert.equal((await app.request('/api/v1/memory?cursor=garbage')).status, 400)
  } finally {
    console.log = log
    store.close()
  }
})

// ── 2.2 chat search ───────────────────────────────────────────────────────────────

/** Runs `fn` with a data directory on `backend`, so a test can open, close and reopen a store
 *  over the same database file. */
async function withDataDir(backend: Backend, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const actual = process.platform
  if (backend === 'sql.js') Object.defineProperty(process, 'platform', { value: 'android' })
  const dir = tmpDir('tllm-scale-dir-')
  try {
    await preloadSqlJs()
    await fn(dir)
  } finally {
    Object.defineProperty(process, 'platform', { value: actual })
    rmSync(dir, { recursive: true, force: true })
  }
}

function hasFts5(store: ConversationStore): boolean {
  return (rawDb(store).prepare(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS yes`).get() as { yes: number }).yes === 1
}

function schemaObject(db: SqlDb, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name)
}

const searchIds = (store: ConversationStore, q: string, kind: 'chat' | 'agent' | 'all' = 'all') =>
  store.listConversations(q, kind).map((c) => c.id)

test('FTS5 probe: node:sqlite has it and indexes messages; the bundled sql.js has no FTS5', () => withStore('node:sqlite', async (store) => {
  assert.equal(hasFts5(store), true)
  assert.ok(schemaObject(rawDb(store), 'messages_fts') && schemaObject(rawDb(store), 'conversations_fts'))
  await withStore('sql.js', (android) => {
    assert.equal(hasFts5(android), false, 'sql.js gained FTS5: drop its LIKE fallback in searchConversations')
    assert.ok(!schemaObject(rawDb(android), 'messages_fts'), 'no index where the module is missing')
  })
}))

for (const backend of BACKENDS) {
  test(`listConversations(q): matches titles and message text as a substring, newest first, kind kept (${backend})`, () => withStore(backend, (store) => {
    const byTitle = store.createConversation({ title: 'Quarterly Budget review' })
    const byText = store.createConversation({ title: 'untitled' })
    store.addMessage(byText.id, 'user', 'Please draft the budget for Q3')
    const agent = store.createConversation({ title: 'budget agent', kind: 'agent' })
    store.createConversation({ title: 'nothing relevant' })
    rawDb(store).prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(iso(0), byTitle.id)
    rawDb(store).prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(iso(DAY), byText.id)
    rawDb(store).prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(iso(2 * DAY), agent.id)

    assert.deepEqual(searchIds(store, 'budg'), [byTitle.id, byText.id, agent.id], 'a prefix, any case, newest first')
    assert.deepEqual(searchIds(store, 'BUDGET', 'chat'), [byTitle.id, byText.id])
    assert.deepEqual(searchIds(store, 'budget', 'agent'), [agent.id])
    assert.deepEqual(searchIds(store, 'draft the'), [byText.id], 'several words')
    const hit = store.listConversations('quarterly')[0]
    assert.deepEqual(hit, store.getConversation(byTitle.id), 'the same Conversation shape as before')
    assert.equal(store.listConversations('   ').length, 4, 'a blank query is no search')
  }))

  test(`listConversations(q): the index follows edits, deletes and renames (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ title: 'plain' })
    const msg = store.addMessage(conv.id, 'assistant', 'first draft')
    assert.deepEqual(searchIds(store, 'draft'), [conv.id])
    store.updateMessage(msg.id, { content: 'rewritten reply' })
    assert.deepEqual(searchIds(store, 'draft'), [], 'old text is gone after a partial or final save')
    assert.deepEqual(searchIds(store, 'rewritten'), [conv.id])
    store.updateMessage(msg.id, { stats: { tps: 1 } as never })
    assert.deepEqual(searchIds(store, 'rewritten'), [conv.id], 'a save that leaves content alone keeps it findable')
    store.updateConversation(conv.id, { title: 'Renamed topic' })
    assert.deepEqual(searchIds(store, 'plain'), [])
    assert.deepEqual(searchIds(store, 'renamed'), [conv.id])
    store.deleteMessage(msg.id)
    assert.deepEqual(searchIds(store, 'rewritten'), [])
    const other = store.createConversation({ title: 'gone soon' })
    store.addMessage(other.id, 'user', 'cascade target')
    store.deleteConversation(other.id)
    assert.deepEqual(searchIds(store, 'cascade'), [])
    assert.deepEqual(searchIds(store, 'gone'), [])
  }))

  test(`listConversations(q): query syntax is literal text, never an error (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation({ title: 'syntax' })
    store.addMessage(conv.id, 'user', 'say "hi" AND NEAR(x) col:val -minus a*b')
    for (const q of ['"', '"hi', 'AND', 'NEAR(', 'col:val', '-minus', '*', 'a*b', '(', ')', '^', '\\', '%', '_', "'"]) {
      assert.doesNotThrow(() => store.listConversations(q), `query ${q}`)
    }
    assert.deepEqual(searchIds(store, '"hi"'), [conv.id])
    assert.deepEqual(searchIds(store, 'col:val'), [conv.id])
  }))
}

for (const backend of BACKENDS) {
  test(`listConversations(q): % and _ are literal and a query matches mid-word (${backend})`, () => withStore(backend, (store) => {
    const pct = store.createConversation({ title: 'growth 50% yoy' })
    const under = store.createConversation({ title: 'snake_case name' })
    store.createConversation({ title: 'growth 500 yoy' })
    store.createConversation({ title: 'snakeXcase name' })
    assert.deepEqual(searchIds(store, '50%'), [pct.id])
    assert.deepEqual(searchIds(store, 'e_c'), [under.id])
    assert.equal(searchIds(store, 'rowth').length, 2, 'a substring mid-word, as before')
    assert.deepEqual(searchIds(store, 'th 50%'), [pct.id], 'the whole query is one substring, spaces included')
  }))
}

/** The conversations the old LIKE search found for `q`: title or any message, ASCII case-insensitive substring. */
function likeSearchIds(store: ConversationStore, q: string): string[] {
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`
  return (rawDb(store).prepare(`
    SELECT c.id FROM conversations c
    WHERE c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conv_id = c.id AND m.content LIKE ? ESCAPE '\\')
    ORDER BY c.updated_at DESC
  `).all(pattern, pattern) as Array<{ id: string }>).map((r) => r.id)
}

test('listConversations(q) on node:sqlite: the trigram index finds exactly what the LIKE substring search found', () => withStore('node:sqlite', (store) => {
  assert.equal(store.searchIndexReady, true, 'a fresh database has nothing to backfill')
  const texts = [
    'Testing the loader', 'a big LLM answer', 'llm lowercase', '你好世界和平', '世界', 'written in c++ today', 'c+ only',
    'growth 50% yoy', 'growth 500 yoy', 'tag #hash here', 'end. of sentence', 'Mixed CaSe Words', 'say "hi" now', 'snake_case',
  ]
  for (const [i, text] of texts.entries()) {
    const conv = store.createConversation({ title: i % 2 ? `title ${i}` : text })
    store.addMessage(conv.id, 'user', i % 2 ? text : 'nothing')
    rawDb(store).prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(iso(i * 1000), conv.id)
  }
  const queries = ['ing', 'LLM', 'llm', '世界', '世界和', 'c++', '50%', '#', '#ha', '.', 'd. o', 'mixed case', 'MIXED', 'ca', '"hi"', 'e_c', 'xyz', 'th 50']
  for (const q of queries) {
    const expected = likeSearchIds(store, q)
    assert.deepEqual(searchIds(store, q), expected, `query ${JSON.stringify(q)}`)
  }
  assert.ok(likeSearchIds(store, 'ing').length > 0 && likeSearchIds(store, '世界').length === 2, 'the data exercises the queries')
  const plan = plansOf(store, observe(store, () => store.listConversations('LLM')).sqls)
  assert.ok(plan.some((d) => d.includes('messages_fts')), `three characters or more read the index:\n${plan.join('\n')}`)
}))

test('listConversations(q) on node:sqlite: 20k messages, search reads the FTS index, never SCAN messages', () => withStore('node:sqlite', (store) => {
  const bulk = store.createConversation({ title: 'bulk' })
  bulkMessages(store, bulk.id, 20_000, () => ({ stats: '{}', modelKey: null, createdAt: iso(DAY) }))
  const target = store.createConversation({ title: 'needle home' })
  store.addMessage(target.id, 'user', 'the zanzibar clue')

  const { result, rows, sqls } = observe(store, () => store.listConversations('zanzib', 'chat'))
  assert.deepEqual(result.map((c) => c.id), [target.id])
  assert.ok(rows <= 1, `rows handed to JS: ${rows}`)
  const plan = plansOf(store, sqls)
  assertNoScan(plan, ['messages'])
  assert.ok(plan.some((d) => /VIRTUAL TABLE INDEX/.test(d) && d.includes('messages_fts')), plan.join('\n'))
}))

const SEARCH_INDEX_OBJECTS = [
  'messages_fts', 'conversations_fts', 'search_index_backfill',
  'messages_fts_insert', 'messages_fts_delete', 'messages_fts_update',
  'conversations_fts_insert', 'conversations_fts_delete', 'conversations_fts_update',
]

/** Turns a migrated file database back into one at v53, before any search index existed. */
function downgradeToV53(dir: string): void {
  const db = openSqlDb(join(dir, 'turbollm.db'))
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_insert; DROP TRIGGER IF EXISTS messages_fts_delete; DROP TRIGGER IF EXISTS messages_fts_update;
      DROP TRIGGER IF EXISTS conversations_fts_insert; DROP TRIGGER IF EXISTS conversations_fts_delete; DROP TRIGGER IF EXISTS conversations_fts_update;
      DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS conversations_fts; DROP TABLE IF EXISTS search_index_backfill;
      DROP TABLE IF EXISTS api_usage_daily; DROP INDEX IF EXISTS idx_api_usage_code_session_ctx;
      PRAGMA user_version = 53;
    `)
  } finally { db.close() }
}

/** FTS5's own check that each index holds exactly its content table's rows (no row missing or twice). */
function assertSearchIndexIntact(store: ConversationStore): void {
  rawDb(store).exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)`)
  rawDb(store).exec(`INSERT INTO conversations_fts(conversations_fts, rank) VALUES ('integrity-check', 1)`)
}

const indexedHits = (store: ConversationStore, word: string) =>
  (rawDb(store).prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).get(`"${word}"`) as { n: number }).n

const quietBackfill = (store: ConversationStore, batchRows = 5000) => new SearchIndexBackfill({ db: store, log: () => {}, batchRows })

test('opening a v53 database with 20k messages does not index them on the spot; the background backfill does', () => withDataDir('node:sqlite', async (dir) => {
  const first = new ConversationStore(dir)
  const bulk = first.createConversation({ title: 'bulk' })
  bulkMessages(first, bulk.id, 20_000, () => ({ stats: '{}', modelKey: null, createdAt: iso(DAY) }))
  const target = first.createConversation({ title: 'needle home' })
  first.addMessage(target.id, 'user', 'the zanzibar clue')
  first.close()
  downgradeToV53(dir)

  const store = new ConversationStore(dir)
  try {
    for (const name of SEARCH_INDEX_OBJECTS) assert.ok(schemaObject(rawDb(store), name), `${name} created by the migration`)
    assert.equal(store.searchIndexReady, false)
    assert.equal(indexedHits(store, 'zanzibar'), 0, 'no existing row was tokenized while opening')
    assert.deepEqual(searchIds(store, 'zanzib'), [target.id], 'search still answers, on LIKE, until the backfill is done')

    const batches = await quietBackfill(store).run()
    assert.ok(batches >= 4, `indexed in batches, got ${batches}`)
    assert.equal(store.searchIndexReady, true)
    assert.equal(indexedHits(store, 'zanzibar'), 1)
    const { result, sqls } = observe(store, () => store.listConversations('zanzib'))
    assert.deepEqual(result.map((c) => c.id), [target.id])
    assert.ok(plansOf(store, sqls).some((d) => d.includes('messages_fts')))
    assertSearchIndexIntact(store)
  } finally { store.close() }

  const reopened = new ConversationStore(dir)
  try {
    assert.equal(reopened.searchIndexReady, true, 'the finished backfill is remembered')
  } finally { reopened.close() }
}))

test('writes during the backfill, a reused rowid included, leave each row indexed exactly once', () => withDataDir('node:sqlite', async (dir) => {
  const first = new ConversationStore(dir)
  const conv = first.createConversation({ title: 'old title' })
  const msgs = Array.from({ length: 30 }, (_, i) => first.addMessage(conv.id, 'user', `old message ${i}`))
  first.close()
  downgradeToV53(dir)

  const store = new ConversationStore(dir)
  try {
    const job = quietBackfill(store, 10)
    assert.equal(store.backfillSearchIndex(10), true, 'one batch done, more to go')
    store.updateMessage(msgs[2].id, { content: 'edited already indexed' })
    store.updateMessage(msgs[25].id, { content: 'edited still pending' })
    store.deleteMessage(msgs[3].id)
    store.deleteMessage(msgs[29].id) // the newest row: the next insert may take its rowid, inside the pending range
    const reused = store.addMessage(conv.id, 'user', 'fresh while pending')
    store.updateConversation(conv.id, { title: 'renamed while pending' })
    await job.run()

    assert.equal(store.searchIndexReady, true)
    assertSearchIndexIntact(store)
    assert.deepEqual(searchIds(store, 'edited already'), [conv.id])
    assert.deepEqual(searchIds(store, 'edited still'), [conv.id])
    assert.deepEqual(searchIds(store, 'fresh while'), [conv.id])
    assert.deepEqual(searchIds(store, 'renamed while'), [conv.id])
    assert.deepEqual(searchIds(store, 'old title'), [])
    assert.equal(indexedHits(store, 'old message 3'), 0)
    assert.ok(store.getMessage(reused.id))
  } finally { store.close() }
}))

/** Runs `fn` as if on Android, where the bundled sql.js has no FTS5. */
async function asAndroid<T>(fn: () => T | Promise<T>): Promise<T> {
  const actual = process.platform
  Object.defineProperty(process, 'platform', { value: 'android' })
  try {
    await preloadSqlJs()
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: actual })
  }
}

test('a runtime without FTS5 opening an indexed database keeps writing; one with FTS5 rebuilds the index after', () => withDataDir('node:sqlite', async (dir) => {
  const desktop = new ConversationStore(dir)
  const conv = desktop.createConversation({ title: 'shared' })
  desktop.addMessage(conv.id, 'user', 'written on desktop')
  desktop.close()

  await asAndroid(() => {
    const android = new ConversationStore(dir)
    try {
      assert.equal(android.searchIndexReady, false)
      android.addMessage(conv.id, 'user', 'written without fts5')
      android.updateConversation(conv.id, { title: 'renamed without fts5' })
      android.deleteMessage(android.getMessages(conv.id)[0].id)
      assert.deepEqual(searchIds(android, 'without fts5'), [conv.id])
    } finally { android.close() }
  })

  const back = new ConversationStore(dir)
  try {
    for (const name of SEARCH_INDEX_OBJECTS) assert.ok(schemaObject(rawDb(back), name), `${name} restored`)
    await quietBackfill(back).run()
    assert.equal(back.searchIndexReady, true)
    assertSearchIndexIntact(back)
    assert.deepEqual(searchIds(back, 'written without'), [conv.id])
    assert.deepEqual(searchIds(back, 'renamed without'), [conv.id])
    assert.deepEqual(searchIds(back, 'on desktop'), [])
  } finally { back.close() }
}))

// ── 2.11 transactional migrations ─────────────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`migrations: a step that fails midway leaves the version and schema as they were, and the next open retries it (${backend})`, () => withDataDir(backend, (dir) => {
    new ConversationStore(dir).close()
    const raw = () => openSqlDb(join(dir, 'turbollm.db'))
    const latest = (() => { const d = raw(); try { return userVersion(d) } finally { d.close() } })()

    const prep = raw()
    prep.exec(`
      DROP INDEX idx_messages_created; DROP INDEX idx_memory_facts_created_id;
      CREATE TABLE idx_memory_facts_created_id (x);
      PRAGMA user_version = 52;
    `)
    prep.close()

    assert.throws(() => new ConversationStore(dir), /already a table named idx_memory_facts_created_id/)
    const after = raw()
    assert.equal(userVersion(after), 52, 'the version is not bumped')
    assert.equal(schemaObject(after, 'idx_messages_created'), false, 'the step\'s earlier statements were rolled back')
    after.exec('DROP TABLE idx_memory_facts_created_id')
    after.close()

    new ConversationStore(dir).close()
    const healed = raw()
    try {
      assert.equal(userVersion(healed), latest)
      assert.ok(schemaObject(healed, 'idx_messages_created') && schemaObject(healed, 'idx_memory_facts_created_id'))
    } finally { healed.close() }
  }))
}

function userVersion(db: SqlDb): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

// ── 2.4 retention ─────────────────────────────────────────────────────────────────

/** One gateway request row, written straight to the table at `at` (recordApiUsage stamps "now"). */
function apiRow(store: ConversationStore, at: string, row: { source?: string; model?: string | null; harness?: string | null; prompt?: number; gen?: number; session?: string | null; ctx?: number } = {}): string {
  const id = randomUUID()
  rawDb(store).prepare(`INSERT INTO api_usage (id, created_at, source, model_key, prompt_tokens, gen_tokens, harness, code_session_id, ctx_used) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, at, row.source ?? 'openai', row.model === undefined ? 'm1' : row.model, row.prompt ?? 10, row.gen ?? 5, row.harness ?? null, row.session ?? null, row.ctx ?? row.prompt ?? 10)
  return id
}

/** Local midnight `days` calendar days before today, as the retention sweep computes its cutoff. */
function localMidnightDaysAgo(days: number): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)
}

const localDayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Rolls up every raw row older than `before`, a batch of `limit` at a time; the batch count. */
function rollUpAll(store: ConversationStore, before: string, limit = 500): number {
  let batches = 0
  let cursor: Parameters<ConversationStore['rollUpApiUsageBatch']>[2] = null
  do {
    batches++
    cursor = store.rollUpApiUsageBatch(before, limit, cursor).next
  } while (cursor)
  return batches
}

const rawCount = (store: ConversationStore, where = '1') => (rawDb(store).prepare(`SELECT COUNT(*) AS n FROM api_usage WHERE ${where}`).get() as { n: number }).n

for (const backend of BACKENDS) {
  test(`migration 55 adds api_usage_daily and the per-session ctx index (${backend})`, () => withStore(backend, (store) => {
    const db = rawDb(store)
    for (const name of ['api_usage_daily', 'idx_api_usage_code_session_ctx']) assert.ok(schemaObject(db, name), name)
  }))

  test(`api_usage roll-up: every dashboard and daily stat answers the same after old rows fold into daily totals (${backend})`, () => withStore(backend, (store) => {
    const at = (daysAgo: number, hour: number) => new Date(localMidnightDaysAgo(daysAgo).getTime() + hour * 3_600_000).toISOString()
    // Out of date order on purpose: first-appearance order (bySource) must survive the fold.
    const seeds: Array<[number, Parameters<typeof apiRow>[2]]> = [
      [120, { source: 'anthropic', model: 'm2', harness: 'claude-code', prompt: 100, gen: 40 }],
      [200, { source: 'openai', model: 'm1', prompt: 7, gen: 3 }],
      [200, { source: 'openai', model: null, prompt: 1, gen: 1 }],
      [95, { source: 'openai', model: 'm1', harness: 'codex', prompt: 50, gen: 50 }],
      [95, { source: 'anthropic', model: 'm2', harness: 'claude-code', prompt: 9, gen: 1 }],
      [91, { source: 'compact', model: null, prompt: 300, gen: 0 }],
      [60, { source: 'openai', model: 'm3', prompt: 20, gen: 2 }],
      [20, { source: 'anthropic', model: 'm2', prompt: 4, gen: 4 }],
      [3, { source: 'openai', model: 'm1', harness: 'codex', prompt: 11, gen: 1 }],
      [0, { source: 'openai', model: 'm1', prompt: 2, gen: 2 }],
    ]
    for (let rep = 0; rep < 30; rep++) for (const [daysAgo, row] of seeds) apiRow(store, at(daysAgo, daysAgo === 0 ? 0 : rep % 20), row)
    const days = [200, 120, 95, 91, 60, 20, 3, 0].map((n) => localDayKey(localMidnightDaysAgo(n)))
    const snapshot = () => ({
      all: store.apiUsageStats('all'), d30: store.apiUsageStats('30d'), d7: store.apiUsageStats('7d'),
      daily: days.map((d) => store.gatewayDailyStats(d)),
    })
    const before = snapshot()
    assert.equal(before.all.requests, 300)
    assert.equal(before.all.bySource.length, 3)

    const cutoff = localMidnightDaysAgo(90).toISOString()
    rollUpAll(store, cutoff, 37)

    assert.equal(rawCount(store, `created_at < '${cutoff}'`), 0, 'no raw row older than the cutoff is left')
    assert.equal(rawCount(store), 120, 'every newer row is still raw')
    assert.ok((rawDb(store).prepare('SELECT COUNT(*) AS n FROM api_usage_daily').get() as { n: number }).n <= 6, 'one row per day and group')
    assert.deepEqual(snapshot(), before)
  }))

  test(`api_usage roll-up: the cutoff is exclusive, and a second pass adds nothing (${backend})`, () => withStore(backend, (store) => {
    const cutoff = localMidnightDaysAgo(90)
    apiRow(store, new Date(cutoff.getTime() - 1).toISOString())
    const atCutoff = apiRow(store, cutoff.toISOString())
    const totals = store.apiUsageStats('all')
    rollUpAll(store, cutoff.toISOString())
    rollUpAll(store, cutoff.toISOString())
    const left = (rawDb(store).prepare('SELECT id FROM api_usage').all() as Array<{ id: string }>).map((r) => r.id)
    assert.deepEqual(left, [atCutoff])
    assert.deepEqual(store.apiUsageStats('all'), totals)
  }))

  test(`api_usage roll-up: a Code session keeps the rows its gauges read (latest and peak), the rest fold (${backend})`, () => withStore(backend, (store) => {
    const old = (n: number) => new Date(localMidnightDaysAgo(200).getTime() + n * 60_000).toISOString()
    apiRow(store, old(1), { session: 's1', prompt: 500, ctx: 500 })
    apiRow(store, old(2), { session: 's1', prompt: 9000, ctx: 9000 })
    for (let i = 3; i < 50; i++) apiRow(store, old(i), { session: 's1', prompt: 100 + i, ctx: 100 + i })
    apiRow(store, old(60), { session: 's1', prompt: 42, gen: 7, ctx: 42 })
    const gauge = store.getLastApiUsageForSession('s1')
    const totals = store.apiUsageStats('all')

    rollUpAll(store, localMidnightDaysAgo(90).toISOString(), 10)

    assert.equal(rawCount(store, `code_session_id = 's1'`), 2, 'the latest and the peak row stay raw')
    assert.deepEqual(store.getLastApiUsageForSession('s1'), gauge)
    assert.deepEqual(store.apiUsageStats('all'), totals)
  }))

  test(`api_usage roll-up: rows tied on created_at — the gauge and the roll-up agree on the newest, by rowid (${backend})`, () => withStore(backend, (store) => {
    const old = localMidnightDaysAgo(200).toISOString()
    apiRow(store, old, { session: 's1', prompt: 900, gen: 1, ctx: 900 })
    for (let i = 0; i < 20; i++) apiRow(store, old, { session: 's1', prompt: 100 - i, gen: 2 + i, ctx: 100 - i }) // newest has the least context
    const gauge = store.getLastApiUsageForSession('s1')!
    assert.equal(gauge.genTokens, 21, 'the newest row of a tie is the last inserted')

    rollUpAll(store, localMidnightDaysAgo(90).toISOString(), 7)

    assert.equal(rawCount(store, `code_session_id = 's1'`), 2)
    assert.deepEqual(store.getLastApiUsageForSession('s1'), gauge)
  }))

  test(`api_usage roll-up: batches of the given size, each its own transaction (${backend})`, () => withStore(backend, (store) => {
    const old = localMidnightDaysAgo(100).toISOString()
    for (let i = 0; i < 1200; i++) apiRow(store, old)
    assert.equal(rollUpAll(store, localMidnightDaysAgo(90).toISOString(), 500), 3)
    assert.equal(rawCount(store), 0)
    assert.equal(store.apiUsageStats('all').requests, 1200)
  }))
}

/** A routine with `n` finished runs a second apart, oldest first, each ending half a second after it started. */
function routineWithRuns(store: ConversationStore, flavor: 'chat' | 'code', n: number, startMs: number): { routineId: string; runIds: string[] } {
  const routine = store.createRoutine({ flavor, prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm' })
  const runIds: string[] = []
  for (let i = 0; i < n; i++) {
    const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: '{}' })
    const startedAt = startMs + i * 1000
    rawDb(store).prepare('UPDATE routine_runs SET started_at = ?, ended_at = ?, status = ? WHERE id = ?')
      .run(new Date(startedAt).toISOString(), new Date(startedAt + 500).toISOString(), 'ok', run.id)
    runIds.push(run.id)
  }
  return { routineId: routine.id, runIds }
}

/** A message in `convId` written at `at` (ms), as a run or the user wrote it then. */
function messageAt(store: ConversationStore, convId: string, role: 'user' | 'assistant', at: number): void {
  const message = store.addMessage(convId, role, `${role} at ${at}`)
  rawDb(store).prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(at).toISOString(), message.id)
}

/** The run's own chat: its prompt and its reply, both written while it ran. */
function runChat(store: ConversationStore, runId: string): { convId: string; endedAt: number } {
  const run = store.getRoutineRun(runId)!
  const conv = store.createConversation({ kind: 'agent', modelKey: 'm' })
  messageAt(store, conv.id, 'user', Date.parse(run.startedAt))
  messageAt(store, conv.id, 'assistant', Date.parse(run.startedAt) + 100)
  store.updateRoutineRun(runId, { conversationId: conv.id })
  return { convId: conv.id, endedAt: Date.parse(run.endedAt!) }
}

/** The run's own Code session: its prompt and its reply, both written while it ran. */
function runCodeSession(store: ConversationStore, runId: string): { convId: string; sessionId: string; endedAt: number } {
  const run = store.getRoutineRun(runId)!
  const conv = store.createConversation({ kind: 'code', modelKey: 'm' })
  const session = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/r' })
  messageAt(store, conv.id, 'user', Date.parse(run.startedAt))
  messageAt(store, conv.id, 'assistant', Date.parse(run.startedAt) + 100)
  store.updateRoutineRun(runId, { codeSessionId: session.id })
  return { convId: conv.id, sessionId: session.id, endedAt: Date.parse(run.endedAt!) }
}

const messageCount = (store: ConversationStore, convId: string) =>
  (rawDb(store).prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(convId) as { n: number }).n

for (const backend of BACKENDS) {
  test(`routineRunsBeyondNewest: only runs past the newest N, oldest first, never one still running or parked (${backend})`, () => withStore(backend, (store) => {
    const a = routineWithRuns(store, 'chat', 210, Date.now() - 1e9)
    const b = routineWithRuns(store, 'chat', 5, Date.now() - 2e9)
    store.updateRoutineRun(a.runIds[0], { status: 'running' })
    store.updateRoutineRun(a.runIds[1], { status: 'needs_approval' })

    const page1 = store.routineRunsBeyondNewest(a.routineId, 200, 4)
    assert.deepEqual(page1.map((r) => r.id), a.runIds.slice(2, 6))
    const page2 = store.routineRunsBeyondNewest(a.routineId, 200, 100, page1[page1.length - 1])
    assert.deepEqual(page2.map((r) => r.id), a.runIds.slice(6, 10))
    assert.deepEqual(store.routineRunsBeyondNewest(b.routineId, 200, 100), [])
    assert.deepEqual(store.routineRunsBeyondNewest(b.routineId, 3, 100).map((r) => r.id), b.runIds.slice(0, 2))
  }))

  test(`deleteRoutineRuns: deletes the runs and each one's own agent conversation, never another kind (${backend})`, () => withStore(backend, (store) => {
    const { routineId, runIds } = routineWithRuns(store, 'chat', 3, Date.now() - 1e6)
    const own = store.createConversation({ kind: 'agent', modelKey: 'm' })
    messageAt(store, own.id, 'user', Date.parse(store.getRoutineRun(runIds[0])!.startedAt))
    const userChat = store.createConversation({ kind: 'chat', modelKey: 'm' })
    store.updateRoutineRun(runIds[0], { conversationId: own.id })
    store.updateRoutineRun(runIds[1], { conversationId: userChat.id })
    const otherAgentConv = store.createConversation({ kind: 'agent', modelKey: 'm' })

    const runs = store.routineRunsBeyondNewest(routineId, 1, 10)
    assert.deepEqual(store.deleteRoutineRuns(runs), { runs: 2, conversations: 1 })
    assert.equal(store.getRoutineRun(runIds[0]), null)
    assert.equal(store.getRoutineRun(runIds[1]), null)
    assert.ok(store.getRoutineRun(runIds[2]))
    assert.equal(store.getConversation(own.id), null)
    assert.equal(messageCount(store, own.id), 0)
    assert.ok(store.getConversation(userChat.id), 'a conversation that is not a routine run\'s own is never deleted')
    assert.ok(store.getConversation(otherAgentConv.id))
  }))

  test(`routineRunsBeyondNewest: a chat run the user went on with after it ended is kept, and still counts toward the newest N (${backend})`, () => withStore(backend, (store) => {
    const { routineId, runIds } = routineWithRuns(store, 'chat', 8, Date.now() - 1e9)
    const [followedUp, regenerated, lateSave, untouched] = runIds.slice(0, 4).map((id) => runChat(store, id))
    messageAt(store, followedUp.convId, 'user', followedUp.endedAt + 1)
    messageAt(store, followedUp.convId, 'assistant', followedUp.endedAt + 2)
    messageAt(store, regenerated.convId, 'assistant', regenerated.endedAt + 5 * 60_000)
    messageAt(store, lateSave.convId, 'assistant', lateSave.endedAt + 10_000)

    const beyond = store.routineRunsBeyondNewest(routineId, 4, 100).map((r) => r.id)
    assert.deepEqual(beyond, [runIds[2], runIds[3]], 'a reply saved just after the run ended is still the run\'s own')
    assert.equal(untouched.convId, store.getRoutineRun(runIds[3])!.conversationId)
  }))

  test(`routineRunsBeyondNewest: a Code run whose session has a user turn after the run is kept (${backend})`, () => withStore(backend, (store) => {
    const { routineId, runIds } = routineWithRuns(store, 'code', 4, Date.now() - 1e9)
    const continued = runCodeSession(store, runIds[0])
    runCodeSession(store, runIds[1])
    messageAt(store, continued.convId, 'user', continued.endedAt + 1)
    assert.deepEqual(store.routineRunsBeyondNewest(routineId, 2, 100).map((r) => r.id), [runIds[1]])
  }))

  test(`deleteRoutineRuns: a run the user went on with since it was listed is not deleted (${backend})`, () => withStore(backend, (store) => {
    const { routineId, runIds } = routineWithRuns(store, 'chat', 3, Date.now() - 1e9)
    const continued = runChat(store, runIds[0])
    const untouched = runChat(store, runIds[1])
    const runs = store.routineRunsBeyondNewest(routineId, 1, 10)
    assert.equal(runs.length, 2)
    messageAt(store, continued.convId, 'user', Date.now())

    assert.deepEqual(store.deleteRoutineRuns(runs), { runs: 1, conversations: 1 })
    assert.ok(store.getRoutineRun(runIds[0]))
    assert.ok(store.getConversation(continued.convId))
    assert.equal(store.getConversation(untouched.convId), null)
  }))
}

// ── 2.7: images as files, and the conversation-open read ────────────────────────────────────────

for (const backend of BACKENDS) {
  test(`getMessagesForDisplay: the active messages as getMessages has them, without the documents' stored text (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation()
    store.addMessage(conv.id, 'user', 'summarize', { docContext: 'x'.repeat(100_000), textAttachments: ['big.txt'], attachments: ['attachment:abc'] })
    store.addMessage(conv.id, 'assistant', 'done')
    const full = store.getMessages(conv.id)
    const { result: shown, sqls } = observe(store, () => store.getMessagesForDisplay(conv.id))
    assert.equal(shown[0].docContext, undefined)
    assert.deepEqual(shown, full.map(({ docContext: _d, ...m }) => m))
    assert.ok(sqls.length > 0 && sqls.every((s) => !s.includes('*') && s.includes('NULL AS doc_context')), 'never reads the column')
  }))

  test(`messagesWithAttachment walks rowid windows and finds the rows naming the needle (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation()
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      ids.push(store.addMessage(conv.id, 'user', `m${i}`, { attachments: i % 3 === 0 ? ['data:image/png;base64,AAAA'] : [] }).id)
    }
    const found: string[] = []
    let after = 0
    let windows = 0
    for (;;) {
      const page = store.messagesWithAttachment('"data:image/', after, 5)
      found.push(...page.ids)
      windows++
      if (page.next === null) break
      after = page.next
    }
    assert.deepEqual(found, [ids[0], ids[3], ids[6], ids[9]])
    assert.equal(windows, 3)
    assert.deepEqual(store.messagesWithAttachment('"attachment:', 0, 100), { ids: [], next: null })
  }))

  test(`replaceMessageAttachments swaps a row's attachments only while they are still what was read (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation()
    const msg = store.addMessage(conv.id, 'user', 'look', { attachments: ['data:image/png;base64,AAAA'] })
    const before = store.messageAttachmentsJson(msg.id)!
    assert.equal(before, '["data:image/png;base64,AAAA"]')
    assert.equal(store.replaceMessageAttachments(msg.id, before, ['attachment:x']), true)
    assert.deepEqual(store.getMessage(msg.id)!.attachments, ['attachment:x'])
    assert.equal(store.replaceMessageAttachments(msg.id, before, ['attachment:y']), false, 'stale read')
    assert.deepEqual(store.getMessage(msg.id)!.attachments, ['attachment:x'])
    assert.equal(store.messageAttachmentsJson('nope'), null)
  }))

  test(`the attachment backfill touches only the app's own (local) rows, and bumps a rewritten row's version (${backend})`, () => withStore(backend, (store) => {
    const conv = store.createConversation()
    const local = store.addMessage(conv.id, 'user', 'look', { attachments: ['data:image/png;base64,AAAA'] })
    const extId = randomUUID()
    rawDb(store).prepare(`INSERT INTO messages (id,conv_id,seq,role,content,attachments,stats,created_at,tenant,owner) VALUES (?,?,99,'user','ext','["data:image/png;base64,BBBB"]','{}',?,'acme','bob')`)
      .run(extId, conv.id, iso(0))
    const version = (id: string) => (rawDb(store).prepare('SELECT version FROM messages WHERE id = ?').get(id) as { version: number }).version

    assert.deepEqual(store.messagesWithAttachment('"data:image/', 0, 100, 'local').ids, [local.id])
    assert.deepEqual(store.messagesWithAttachment('"data:image/', 0, 100).ids, [local.id, extId], 'no tenant: every row (the collection)')
    const extJson = store.messageAttachmentsJson(extId)!
    assert.equal(store.replaceMessageAttachments(extId, extJson, ['attachment:x']), false, 'an External Chat API row is never rewritten')
    assert.equal(store.messageAttachmentsJson(extId), extJson)
    const before = version(local.id)
    assert.equal(store.replaceMessageAttachments(local.id, store.messageAttachmentsJson(local.id)!, ['attachment:y']), true)
    assert.equal(version(local.id), before + 1)
  }))
}

test('a file-backed store keeps images in files; an in-memory one keeps them inline', () => {
  const dir = tmpDir('tllm-attach-enabled-')
  const onDisk = new ConversationStore(dir)
  const inMemory = new ConversationStore(IN_MEMORY_DATA_DIR)
  try {
    assert.equal(onDisk.attachments.enabled, true)
    assert.equal(inMemory.attachments.enabled, false)
  } finally {
    onDisk.close()
    inMemory.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
