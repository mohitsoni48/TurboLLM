import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUpstream, linkHeaders, proxyStream } from './link-proxy'

const remote = { linkId: 'l', baseUrl: 'https://h.trycloudflare.com', token: 'tllm-secret', modelKey: 'Qwen3' }

test('upstream targets the facade, not the raw gateway path', () => {
  assert.equal(
    buildUpstream(remote, '/v1/chat/completions'),
    'https://h.trycloudflare.com/api/link/v1/chat/completions',
  )
})

test('a base URL with a trailing slash does not produce a double slash', () => {
  assert.equal(
    buildUpstream({ ...remote, baseUrl: 'https://h/' }, '/v1/chat/completions'),
    'https://h/api/link/v1/chat/completions',
  )
})

// ── Invariant 7: the peer's own clients must never see the host's token, and the
// caller's credential must never be forwarded to a machine it was not issued for.
test('presents the LINK token and strips the caller credential', () => {
  const incoming = new Headers({
    'X-TurboLLM-Auth': 'callers-own-key',
    'x-api-key': 'anthropic-style-key',
    Authorization: 'Bearer some-other-key',
    'content-type': 'application/json',
  })
  const out = linkHeaders(remote, incoming)
  assert.equal(out.get('X-TurboLLM-Auth'), 'tllm-secret')
  assert.equal(out.get('x-api-key'), null)
  assert.equal(out.get('Authorization'), null)
  assert.equal(out.get('content-type'), 'application/json')
})

test('does not forward hop-by-hop or host headers', () => {
  const out = linkHeaders(remote, new Headers({ host: 'localhost:6996', connection: 'keep-alive' }))
  assert.equal(out.get('host'), null)
  assert.equal(out.get('connection'), null)
})

// ── Invariant 6: abort must reach the host, or it generates into a dead socket.
test('aborting the client signal aborts the upstream request', async () => {
  const ac = new AbortController()
  let upstreamAborted = false
  const fetchImpl = ((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
    init.signal?.addEventListener('abort', () => { upstreamAborted = true; rej(new Error('aborted')) })
  })) as unknown as typeof fetch
  const p = proxyStream(remote, '/v1/chat/completions', { method: 'POST' }, ac.signal, fetchImpl)
  ac.abort()
  await p.catch(() => {})
  assert.equal(upstreamAborted, true)
})

test('an already-aborted signal never issues the upstream request at all', async () => {
  const ac = new AbortController()
  ac.abort()
  let called = false
  const fetchImpl = (async () => { called = true; return new Response('') }) as unknown as typeof fetch
  await proxyStream(remote, '/v1/chat/completions', { method: 'POST' }, ac.signal, fetchImpl).catch(() => {})
  assert.equal(called, false)
})

test('the response body is passed through as a stream, not buffered', async () => {
  // Buffering would destroy the live t/s and TTFT the whole "first-class parity"
  // decision exists to deliver.
  const chunks = ['data: a\n\n', 'data: b\n\n']
  const body = new ReadableStream({
    start(ctrl) { for (const ch of chunks) ctrl.enqueue(new TextEncoder().encode(ch)); ctrl.close() },
  })
  const fetchImpl = (async () => new Response(body, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch
  const res = await proxyStream(remote, '/v1/chat/completions', { method: 'POST' }, undefined, fetchImpl)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  assert.ok(res.body instanceof ReadableStream)
})
