// The per-conversation language-server pool: idle TTL, LRU cap, never disposing a client mid-call, explicit disposal.
// Fake clients only: a real language server is never spawned here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LspPool, type PooledLspClient } from './lsp-pool'
import type { LspServerSpec } from './lsp-registry'

const ts = { language: 'typescript', languageId: 'typescript', npxArgs: [] } as unknown as LspServerSpec
const py = { language: 'python', languageId: 'python', npxArgs: [] } as unknown as LspServerSpec

function setup(opts: { ttlMs?: number; maxClients?: number } = {}) {
  const clock = { t: 0 }
  const made: Array<PooledLspClient & { disposed: boolean }> = []
  const pool = new LspPool({
    create: () => { const c = { disposed: false, dispose() { this.disposed = true } }; made.push(c); return c },
    now: () => clock.t, ttlMs: opts.ttlMs ?? 1000, maxClients: opts.maxClients ?? 10, sweepIntervalMs: 0,
  })
  return { pool, clock, made }
}

test('use: one client per conv+language, reused across calls', async () => {
  const { pool, made } = setup()
  await pool.use('c1', ts, '/r', async () => {})
  await pool.use('c1', ts, '/r', async () => {})
  await pool.use('c1', py, '/r', async () => {})
  assert.equal(made.length, 2)
  assert.equal(pool.size, 2)
})

test('disposeConv: disposes every language of that conv and forgets them', async () => {
  const { pool, made } = setup()
  await pool.use('c1', ts, '/r', async () => {})
  await pool.use('c1', py, '/r', async () => {})
  await pool.use('c2', ts, '/r', async () => {})
  pool.disposeConv('c1')
  assert.deepEqual(made.map((c) => c.disposed), [true, true, false])
  assert.equal(pool.size, 1)
})

test('sweep: disposes clients idle past the TTL, keeps recently used ones', async () => {
  const { pool, clock, made } = setup({ ttlMs: 1000 })
  await pool.use('old', ts, '/r', async () => {})
  clock.t = 900
  await pool.use('new', ts, '/r', async () => {})
  clock.t = 1500 // old idle 1500 > 1000; new idle 600
  pool.sweep()
  assert.deepEqual(made.map((c) => c.disposed), [true, false])
  assert.equal(pool.size, 1)
})

test('sweep: never disposes a client that is mid-call, however long it has run', async () => {
  const { pool, clock, made } = setup({ ttlMs: 1000 })
  let release!: () => void
  const running = pool.use('c1', ts, '/r', () => new Promise<void>((r) => { release = r }))
  clock.t = 10_000
  pool.sweep()
  assert.equal(made[0].disposed, false)
  release()
  await running
  pool.sweep() // finishing the call counted as use: idle clock restarted at t=10000
  assert.equal(made[0].disposed, false)
  clock.t = 12_000
  pool.sweep()
  assert.equal(made[0].disposed, true)
})

test('disposeConv: a client in use is disposed once its call ends, not mid-call', async () => {
  const { pool, made } = setup()
  let release!: () => void
  const running = pool.use('c1', ts, '/r', () => new Promise<void>((r) => { release = r }))
  pool.disposeConv('c1')
  assert.equal(made[0].disposed, false)
  release()
  await running
  assert.equal(made[0].disposed, true)
  assert.equal(pool.size, 0)
})

test('cap: creating past maxClients evicts the least recently used idle client', async () => {
  const { pool, clock, made } = setup({ maxClients: 2 })
  await pool.use('a', ts, '/r', async () => {})
  clock.t = 10
  await pool.use('b', ts, '/r', async () => {})
  clock.t = 20
  await pool.use('a', ts, '/r', async () => {}) // a is now more recent than b
  clock.t = 30
  await pool.use('c', ts, '/r', async () => {})
  assert.deepEqual(made.map((c) => c.disposed), [false, true, false]) // b evicted
  assert.equal(pool.size, 2)
})

test('cap: in-use clients are never evicted (the pool may exceed the cap rather than kill a live call)', async () => {
  const { pool, made } = setup({ maxClients: 1 })
  let release!: () => void
  const running = pool.use('a', ts, '/r', () => new Promise<void>((r) => { release = r }))
  await pool.use('b', ts, '/r', async () => {})
  assert.equal(made[0].disposed, false)
  release()
  await running
})

test('use: a throwing call still ends the in-use hold', async () => {
  const { pool, clock, made } = setup({ ttlMs: 100 })
  await assert.rejects(pool.use('c1', ts, '/r', async () => { throw new Error('boom') }), /boom/)
  clock.t = 500
  pool.sweep()
  assert.equal(made[0].disposed, true)
})
