// turbollm/src/chat/emit-sink.test.ts
//
// The sink seam (spec 27 §11.4): runGeneration must be drivable by something that is NOT a
// live Hono SSE stream, so the public API's detached runs can reuse the generation loop
// instead of becoming its THIRD copy (routines/chat-runner.ts was the second).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EmitSink } from './emit-sink.js'

test('a collecting sink receives structured data, not strings', async () => {
  const seen: Array<{ event: string; data: unknown }> = []
  const collect: EmitSink = (ev) => { seen.push(ev) }
  await collect({ event: 'reasoning', data: { reasoning: 'thinking' } })
  assert.deepEqual(seen[0].data, { reasoning: 'thinking' })
  assert.equal(typeof seen[0].data, 'object', 'a buffer sink must not receive pre-stringified JSON')
})
