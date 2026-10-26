// The run registry a chat turn runs against once it no longer belongs to its request (chat-runs.ts): numbering,
// replay from a cursor, live tail, the end, retention and listener hygiene, unit-tested without the routes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatRuns, type ChatSubscription } from './chat-runs.js'

const meta = (id: string) => ({ userMessageId: `u-${id}`, assistantMessageId: id })

/** Collects a viewer's frames until it ends: [seq, event] pairs. */
async function drain(sub: ChatSubscription): Promise<Array<[number, string]>> {
  const out: Array<[number, string]> = []
  for await (const ev of sub) out.push([ev.seq, ev.event])
  return out
}

/** Takes `n` frames from a live viewer (it stays open). */
async function take(sub: ChatSubscription, n: number): Promise<Array<[number, string]>> {
  const out: Array<[number, string]> = []
  const it = sub[Symbol.asyncIterator]()
  while (out.length < n) {
    const r = await it.next()
    if (r.done) break
    out.push([r.value.seq, r.value.event])
  }
  return out
}

test('a run numbers its frames from 0, its meta first, and drops what is emitted after its end', async () => {
  const runs = new ChatRuns()
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  await sink({ event: 'delta', data: { delta: 'hi' } })
  await sink({ event: 'done', data: {} })
  runs.end(run)
  await sink({ event: 'delta', data: { delta: 'late' } })
  assert.deepEqual(await drain(runs.subscribe(run, 0)), [[0, 'meta'], [1, 'delta'], [2, 'done']])
  assert.deepEqual(run.buffer.since(0)[0].data, meta('a1'))
})

test('a cursor in the window replays from it; one at the head replays nothing and then live-tails', async () => {
  const runs = new ChatRuns()
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  for (let i = 0; i < 4; i++) await sink({ event: 'delta', data: { i } })
  assert.deepEqual(await take(runs.subscribe(run, 3), 2), [[3, 'delta'], [4, 'delta']])
  const atHead = runs.subscribe(run, 5)
  const next = take(atHead, 1)
  await sink({ event: 'delta', data: { i: 4 } })
  assert.deepEqual(await next, [[5, 'delta']])
  atHead.close()
})

test('a cursor past the head or one that has left the window replays from the oldest frame kept', async () => {
  const runs = new ChatRuns({ cap: 5 })
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  for (let i = 0; i < 9; i++) await sink({ event: 'delta', data: { i } }) // seqs 0..9, the window is 5..9
  runs.end(run)
  const window = [[5, 'delta'], [6, 'delta'], [7, 'delta'], [8, 'delta'], [9, 'delta']]
  assert.deepEqual(await drain(runs.subscribe(run, 2)), window, 'a cursor below the window')
  assert.deepEqual(await drain(runs.subscribe(run, 42)), window, 'a cursor past the head')
  assert.deepEqual(await drain(runs.subscribe(run, 7)), window.slice(2), 'a cursor in it')
})

test('two viewers get the same frames in the same order, replayed and live', async () => {
  const runs = new ChatRuns()
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  await sink({ event: 'reasoning', data: {} })
  const a = drain(runs.subscribe(run, 0))
  await sink({ event: 'delta', data: {} })
  const b = drain(runs.subscribe(run, 0))
  await sink({ event: 'tool_call', data: {} })
  await sink({ event: 'done', data: {} })
  runs.end(run)
  const expected = [[0, 'meta'], [1, 'reasoning'], [2, 'delta'], [3, 'tool_call'], [4, 'done']]
  assert.deepEqual(await a, expected)
  assert.deepEqual(await b, expected)
})

test('a live viewer gets the terminal frame before it ends', async () => {
  const runs = new ChatRuns()
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  const viewer = drain(runs.subscribe(run, 0))
  await sink({ event: 'delta', data: {} })
  await sink({ event: 'done', data: {} })
  runs.end(run)
  assert.deepEqual((await viewer).at(-1), [2, 'done'])
})

test('an ended run is kept for retainMs, then dropped only while it is still the one registered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs = new ChatRuns({ retainMs: 30_000 })
  const first = runs.start('c1', new AbortController(), meta('a1')).run
  runs.end(first)
  t.mock.timers.tick(29_999)
  assert.equal(runs.latestRun('c1'), first)
  assert.equal(runs.find('c1', 'a1'), first)
  t.mock.timers.tick(1)
  assert.equal(runs.latestRun('c1'), undefined)
  assert.equal(runs.find('c1', 'a1'), undefined)

  // A run that ends after a newer turn of the chat took its place leaves the newer one registered.
  const stopped = runs.start('c1', new AbortController(), meta('a2')).run
  const next = runs.start('c1', new AbortController(), meta('a3')).run
  assert.equal(runs.find('c1', 'a2'), stopped, 'the stopped run, still unwinding, is still found by its reply')
  runs.end(stopped)
  t.mock.timers.tick(30_000)
  assert.equal(runs.latestRun('c1'), next)
  assert.equal(runs.find('c1', 'a2'), undefined)
  assert.equal(runs.find('c1', 'a3'), next)
})

test('a run is found by its reply only in its own chat', () => {
  const runs = new ChatRuns()
  const { run } = runs.start('c1', new AbortController(), meta('a1'))
  assert.equal(runs.find('c1', 'a1'), run)
  assert.equal(runs.find('c2', 'a1'), undefined)
  assert.equal(runs.find('c1', 'nope'), undefined)
})

test('a closed viewer, and one that ended, leave no listener on the run', async () => {
  const runs = new ChatRuns()
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  const open = runs.subscribe(run, 0)
  const pending = take(open, 5)
  assert.ok(run.emitter.listenerCount('event') > 0)
  open.close()
  await pending
  assert.equal(run.emitter.listenerCount('event'), 0)
  assert.equal(run.emitter.listenerCount('idle'), 0)

  const viewer = drain(runs.subscribe(run, 0))
  await sink({ event: 'done', data: {} })
  runs.end(run)
  await viewer
  assert.equal(run.emitter.listenerCount('event'), 0)
  assert.equal(run.emitter.listenerCount('idle'), 0)
})

test('a viewer that falls more than twice the cap behind is dropped as lagged; one that keeps up is not', async () => {
  const runs = new ChatRuns({ cap: 3 })
  const { run, sink } = runs.start('c1', new AbortController(), meta('a1'))
  const stalled = runs.subscribe(run, 0) // never read
  const reading = runs.subscribe(run, 0)
  const it = reading[Symbol.asyncIterator]()
  for (let i = 0; i < 10; i++) {
    await sink({ event: 'delta', data: { i } })
    await it.next()
  }
  assert.equal(stalled.lagged(), true)
  assert.equal(reading.lagged(), false)
  assert.deepEqual(await drain(stalled), [], 'its backlog is let go')
  reading.close()
  assert.equal(run.emitter.listenerCount('event'), 0)
})
