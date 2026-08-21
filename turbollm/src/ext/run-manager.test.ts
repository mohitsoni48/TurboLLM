// Run lifecycle and resumption (spec 27 §6). The generation function is injected so these
// tests exercise ownership, buffering, and reconnect deterministically without a model.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PublicRunManager, type RunBody } from './run-manager.js'

const SCOPE = { tenant: 'acme', owner: 'u1' }

/** Emits n deltas, then resolves. Awaits `gate` first when given, so a test can hold a run open. */
function fakeBody(n: number, gate?: Promise<void>): RunBody {
  return async ({ emit, signal }) => {
    if (gate) await gate
    for (let i = 0; i < n; i++) {
      if (signal.aborted) return { status: 'aborted' }
      await emit({ event: 'delta', data: { content: `t${i}` } })
    }
    return { status: 'complete' }
  }
}

async function collect(sub: AsyncIterable<{ seq: number; event: string; data: unknown }>) {
  const out: Array<{ seq: number; event: string; data: unknown }> = []
  for await (const ev of sub) out.push(ev)
  return out
}

test('a run completes and its stream ends with a done event', async () => {
  const runs = new PublicRunManager()
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(3) })
  const events = await collect(runs.subscribe(run.id, 0))

  assert.deepEqual(events.filter((e) => e.event === 'delta').map((e) => (e.data as { content: string }).content), ['t0', 't1', 't2'])
  const done = events.at(-1)
  assert.equal(done?.event, 'done')
  assert.equal((done?.data as { status: string }).status, 'complete')
  assert.equal(runs.get(run.id)?.status, 'complete')
})

test('a dropped subscriber does NOT abort the run', async () => {
  const runs = new PublicRunManager()
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(2, gate) })

  const sub = runs.subscribe(run.id, 0)
  sub.close()                       // the client vanished mid-run
  release!()
  await runs.settled(run.id)

  assert.equal(runs.get(run.id)?.status, 'complete', 'work continues without an audience')
})

test('reattaching from a cursor replays only what was missed', async () => {
  const runs = new PublicRunManager()
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(4) })
  await runs.settled(run.id)

  const all = await collect(runs.subscribe(run.id, 0))
  const resumed = await collect(runs.subscribe(run.id, 3))

  assert.ok(all.length > resumed.length)
  assert.deepEqual(resumed.map((e) => e.seq), all.slice(3).map((e) => e.seq))
  assert.equal(resumed[0].seq, 3, 'replay starts exactly at the requested cursor')
})

test('reattaching past the retained window reports replay_window_exceeded', async () => {
  const runs = new PublicRunManager({ bufferCap: 4 })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(20) })
  await runs.settled(run.id)

  assert.equal(runs.canReplayFrom(run.id, 0), false, 'seq 0 has been evicted')
  assert.equal(runs.canReplayFrom(run.id, 19), true)
})

test('cancel aborts the run and marks it aborted', async () => {
  const runs = new PublicRunManager()
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(5, gate) })

  assert.equal(runs.cancel(run.id), true)
  release!()
  await runs.settled(run.id)
  assert.equal(runs.get(run.id)?.status, 'aborted')
  assert.equal(runs.cancel('no-such-run'), false)
})

test('a body that throws marks the run failed and emits an error event', async () => {
  const runs = new PublicRunManager()
  const run = runs.start({
    scope: SCOPE, chatId: 'c1', messageId: 'm1',
    body: async () => { throw new Error('engine exploded') },
  })
  const events = await collect(runs.subscribe(run.id, 0))

  assert.ok(events.some((e) => e.event === 'error'))
  assert.equal(events.at(-1)?.event, 'done')
  assert.equal(runs.get(run.id)?.status, 'failed')
  assert.match(runs.get(run.id)?.error?.message ?? '', /engine exploded/)
})

test('runs are listed per tenant and never leak across tenants', async () => {
  const runs = new PublicRunManager()
  const mine = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(1) })
  runs.start({ scope: { tenant: 'globex', owner: 'u1' }, chatId: 'c2', messageId: 'm2', body: fakeBody(1) })
  await runs.settled(mine.id)

  assert.deepEqual(runs.list('acme').map((r) => r.id), [mine.id])
  assert.equal(runs.list('globex').length, 1)
})

// C1 (final-gate fix round): tenant scoping alone let one owner enumerate every other owner's
// runs within the SAME tenant — a real cross-owner data leak, since one tenant's API key is
// shared across an integrator's many end users (spec 27 §3.1). `list()` now takes an optional
// `owner` and must filter by it whenever supplied, on top of the pre-existing tenant filter.
test('runs are listed per owner within a tenant, and never leak across owners', async () => {
  const runs = new PublicRunManager()
  const mine = runs.start({ scope: { tenant: 'acme', owner: 'u1' }, chatId: 'c1', messageId: 'm1', body: fakeBody(1) })
  const theirs = runs.start({ scope: { tenant: 'acme', owner: 'u2' }, chatId: 'c2', messageId: 'm2', body: fakeBody(1) })
  await runs.settled(mine.id)
  await runs.settled(theirs.id)

  assert.deepEqual(runs.list('acme', 'u1').map((r) => r.id), [mine.id], 'owner u1 must see only its own run')
  assert.deepEqual(runs.list('acme', 'u2').map((r) => r.id), [theirs.id], 'owner u2 must see only its own run')
  // Omitting `owner` entirely is still supported (e.g. an internal/admin caller) and returns
  // the whole tenant, matching the pre-existing tenant-only behavior above.
  assert.equal(runs.list('acme').length, 2, 'omitting owner falls back to whole-tenant listing')
})

// ── N4 (final-gate fix round) — reserveChat/releaseChat/isChatActive, the single shared
// mechanism replacing routes.runs.ts's own private `inflight` Map and routes.chats.ts's
// `hasActiveRun` (which used to consult only `list()`, disagreeing with the reservation during
// the window before a real PublicRun record exists). ─────────────────────────────────────────
test('reserveChat marks a chat active immediately, before any run exists', () => {
  const runs = new PublicRunManager()
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false, 'sanity: nothing reserved yet')
  assert.equal(runs.reserveChat(SCOPE, 'c1'), true, 'a fresh reservation succeeds')
  assert.equal(runs.isChatActive(SCOPE, 'c1'), true, 'active from the moment of reservation, no run needed')
})

test('reserveChat refuses a second reservation for the same chat while the first is held', () => {
  const runs = new PublicRunManager()
  assert.equal(runs.reserveChat(SCOPE, 'c1'), true)
  assert.equal(runs.reserveChat(SCOPE, 'c1'), false, 'the chat is already reserved')
})

test('releaseChat frees the reservation, so a follow-up reserveChat succeeds again', () => {
  const runs = new PublicRunManager()
  assert.equal(runs.reserveChat(SCOPE, 'c1'), true)
  runs.releaseChat(SCOPE, 'c1')
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false)
  assert.equal(runs.reserveChat(SCOPE, 'c1'), true, 'released, so a new reservation is admitted')
})

test('releaseChat is idempotent — calling it twice, or on a chat never reserved, does not throw', () => {
  const runs = new PublicRunManager()
  assert.doesNotThrow(() => { runs.releaseChat(SCOPE, 'never-reserved') })
  runs.reserveChat(SCOPE, 'c1')
  runs.releaseChat(SCOPE, 'c1')
  assert.doesNotThrow(() => { runs.releaseChat(SCOPE, 'c1') })
})

test('reservations are scoped by tenant+owner+chatId, not chatId alone', () => {
  const runs = new PublicRunManager()
  assert.equal(runs.reserveChat(SCOPE, 'c1'), true)
  // A DIFFERENT owner reserving the SAME chatId string must not collide with the first — chat
  // ids are unique in practice, but the reservation key matches every other scope check in this
  // file (tenant+owner+chatId) as defense in depth.
  assert.equal(runs.reserveChat({ tenant: 'acme', owner: 'u2' }, 'c1'), true)
  assert.equal(runs.isChatActive(SCOPE, 'c1'), true)
  assert.equal(runs.isChatActive({ tenant: 'acme', owner: 'u2' }, 'c1'), true)
  assert.equal(runs.isChatActive({ tenant: 'globex', owner: 'u1' }, 'c1'), false, 'a different tenant entirely must not see this chat as active')
})

test('isChatActive also sees a real non-ended run even without an explicit reservation (defense in depth)', async () => {
  const runs = new PublicRunManager()
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(1, gate) })
  // No `reserveChat` call was ever made for this chat — the run's own existence must still be
  // enough, mirroring the same defense-in-depth reasoning `list()`'s cross-owner filtering uses.
  assert.equal(runs.isChatActive(SCOPE, 'c1'), true, 'a real, non-ended run makes the chat active even with no reservation')
  release!()
  await runs.settled(run.id)
  assert.equal(runs.isChatActive(SCOPE, 'c1'), false, 'a settled (ended) run no longer counts as active')
})

test('an orphaned run with no subscriber and no poll is reaped', async () => {
  const runs = new PublicRunManager({ orphanTimeoutMs: 20 })
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(3, gate) })

  await new Promise((r) => setTimeout(r, 60))
  runs.reapOrphans()
  assert.equal(runs.get(run.id)?.status, 'aborted')
  release!()
})

test('polling counts as liveness, so a poll-only client is never reaped', async () => {
  const runs = new PublicRunManager({ orphanTimeoutMs: 40 })
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(3, gate) })

  // A JSON-mode client polling GET /runs/{id} — spec 27 §6.5's whole point.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 20))
    runs.touch(run.id)
    runs.reapOrphans()
  }
  assert.notEqual(runs.get(run.id)?.status, 'aborted', 'a polling client keeps its run alive')
  release!()
  await runs.settled(run.id)
})

test('a subscriber that disconnects via the iterator\'s own return() (for-await break) is still counted as departed', async () => {
  const runs = new PublicRunManager({ orphanTimeoutMs: 20 })
  let release: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = runs.start({ scope: SCOPE, chatId: 'c1', messageId: 'm1', body: fakeBody(3, gate) })

  const sub = runs.subscribe(run.id, 0)
  const iterator = sub[Symbol.asyncIterator]()
  await iterator.return?.()               // what `for await (const ev of sub) { ...; break }` invokes

  await new Promise((r) => setTimeout(r, 60))
  runs.reapOrphans()
  assert.equal(runs.get(run.id)?.status, 'aborted', 'the abandoned subscriber must not pin the run open')
  release!()
})
