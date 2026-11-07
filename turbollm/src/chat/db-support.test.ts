// The helpers the chat database's query groups share: paging cursors, keyset pages, tolerant JSON.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampPageLimit, decodePageCursor, encodePageCursor, InvalidCursorError, keysetPage, safeJson } from './db-support'
import { openSqlDb } from './store/sqlite-adapter'

function tableOf(count: number) {
  const db = openSqlDb(':memory:')
  db.exec('CREATE TABLE item (id TEXT PRIMARY KEY, at TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO item (id, at) VALUES ($id, $at)')
  for (let i = 0; i < count; i++) insert.run({ $id: `id${i}`, $at: `2026-01-01T00:00:0${i % 3}Z` })
  return db
}

const spec = { columns: 'id, at', table: 'item', sortColumn: 'at', sortValue: (r: { id: string; at: string }) => r.at, where: [] as string[], params: {} }

test('a page cursor round-trips, and one this code did not issue is an InvalidCursorError', () => {
  assert.deepEqual(decodePageCursor(encodePageCursor('2026-01-01', 'abc')), { u: '2026-01-01', i: 'abc' })
  for (const bad of ['not base64 json', Buffer.from('{"u":1,"i":"x"}').toString('base64url'), Buffer.from('null').toString('base64url')]) {
    assert.throws(() => decodePageCursor(bad), InvalidCursorError)
  }
})

test('clampPageLimit falls back for a missing or nonsense limit and caps a large one', () => {
  assert.equal(clampPageLimit(undefined, 50, 200), 50)
  assert.equal(clampPageLimit(0, 50, 200), 50)
  assert.equal(clampPageLimit(Number.NaN, 50, 200), 50)
  assert.equal(clampPageLimit(7.9, 50, 200), 7)
  assert.equal(clampPageLimit(9999, 50, 200), 200)
})

test('keysetPage walks a newest-first table in pages that never repeat or skip a row', () => {
  const db = tableOf(7)
  const seen: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = keysetPage<{ id: string; at: string }>(db, spec, { limit: 3, cursor }, 50, 200)
    seen.push(...page.rows.map((r) => r.id))
    cursor = page.nextCursor ?? undefined
    pages++
  } while (cursor)
  assert.equal(pages, 3)
  assert.equal(new Set(seen).size, 7)
  assert.deepEqual(seen, [...seen].sort((a, b) => {
    const row = (id: string) => db.prepare('SELECT at FROM item WHERE id = $id').get({ $id: id }) as { at: string }
    return row(b).at.localeCompare(row(a).at) || b.localeCompare(a)
  }))
  db.close()
})

test('keysetPage returns no cursor when everything fits one page', () => {
  const db = tableOf(2)
  assert.equal(keysetPage(db, spec, {}, 50, 200).nextCursor, null)
  db.close()
})

test('safeJson reads valid JSON and answers {} for text that is not', () => {
  assert.deepEqual(safeJson('[1,2]'), [1, 2])
  assert.deepEqual(safeJson('{oops'), {})
})
