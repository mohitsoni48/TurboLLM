// turbollm/src/chat/emit-sink.test.ts
//
// The sink seam (spec 27 §11.4): runGeneration must be drivable by something that is NOT a
// live Hono SSE stream, so the public API's detached runs can reuse the generation loop
// instead of becoming its THIRD copy (routines/chat-runner.ts was the second).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sseSink, type EmitSink } from './emit-sink.js'

test('sseSink stringifies data and forwards the event name to writeSSE', async () => {
  const written: Array<{ event?: string; data: string }> = []
  const fake = { writeSSE: async (m: { event?: string; data: string }) => { written.push(m) } }
  const sink = sseSink(fake as never)

  await sink({ event: 'delta', data: { content: 'hi' } })
  await sink({ event: 'done', data: { status: 'complete' } })

  assert.equal(written.length, 2)
  assert.equal(written[0].event, 'delta')
  assert.deepEqual(JSON.parse(written[0].data), { content: 'hi' })
  assert.equal(written[1].event, 'done')
})

test('a collecting sink receives structured data, not strings', async () => {
  const seen: Array<{ event: string; data: unknown }> = []
  const collect: EmitSink = (ev) => { seen.push(ev) }
  await collect({ event: 'reasoning', data: { reasoning: 'thinking' } })
  assert.deepEqual(seen[0].data, { reasoning: 'thinking' })
  assert.equal(typeof seen[0].data, 'object', 'a buffer sink must not receive pre-stringified JSON')
})
