import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurboLLMChat } from './index.js'
import type { AppendMessageInput, SendParams } from './index.js'

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

test('send() throws ApiError instead of silently yielding nothing on a pre-stream error', async () => {
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async () => new Response(
      JSON.stringify({ error: { type: 'conflict', code: 'model_not_loaded', message: 'Load a model first.', retryable: true } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch,
  })
  const stream = client.send('c1', { content: 'hi', owner: 'u1' })
  await assert.rejects(
    async () => { for await (const _ of stream) { /* should never get here */ } },
    (e: Error & { code?: string }) => { assert.equal(e.code, 'model_not_loaded'); return true },
  )
})

test('resume() reconciles past the replay window via runs.get()', async () => {
  let call = 0
  const fakeFetch: typeof fetch = (async (url: string) => {
    call++
    const u = String(url)
    if (u.includes('/stream')) {
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { type: 'conflict', code: 'replay_window_exceeded', message: 'aged out', retryable: false } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(
        'id: 101\nevent: delta\ndata: {"content":"resumed"}\n\n' +
        'id: 102\nevent: done\ndata: {"status":"complete"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
    return new Response(
      JSON.stringify({ id: 'run_1', chat_id: 'c1', message_id: 'm1', status: 'streaming', event_seq: 100, error: null, created_at: 't', ended_at: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: fakeFetch })
  const resumed = await client.resume('run_1', 5)
  const seen: string[] = []
  for await (const ev of resumed) seen.push(ev.event)
  assert.deepEqual(seen, ['delta', 'done'])
  assert.equal(resumed.lastEventSeq, 102)
})

test('messages.append() forwards attachments and metadata, matching send()/SendParams', async () => {
  let seenBody: Record<string, unknown> | undefined
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({ id: 'm1', chat_id: 'c1', seq: 1, role: 'user', content: 'hi', status: 'complete', version: 1, created_at: 't', edited: false }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch,
  })
  await client.messages.append('c1', {
    owner: 'u1', content: 'hi', attachments: ['data:text/plain;base64,aGk='], metadata: { source: 'import' },
  })
  assert.ok(seenBody, 'fetch was never called')
  assert.deepEqual(seenBody!.attachments, ['data:text/plain;base64,aGk='], 'append() must forward attachments, not silently drop them')
  assert.deepEqual(seenBody!.metadata, { source: 'import' }, 'append() must forward metadata, not silently drop it')
  assert.equal(seenBody!.generate, false)
})

// Type-level check (this suite has no dedicated compile-time-assertion harness, so a runtime
// construction that the TypeScript compiler must accept without `content` stands in for one —
// `npx tsc --noEmit` on this file is itself part of the type check: SendParams.content and
// AppendMessageInput.content must both be optional, matching the server's content-OR-attachments
// rule (an attachments-only message is valid and must not be forced to carry `content`).
test('SendParams and AppendMessageInput both compile and construct with content omitted', () => {
  const sendParams: SendParams = { owner: 'u1', attachments: ['data:text/plain;base64,aGk='] }
  const appendInput: AppendMessageInput = { owner: 'u1', attachments: ['data:text/plain;base64,aGk='] }
  assert.equal(sendParams.content, undefined)
  assert.equal(appendInput.content, undefined)
})
