// Scalability review 2.2: the background job that indexes the messages and titles written before chat search's
// full-text index existed, a batch per transaction, off the boot path. The index's own semantics are db.test.ts's.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConversationStore, IN_MEMORY_DATA_DIR } from './db'
import { SearchIndexBackfill } from './search-index-backfill'
import { openSqlDb } from './store/sqlite-adapter'
import { tmpDir } from '../test-support/tmp'

/** A file store whose messages predate the index: built, then its index dropped back to v53 and reopened. */
function storeWithUnindexedHistory(dir: string, messages: number): ConversationStore {
  const seed = new ConversationStore(dir)
  const conv = seed.createConversation({ title: 'history' })
  for (let i = 0; i < messages; i++) seed.addMessage(conv.id, 'user', `message ${i}`)
  seed.close()
  const raw = openSqlDb(join(dir, 'turbollm.db'))
  raw.exec(`
    DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update;
    DROP TRIGGER conversations_fts_insert; DROP TRIGGER conversations_fts_delete; DROP TRIGGER conversations_fts_update;
    DROP TABLE messages_fts; DROP TABLE conversations_fts; DROP TABLE search_index_backfill;
    PRAGMA user_version = 53;
  `)
  raw.close()
  return new ConversationStore(dir)
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = tmpDir('tllm-search-backfill-')
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('run indexes the pending rows a batch at a time and logs its start and end', () => withDir(async (dir) => {
  const store = storeWithUnindexedHistory(dir, 25)
  try {
    const lines: string[] = []
    const batches = await new SearchIndexBackfill({ db: store, log: (l) => lines.push(l), batchRows: 10 }).run()
    assert.equal(batches, 4, '25 messages and 1 title, 10 rowids a batch: 3 + 1')
    assert.equal(store.searchIndexReady, true)
    assert.equal(lines.length, 2, lines.join('\n'))
    assert.match(lines[0], /\[search\]/)
  } finally { store.close() }
}))

test('nothing pending: run does no batch and logs nothing', async () => {
  const store = new ConversationStore(IN_MEMORY_DATA_DIR)
  try {
    const lines: string[] = []
    assert.equal(await new SearchIndexBackfill({ db: store, log: (l) => lines.push(l) }).run(), 0)
    assert.deepEqual(lines, [])
  } finally { store.close() }
})

test('stop ends the walk between batches; a later run picks up where it left off', () => withDir(async (dir) => {
  const store = storeWithUnindexedHistory(dir, 25)
  try {
    const job = new SearchIndexBackfill({ db: store, log: () => {}, batchRows: 10 })
    const running = job.run()
    job.stop()
    assert.ok(await running < 4, 'stopped before the last batch')
    assert.equal(store.searchIndexReady, false)
    await new SearchIndexBackfill({ db: store, log: () => {}, batchRows: 10 }).run()
    assert.equal(store.searchIndexReady, true)
  } finally { store.close() }
}))

test('a failing batch is logged, never thrown', async () => {
  const lines: string[] = []
  const db = { backfillSearchIndex: () => { throw new Error('disk I/O error') }, searchIndexPending: true } as unknown as ConversationStore
  assert.equal(await new SearchIndexBackfill({ db, log: (l) => lines.push(l) }).run(), 0)
  assert.match(lines.join('\n'), /disk I\/O error/)
})
