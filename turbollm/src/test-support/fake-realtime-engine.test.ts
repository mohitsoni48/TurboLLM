// The fake llama-server /v1/realtime the spoken-reply tests run against: its `held` mode, which stops a reply after its
// first audio delta until the test releases the rest, so a test can act mid-reply with no clock involved.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { startFakeRealtimeEngine } from './fake-realtime-engine'

const require = createRequire(import.meta.url)

/** A client of the fake engine: every event type it was sent, and a way to wait for one. */
async function client(url: string) {
  const { WebSocket } = require('ws') as { WebSocket: new (url: string) => any }
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/realtime')
  const types: string[] = []
  const waiters: Array<{ type: string; resolve: () => void }> = []
  ws.on('message', (raw: Buffer) => {
    const type = (JSON.parse(String(raw)) as { type: string }).type
    types.push(type)
    for (const w of waiters.filter((x) => x.type === type)) w.resolve()
  })
  await new Promise<void>((resolve) => ws.on('open', resolve))
  const seen = (type: string) => (types.includes(type) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ type, resolve })))
  return { ws, types, seen, send: (o: unknown) => ws.send(JSON.stringify(o)) }
}

test('held mode stops after the first audio delta and sends the rest of the reply only when released', async (t) => {
  const engine = await startFakeRealtimeEngine({ mode: 'held' })
  t.after(() => engine.stop())
  const c = await client(engine.baseUrl)
  t.after(() => c.ws.terminate())
  await c.seen('session.created')
  c.send({ type: 'session.update', session: {} })
  await c.seen('session.updated')
  c.send({ type: 'response.create' })
  await c.seen('response.output_audio.delta')
  const audioBefore = c.types.filter((x) => x === 'response.output_audio.delta').length

  assert.equal(audioBefore, 1, 'only the first audio delta')
  assert.equal(c.types.includes('response.done'), false, 'the reply is held')

  engine.release()
  await c.seen('response.done')
  assert.ok(c.types.filter((x) => x === 'response.output_audio.delta').length > 1, 'the rest of the audio came after the release')
})
