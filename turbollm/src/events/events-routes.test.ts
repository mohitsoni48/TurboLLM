import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { EventBus } from './bus'
import { InvalidationRelay, MAX_PENDING_KEYS, RESYNC_KEY, registerEventsRoutes } from './events-routes'

interface Sent { event?: string; data: string }

/** A stand-in for hono's SSE stream whose writes finish only when the test says so (a slow client). */
function heldWriter() {
  const sent: Sent[] = []
  const comments: string[] = []
  let release: (() => void) | null = null
  return {
    sent,
    comments,
    writeSSE(msg: Sent): Promise<void> {
      sent.push(msg)
      return new Promise<void>((r) => { release = r })
    },
    write(text: string): Promise<void> {
      comments.push(text)
      return Promise.resolve()
    },
    async finishWrite(): Promise<void> {
      const r = release
      release = null
      r?.()
      await new Promise((r2) => setImmediate(r2))
    },
  }
}

test('keys heard while a write is out are sent together in the next one, once each', async () => {
  const w = heldWriter()
  const relay = new InvalidationRelay(w)
  relay.hear(['status'])
  relay.hear(['conversations', 'status'])
  relay.hear(['conversation:c1'])
  assert.deepEqual(w.sent.map((m) => JSON.parse(m.data)), [['status']])
  await w.finishWrite()
  assert.deepEqual(w.sent.map((m) => JSON.parse(m.data)), [['status'], ['conversations', 'status', 'conversation:c1']])
  assert.ok(w.sent.every((m) => m.event === 'invalidate'))
})

test('a client too slow to take its keys is told to resync everything instead of being buffered for', async () => {
  const w = heldWriter()
  const relay = new InvalidationRelay(w)
  relay.hear(['status'])
  for (let i = 0; i <= MAX_PENDING_KEYS; i++) relay.hear([`conversation:${i}`])
  await w.finishWrite()
  assert.deepEqual(JSON.parse(w.sent[1].data), [RESYNC_KEY])
  relay.hear(['models'])
  await w.finishWrite()
  assert.deepEqual(JSON.parse(w.sent[2].data), ['models'], 'once caught up it is back to plain keys')
})

test('a heartbeat is a comment, and is skipped while a write is still out', async () => {
  const w = heldWriter()
  const relay = new InvalidationRelay(w)
  relay.heartbeat()
  assert.equal(w.comments.length, 1)
  assert.match(w.comments[0], /^:.*\n\n$/)
  relay.hear(['status'])
  relay.heartbeat()
  assert.equal(w.comments.length, 1)
})

test('GET /api/v1/events streams the bus as invalidate events and unsubscribes when the client goes', async () => {
  const bus = new EventBus(5)
  const app = new Hono()
  registerEventsRoutes(app, { bus, heartbeatMs: 60_000 })
  const ac = new AbortController()
  const res = await app.request('/api/v1/events', { signal: ac.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = decoder.decode((await reader.read()).value)
  assert.match(text, /^:/, 'the stream opens with a comment so headers and a first byte pass any proxy at once')
  assert.equal(bus.subscriberCount(), 1)

  bus.emit('routines')
  bus.emit('routine-runs:r1')
  while (!text.includes('data:')) text += decoder.decode((await reader.read()).value)
  assert.match(text, /event: invalidate\ndata: \["routines","routine-runs:r1"\]\n\n/)

  ac.abort()
  await reader.cancel().catch(() => {})
  for (let i = 0; i < 20 && bus.subscriberCount() > 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(bus.subscriberCount(), 0)
})

test('an idle connection gets a keep-alive comment on the heartbeat interval (it is what keeps a tunnel from closing it)', async () => {
  const app = new Hono()
  registerEventsRoutes(app, { bus: new EventBus(5), heartbeatMs: 20 })
  const ac = new AbortController()
  const res = await app.request('/api/v1/events', { signal: ac.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 2000
  while (!text.includes(': keep-alive') && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 100))])
    if (next && next.value) text += decoder.decode(next.value)
  }
  ac.abort()
  await reader.cancel().catch(() => {})
  assert.match(text, /: keep-alive\n\n/, 'no keep-alive arrived within 2 s at a 20 ms interval')
})
