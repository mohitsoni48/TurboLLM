import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSqlJsDatabaseSync, preload } from './sql-js-database.js'
import { tmpDir } from '../../test-support/tmp'

before(() => preload())

/** How long after the last write a flush runs, and the most a write waits while writes keep coming. */
const SETTLE_MS = 1_000
const MAX_WAIT_MS = 10_000

/** What the file at `path` holds now, read through a separate copy (an open adapter keeps its own in memory). */
function onDisk(path: string): unknown[] {
  if (!existsSync(path)) return []
  const copy = openSqlJsDatabaseSync(path)
  try {
    return copy.prepare('SELECT v FROM t').all().map((r) => r.v)
  } finally {
    copy.close()
  }
}

test('close() persists writes and a reopen loads them', () => {
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello')
  db.close()

  assert.equal(existsSync(`${path}.tmp`), false, 'temp file is renamed away, not left behind')
  const again = openSqlJsDatabaseSync(path)
  assert.deepEqual(again.prepare('SELECT v FROM t').all(), [{ v: 'hello' }])
  again.close()
})

test('a leftover temp file from a killed flush does not affect the loaded snapshot', () => {
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('kept')
  db.close()

  writeFileSync(`${path}.tmp`, 'truncated garbage')
  const again = openSqlJsDatabaseSync(path)
  assert.deepEqual(again.prepare('SELECT v FROM t').all(), [{ v: 'kept' }])
  again.close()
})

test('foreign_keys from a combined PRAGMA string is applied and survives a flush', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const db = openSqlJsDatabaseSync(join(tmpDir('turbollm-sqljs-'), 'chat.db'))
  // The exact string ConversationStore's migrate() runs (chat/db.ts).
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`)
  db.exec(`CREATE TABLE p (id TEXT PRIMARY KEY);
    CREATE TABLE c (id TEXT, p_id TEXT REFERENCES p(id) ON DELETE CASCADE);`)
  db.prepare(`INSERT INTO p (id) VALUES ('a'), ('b')`).run()
  db.prepare(`INSERT INTO c (id, p_id) VALUES ('1', 'a'), ('2', 'b')`).run()

  db.prepare(`DELETE FROM p WHERE id = 'a'`).run()
  assert.deepEqual(db.prepare('SELECT id FROM c').all(), [{ id: '2' }], 'cascade before any flush')

  t.mock.timers.tick(MAX_WAIT_MS) // export() resets connection PRAGMAs
  assert.deepEqual(db.prepare('PRAGMA foreign_keys').get(), { foreign_keys: 1 })
  db.prepare(`DELETE FROM p WHERE id = 'b'`).run()
  assert.deepEqual(db.prepare('SELECT id FROM c').all(), [], 'cascade still fires after a flush')
  db.close()
})

test('the flush writes only when something changed', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)

  t.mock.timers.tick(MAX_WAIT_MS)
  assert.equal(existsSync(path), false, 'nothing written yet, so nothing flushed')

  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('a')
  t.mock.timers.tick(MAX_WAIT_MS)
  assert.equal(existsSync(path), true)
  // Every flush renames a fresh file into place, so an unchanged inode means no rewrite.
  const ino = statSync(path).ino

  db.prepare('SELECT v FROM t').all()
  t.mock.timers.tick(MAX_WAIT_MS)
  assert.equal(statSync(path).ino, ino, 'reads alone do not trigger a rewrite')

  db.prepare('INSERT INTO t (v) VALUES (?)').run('b')
  t.mock.timers.tick(MAX_WAIT_MS)
  assert.notEqual(statSync(path).ino, ino, 'a new write is flushed')
  db.close()
})

// Quit on Android kills the process, and the OS kills apps: a reply saved seconds before a kill must already be in the
// file. It used to wait for a flush every 10 s.
test('a write is on disk about a second after it, not ten', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('the reply')

  t.mock.timers.tick(SETTLE_MS - 1)
  assert.equal(existsSync(path), false, 'not on every write')
  t.mock.timers.tick(1)
  assert.deepEqual(onDisk(path), ['the reply'])
  db.close()
})

test('a burst of writes is exported once, after it settles, not once per write', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('first')
  t.mock.timers.tick(SETTLE_MS)
  const ino = statSync(path).ino

  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`)
    t.mock.timers.tick(200) // a reply's rows, an import: closer together than the settle time
    assert.equal(statSync(path).ino, ino, `no export while the burst goes on (write ${i})`)
  }
  t.mock.timers.tick(SETTLE_MS)
  assert.notEqual(statSync(path).ino, ino, 'exported once it settled')
  assert.equal(onDisk(path).length, 21)
  db.close()
})

test('while writes keep coming, the oldest is on disk within 10 s', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += 500) {
    db.prepare('INSERT INTO t (v) VALUES (?)').run(`at ${elapsed}`)
    t.mock.timers.tick(500)
    if (elapsed + 500 < MAX_WAIT_MS) assert.equal(existsSync(path), false, `still writing at ${elapsed + 500} ms`)
  }
  assert.equal(onDisk(path).length, MAX_WAIT_MS / 500, 'flushed at the ceiling, with every write so far')
  // The next ones are then held to the ceiling again, not flushed on every write.
  const ino = statSync(path).ino
  db.prepare('INSERT INTO t (v) VALUES (?)').run('after')
  t.mock.timers.tick(500)
  assert.equal(statSync(path).ino, ino)
  db.close()
})

test('a failed flush is retried, and a flush on request says whether it wrote', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  mkdirSync(`${path}.tmp`) // the temp file cannot be opened for writing: every flush fails
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('kept in memory')

  t.mock.timers.tick(SETTLE_MS)
  assert.equal(existsSync(path), false, 'the flush failed')
  assert.equal(db.flush?.(), false, 'a flush on request reports the failure')
  rmSync(`${path}.tmp`, { recursive: true })
  t.mock.timers.tick(MAX_WAIT_MS - 1)
  assert.equal(existsSync(path), false, 'retried after 10 s, not every second')
  t.mock.timers.tick(1)
  assert.deepEqual(onDisk(path), ['kept in memory'], 'the retry wrote it')

  db.prepare('INSERT INTO t (v) VALUES (?)').run('on request')
  assert.equal(db.flush?.(), true)
  assert.deepEqual(onDisk(path), ['kept in memory', 'on request'], 'on disk when flush() returns')
  assert.equal(db.flush?.(), true, 'nothing pending is on disk too')
  db.close()
})

// Date.now() is the wall clock: a manual time change on the phone, or a network time correction, can set it back.
// Waiting for a time noted before that held every later flush back as long as the clock went back.
test('a clock set back after a flush does not hold the next write back', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.UTC(2026, 0, 1) })
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('before')
  t.mock.timers.tick(SETTLE_MS)
  assert.deepEqual(onDisk(path), ['before'])

  // No flush is pending here: the mock's timers follow its clock, where real ones do not move when it is set back.
  t.mock.timers.setTime(Date.now() - 3_600_000)
  db.prepare('INSERT INTO t (v) VALUES (?)').run('after')
  t.mock.timers.tick(SETTLE_MS)
  assert.deepEqual(onDisk(path), ['before', 'after'], 'on disk a second later, not an hour')

  // The clock read afresh, a burst is again exported once it settles.
  const ino = statSync(path).ino
  db.prepare('INSERT INTO t (v) VALUES (?)').run('next')
  t.mock.timers.tick(SETTLE_MS - 1)
  assert.equal(statSync(path).ino, ino, 'not on every write')
  t.mock.timers.tick(1)
  assert.deepEqual(onDisk(path), ['before', 'after', 'next'])
  db.close()
})

// ConversationStore.transaction (chat branching's multi-statement edits and version switches)
// runs BEGIN IMMEDIATE / COMMIT / ROLLBACK through exec(), on Android too.
test('a transaction through exec() rolls back or commits, and a committed one is flushed', () => {
  const path = join(tmpDir('turbollm-sqljs-'), 'chat.db')
  const db = openSqlJsDatabaseSync(path)
  db.exec('CREATE TABLE t (v TEXT)')
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('rolled back')
  db.exec('ROLLBACK')
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('committed')
  db.exec('COMMIT')
  assert.deepEqual(db.prepare('SELECT v FROM t').all(), [{ v: 'committed' }])
  db.close()

  const again = openSqlJsDatabaseSync(path)
  assert.deepEqual(again.prepare('SELECT v FROM t').all(), [{ v: 'committed' }])
  again.close()
})
