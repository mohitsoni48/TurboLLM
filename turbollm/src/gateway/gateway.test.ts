// gateway.ts — helpers shared with the Jev endpoints module (architecture §2.6 "Exports"):
// describeEngineError and clientAbort are exported for /v1/classify with their bodies unchanged,
// so these tests pin today's behaviour through the new export.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientAbort, describeEngineError } from './gateway'

test('describeEngineError reads the OpenAI-shaped error message an engine returns', async () => {
  const res = new Response(JSON.stringify({ error: { message: 'bad input' } }), { status: 400 })
  assert.equal((await describeEngineError(res)).message, 'bad input')
})

test('describeEngineError falls back to a plain-text body as-is', async () => {
  const res = new Response('model crashed while loading', { status: 500 })
  assert.equal((await describeEngineError(res)).message, 'model crashed while loading')
})

test('describeEngineError names the status when the body is empty', async () => {
  assert.equal((await describeEngineError(new Response('', { status: 502 }))).message, 'Engine returned HTTP 502.')
})

test('clientAbort is already aborted when the client left before the call', () => {
  const left = new AbortController()
  left.abort()
  const raw = new Request('http://gateway.invalid/v1/classify', { method: 'POST', signal: left.signal })
  assert.equal(clientAbort({ req: { raw } }).signal.aborted, true)
})

test('clientAbort aborts later, when the client disconnects mid-request', () => {
  const client = new AbortController()
  const raw = new Request('http://gateway.invalid/v1/classify', { method: 'POST', signal: client.signal })
  const upstream = clientAbort({ req: { raw } })
  assert.equal(upstream.signal.aborted, false)
  client.abort()
  assert.equal(upstream.signal.aborted, true)
})
