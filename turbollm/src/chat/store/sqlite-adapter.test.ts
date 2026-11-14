import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inTransaction, openSqlDb } from './sqlite-adapter'

function memoryDb() {
  const db = openSqlDb(':memory:')
  db.exec('CREATE TABLE t (n INTEGER)')
  return db
}

const count = (db: ReturnType<typeof memoryDb>) => (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n

test('inTransaction commits what fn wrote and returns its result', () => {
  const db = memoryDb()
  const out = inTransaction(db, () => { db.exec('INSERT INTO t VALUES (1)'); return 'done' })
  assert.equal(out, 'done')
  assert.equal(count(db), 1)
  db.close()
})

test('inTransaction rolls back everything fn wrote when it throws, and rethrows the same error', () => {
  const db = memoryDb()
  const boom = new Error('boom')
  assert.throws(() => inTransaction(db, () => { db.exec('INSERT INTO t VALUES (1)'); throw boom }), (e) => e === boom)
  assert.equal(count(db), 0)
  db.close()
})
