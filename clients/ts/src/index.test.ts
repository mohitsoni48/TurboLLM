import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurboLLMChat } from './index.js'

/** A fetch stub returning a canned SSE body. */
function sseFetch(frames: string): typeof fetch {
  return (async () => new Response(frames, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })) as unknown as typeof fetch
}

test('send() yields typed events in order and ends on done', async () => {
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: sseFetch(
      'event: run\ndata: {"run_id":"run_1","message_id":"m1"}\n\n' +
      'id: 1\nevent: delta\ndata: {"content":"hi"}\n\n' +
      'id: 2\nevent: done\ndata: {"status":"complete"}\n\n',
    ),
  })
  const seen: string[] = []
  for await (const ev of client.send('c1', { content: 'hello', owner: 'u1' })) seen.push(ev.event)
  assert.deepEqual(seen, ['run', 'delta', 'done'])
})

test('the last seen event_seq is tracked so a caller can resume', async () => {
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: sseFetch('id: 7\nevent: delta\ndata: {"content":"x"}\n\nid: 8\nevent: done\ndata: {"status":"complete"}\n\n'),
  })
  const stream = client.send('c1', { content: 'hi', owner: 'u1' })
  for await (const _ of stream) { /* drain */ }
  assert.equal(stream.lastEventSeq, 8)
})

test('a stream that ends WITHOUT done is reported as unknown, not failed', async () => {
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: sseFetch('id: 1\nevent: delta\ndata: {"content":"partial"}\n\n'),
  })
  const stream = client.send('c1', { content: 'hi', owner: 'u1' })
  for await (const _ of stream) { /* drain */ }
  assert.equal(stream.outcome, 'unknown',
    'spec §7.3: a truncated stream means UNKNOWN — the run record is the source of truth')
})

test('an error response is thrown as a typed ApiError carrying type and code', async () => {
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async () => new Response(
      JSON.stringify({ error: { type: 'conflict', code: 'model_not_loaded', message: 'Load a model first.', retryable: true } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => client.chats.list(),
    (e: Error & { type?: string; code?: string; retryable?: boolean }) => {
      assert.equal(e.type, 'conflict')
      assert.equal(e.code, 'model_not_loaded')
      assert.equal(e.retryable, true)
      return true
    },
  )
})

test('the api key is sent as a bearer token and never in a query string', async () => {
  let seenUrl = ''
  let seenAuth = ''
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'secret-key',
    fetch: (async (url: string, init: RequestInit) => {
      seenUrl = String(url)
      seenAuth = new Headers(init.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  await client.chats.list()
  assert.equal(seenAuth, 'Bearer secret-key')
  assert.ok(!seenUrl.includes('secret-key'), 'a key in a URL leaks into logs and referrers')
})
