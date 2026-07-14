// Unit tests for the daemon-owned run manager's pure, isolable core (Task 5):
//   • RingBuffer         — the bounded seq-numbered append log + since()/head()
//   • subscribeToBuffer  — replay-from-seq + live-tail + idle termination + close()
//
// These are exactly the reconnect semantics a client relies on: replay everything already
// emitted from a given seq, then continue live, and terminate cleanly when the run settles —
// WITHOUT ever dropping the terminal 'done'/'error' frame. The live pi loop (needs a loaded
// model) is out of scope here and is covered by the live smoke test instead.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { RingBuffer, subscribeToBuffer, type BufferedEvent } from './code-run-manager'

// ── RingBuffer ──────────────────────────────────────────────────────────────────────

test('RingBuffer: assigns monotonic seqs starting at 0 and advances head()', () => {
  const b = new RingBuffer()
  assert.equal(b.head(), 0)
  const e0 = b.push('meta', { a: 1 })
  const e1 = b.push('delta', { delta: 'hi' })
  assert.equal(e0.seq, 0)
  assert.equal(e1.seq, 1)
  assert.equal(b.head(), 2)
})

test('RingBuffer: since(fromSeq) returns exactly the events at/after fromSeq, in order', () => {
  const b = new RingBuffer()
  for (let i = 0; i < 5; i++) b.push('delta', { delta: String(i) })
  assert.deepEqual(b.since(0).map((e) => e.seq), [0, 1, 2, 3, 4])
  assert.deepEqual(b.since(3).map((e) => e.seq), [3, 4])
  assert.deepEqual(b.since(5), []) // nothing yet at head
  assert.deepEqual(b.since(99), [])
})

test('RingBuffer: overflow drops the OLDEST events but seqs stay monotonic (since() still exact)', () => {
  const b = new RingBuffer()
  // BUFFER_CAP is 6000; push more than that so the front is evicted.
  const N = 6100
  for (let i = 0; i < N; i++) b.push('delta', { delta: i })
  assert.equal(b.head(), N)
  // Earliest surviving seq is N - CAP = 100; since() below that returns only what survives.
  const all = b.since(0)
  assert.equal(all[0].seq, 100)
  assert.equal(all.at(-1)!.seq, N - 1)
  assert.equal(all.length, 6000)
  // A reconnect from a recent seq is unaffected by eviction.
  assert.deepEqual(b.since(N - 3).map((e) => e.seq), [N - 3, N - 2, N - 1])
})

// ── subscribeToBuffer: replay ──────────────────────────────────────────────────────

test('subscribeToBuffer: replays the backlog from fromSeq before any live event', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  b.push('meta', { assistantMessageId: 'a1' })
  b.push('delta', { delta: 'one' })
  b.push('delta', { delta: 'two' })

  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()
  const r0 = await it.next(); assert.equal((r0.value as BufferedEvent).seq, 0)
  const r1 = await it.next(); assert.equal((r1.value as BufferedEvent).seq, 1)
  const r2 = await it.next(); assert.equal((r2.value as BufferedEvent).seq, 2)
  sub.close()
})

test('subscribeToBuffer: replayFloor clamps the backlog to the current turn only', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  // Simulate an earlier, already-persisted turn (seqs 0..2) then the current turn from seq 3.
  b.push('meta', { t: 'A' }); b.push('delta', {}); b.push('done', {})
  b.push('meta', { t: 'B' }); b.push('delta', {})

  // A fresh reconnect asks fromSeq=0, but replayFloor=3 (current turn's meta) must win.
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 3, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()
  const r0 = await it.next(); assert.equal((r0.value as BufferedEvent).seq, 3)
  const r1 = await it.next(); assert.equal((r1.value as BufferedEvent).seq, 4)
  sub.close()
})

test('subscribeToBuffer: a fresher fromSeq wins over replayFloor (mid-turn reconnect)', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  b.push('meta', {}); b.push('delta', { n: 1 }); b.push('delta', { n: 2 }); b.push('delta', { n: 3 })

  // Client already saw up to seq 2; reconnects from 3. replayFloor (0) must NOT re-replay 0..2.
  const sub = subscribeToBuffer(b, em, { fromSeq: 3, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()
  const r = await it.next()
  assert.equal((r.value as BufferedEvent).seq, 3)
  sub.close()
})

// ── subscribeToBuffer: live-tail ────────────────────────────────────────────────────

test('subscribeToBuffer: after the backlog drains, next() awaits and resolves on a live event', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()

  // No backlog → next() pends. Emit a live event and it resolves.
  const pendingNext = it.next()
  const live = b.push('delta', { delta: 'live' })
  em.emit('event', live)
  const r = await pendingNext
  assert.equal(r.done, false)
  assert.equal((r.value as BufferedEvent).seq, 0)
  sub.close()
})

test('subscribeToBuffer: live events arriving while not awaiting are buffered, not lost', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()

  // Two events emitted before the consumer calls next() — both must be delivered in order.
  em.emit('event', b.push('delta', { n: 1 }))
  em.emit('event', b.push('delta', { n: 2 }))
  const r0 = await it.next(); assert.equal((r0.value as BufferedEvent).seq, 0)
  const r1 = await it.next(); assert.equal((r1.value as BufferedEvent).seq, 1)
  sub.close()
})

// ── subscribeToBuffer: termination ──────────────────────────────────────────────────

test('subscribeToBuffer: idleAtStart=true ends after draining the backlog (idle reconnect)', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  b.push('done', { aborted: false }) // a completed turn's last frame still in the retain window

  // replayFloor at head → nothing to replay → immediate done (client falls back to DB).
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: b.head(), idleAtStart: true })
  const it = sub[Symbol.asyncIterator]()
  const r = await it.next()
  assert.equal(r.done, true)
})

test('subscribeToBuffer: idle signal terminates the stream, but only AFTER the terminal frame', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()

  // Consumer is awaiting. The run pushes its terminal 'done' then the session goes idle in the
  // SAME tick — the consumer must still receive 'done' before the iterator ends.
  const pendingNext = it.next()
  const doneEv = b.push('done', { aborted: false })
  em.emit('event', doneEv)
  em.emit('idle')
  const r0 = await pendingNext
  assert.equal(r0.done, false)
  assert.equal((r0.value as BufferedEvent).event, 'done')
  const r1 = await it.next()
  assert.equal(r1.done, true)
})

test('subscribeToBuffer: idle emitted while events are still buffered drains them first', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  // Backlog present at subscribe time.
  b.push('delta', { n: 1 }); b.push('done', { aborted: false })
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()

  em.emit('idle') // idle fires before the consumer has drained the backlog
  const r0 = await it.next(); assert.equal((r0.value as BufferedEvent).event, 'delta')
  const r1 = await it.next(); assert.equal((r1.value as BufferedEvent).event, 'done')
  const r2 = await it.next(); assert.equal(r2.done, true)
})

test('subscribeToBuffer: close() ends a pending next() (client disconnect)', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const it = sub[Symbol.asyncIterator]()

  const pendingNext = it.next()
  sub.close()
  const r = await pendingNext
  assert.equal(r.done, true)
  // After close, further events are ignored and next() stays done.
  em.emit('event', b.push('delta', {}))
  const r2 = await it.next()
  assert.equal(r2.done, true)
})

test('subscribeToBuffer: closing detaches listeners (no leak across many subscribers)', () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  for (let i = 0; i < 20; i++) {
    const sub = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
    sub.close()
  }
  assert.equal(em.listenerCount('event'), 0)
  assert.equal(em.listenerCount('idle'), 0)
})

test('subscribeToBuffer: two independent subscribers both see the same live events', async () => {
  const b = new RingBuffer()
  const em = new EventEmitter()
  const s1 = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const s2 = subscribeToBuffer(b, em, { fromSeq: 0, replayFloor: 0, idleAtStart: false })
  const i1 = s1[Symbol.asyncIterator]()
  const i2 = s2[Symbol.asyncIterator]()

  const n1 = i1.next()
  const n2 = i2.next()
  em.emit('event', b.push('delta', { delta: 'x' }))
  const [r1, r2] = await Promise.all([n1, n2])
  assert.equal((r1.value as BufferedEvent).seq, 0)
  assert.equal((r2.value as BufferedEvent).seq, 0)
  s1.close(); s2.close()
})
