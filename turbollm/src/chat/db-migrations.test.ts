// The schema ladder lives in db-migrations.ts as an append-only array (scalability review 5.7).
// These tests pin what the array conversion must not change: stopping the ladder at version N
// yields the exact schema the old inline migrations produced at N (GOLDEN_SCHEMA, measured from
// them before the move), and a database left at any older version opens as the same schema a
// fresh database gets. One SQL class serves desktop's node:sqlite and Android's sql.js, so each
// check runs on both.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { test } from 'node:test'
import { ConversationStore } from './db'
import { MIGRATIONS, runMigrations } from './db-migrations'
import { openSqlDb, preloadSqlJs, type SqlDb } from './store/sqlite-adapter'
import { tmpDir } from '../test-support/tmp'

type Backend = 'node:sqlite' | 'sql.js'
const BACKENDS: Backend[] = ['node:sqlite', 'sql.js']

/** sha1 prefix of every schema object's SQL after migrations 1..N (the search index's own
 *  tables and triggers excluded: reconcileSearchIndex owns them, per runtime), from the inline
 *  migrations this array replaced. Versions 37 and 38 share a hash: v38 is a data-only fix. */
const GOLDEN_SCHEMA: Record<number, string> = {
  1: 'b577884dae74', 2: 'db7480670dff', 3: 'e23d520d15db', 4: '4f5820eb0ed0', 5: '3f07be4020a9', 6: '2672e3d3aa91',
  7: '656a60fc7a23', 8: '5acfcddaf89b', 9: 'df3176479438', 10: '325d1782acaa', 11: '1b0b0c08f3d9', 12: '6d470d27fdc9',
  13: '1a6a05fb7e95', 14: '93e42aa03056', 15: 'd62cb39c81e3', 16: '6f9f6b7c74a1', 17: '1d7d0a304fac', 18: '4900c5bdd252',
  19: '082a17256338', 20: '0b728618d5d8', 21: '4252553fddaa', 22: 'b1a4b97f7c13', 23: '5b6e9df65d19', 24: 'a58301bbb473',
  25: '8d8d21a54948', 26: '075f5d82c0b8', 27: 'cca096b48b33', 28: 'e3bd55b6a474', 29: 'fb1026b12683', 30: '65f3d77b0d5b',
  31: '86857423287e', 32: 'f41c7f0e10b9', 33: '946bdd3fbb9a', 34: '75596b4c7447', 35: 'ac7563eec6ed', 36: '437542cff1b3',
  37: '86dd4e9780ae', 38: '86dd4e9780ae', 39: 'b992d762df09', 40: '26e6a2c17418', 41: '8480fe17ee94', 42: '0011e805c559',
  43: '9e573eb56549', 44: 'c03722433fe1', 45: '9df44ff78234', 46: '7fc1c58de742', 47: '47bdd620e3ae', 48: 'feef3f62778e',
  49: 'd53ce39c853f', 50: 'e2852e43bfa1', 51: 'ec15a80517ce', 52: '68296496f02d', 53: 'b6f75d201e7d', 54: '13a211d3aa4b',
  55: '6d3d1c989ca3',
}

/** Runs `fn` with a scratch directory on `backend` (sql.js is selected by the platform check in
 *  openSqlDb, so it is stubbed to android for the duration). `freshDir` makes an empty directory
 *  inside it, so no run inherits another's database or WAL files. */
async function withDir(backend: Backend, fn: (freshDir: () => string) => void | Promise<void>): Promise<void> {
  const actual = process.platform
  if (backend === 'sql.js') {
    Object.defineProperty(process, 'platform', { value: 'android' })
    await preloadSqlJs()
  }
  const dir = tmpDir('tllm-migrations-')
  let count = 0
  try {
    await fn(() => {
      const sub = `${dir}/${count++}`
      mkdirSync(sub)
      return sub
    })
  } finally {
    Object.defineProperty(process, 'platform', { value: actual })
    rmSync(dir, { recursive: true, force: true })
  }
}

function schemaRows(db: SqlDb, excludeSearchIndex: boolean): unknown[] {
  const fts = excludeSearchIndex ? `AND name NOT LIKE '%\\_fts%' ESCAPE '\\'` : ''
  return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ${fts} ORDER BY type, name`).all()
}

function userVersion(db: SqlDb): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

test('MIGRATIONS holds one step per schema version, 1 through the latest', () => {
  assert.equal(MIGRATIONS.length, Math.max(...Object.keys(GOLDEN_SCHEMA).map(Number)))
  assert.ok(MIGRATIONS.every((step) => typeof step === 'function'))
})

for (const backend of BACKENDS) {
  test(`${backend}: stopping the ladder at version N leaves the schema the inline migrations left at N`, async () => {
    await withDir(backend, (freshDir) => {
      for (let version = 1; version <= MIGRATIONS.length; version++) {
        const db = openSqlDb(`${freshDir()}/turbollm.db`)
        try {
          runMigrations(db, version)
          assert.equal(userVersion(db), version)
          const hash = createHash('sha1').update(JSON.stringify(schemaRows(db, true))).digest('hex').slice(0, 12)
          assert.equal(hash, GOLDEN_SCHEMA[version], `schema after v${version}`)
        } finally {
          db.close()
        }
      }
    })
  })

  test(`${backend}: a database left at an older version opens as the schema a fresh database gets`, async () => {
    await withDir(backend, (freshDir) => {
      const fresh = new ConversationStore(freshDir())
      const expected = schemaRows(fresh.handle, false)
      fresh.close()
      for (const version of [1, 8, 27, 40, 45, 52, 53, 54, 55]) {
        const dir = freshDir()
        const old = openSqlDb(`${dir}/turbollm.db`)
        runMigrations(old, version)
        old.close()
        const store = new ConversationStore(dir)
        try {
          assert.equal(userVersion(store.handle), MIGRATIONS.length, `user_version from v${version}`)
          assert.deepEqual(schemaRows(store.handle, false), expected, `schema from v${version}`)
        } finally {
          store.close()
        }
      }
    })
  })
}
