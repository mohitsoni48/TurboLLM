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

// The 409 fallback used to reattach at run.event_seq without re-reading the message and with
// no signal to the caller, so the frames between the cursor (5) and the reattach point (100)
// silently became a hole in the rendered text — and this test counted that as success. The server
// asks the client to re-read the message, then attach; `resyncMessage` carries it to the caller.
test('resume() past the replay window re-reads the message and hands it back as resyncMessage', async () => {
  const seenUrls: string[] = []
  let streamCalls = 0
  let runGets = 0
  const fakeFetch: typeof fetch = (async (url: string) => {
    const u = String(url)
    seenUrls.push(u)
    if (u.includes('/stream')) {
      if (++streamCalls === 1) {
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
    if (u.includes('/messages/')) {
      return new Response(
        JSON.stringify({ id: 'm1', chat_id: 'c1', seq: 2, role: 'assistant', content: 'text so far', status: 'streaming', version: 3, created_at: 't', edited: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // The run moves on between reads: only the event_seq read AFTER the message is a safe
    // reattach point (the message can trail it, never lead it).
    const eventSeq = ++runGets === 1 ? 90 : 100
    return new Response(
      JSON.stringify({ id: 'run_1', chat_id: 'c1', message_id: 'm1', status: 'streaming', event_seq: eventSeq, error: null, created_at: 't', ended_at: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: fakeFetch })
  const resumed = await client.resume('run_1', 5, { owner: 'user_123' })
  assert.equal(resumed.resyncMessage?.content, 'text so far', 'the caller must get the re-read message to re-render from')
  const seen: string[] = []
  for await (const ev of resumed) seen.push(ev.event)
  assert.deepEqual(seen, ['delta', 'done'])
  assert.equal(resumed.lastEventSeq, 102)
  // Probe, runs.get (for the message id), messages.get, runs.get again, then the stream after
  // the event_seq read AFTER the message.
  assert.equal(seenUrls.length, 5, `expected probe, runs.get, messages.get, runs.get, stream; got ${seenUrls.join(' | ')}`)
  assert.ok(seenUrls[2].includes('/messages/m1'), `the run's own message is re-read: ${seenUrls[2]}`)
  // The lost frames include reasoning and tool calls; without include= the server leaves them out.
  assert.ok(seenUrls[2].includes(`include=${encodeURIComponent('reasoning,tool_calls')}`), `heavy fields are asked for: ${seenUrls[2]}`)
  assert.ok(/\/runs\/run_1\?/.test(seenUrls[3]), `the run is re-read after the message: ${seenUrls[3]}`)
  assert.ok(seenUrls[4].includes('/stream') && seenUrls[4].includes('after=100'), `reattaches after the event_seq read last: ${seenUrls[4]}`)
  // Release-gate I5: every one of these is owner-scoped server-side.
  for (const u of seenUrls) assert.ok(u.includes('owner=user_123'), `expected owner=user_123 in ${u}`)
})

// Reading the message first means a run that ends between the two reads leaves a checkpoint that
// trails event_seq with no later frame to fill the gap; the message is final by then, so re-read it.
test('resume() past the replay window re-reads the final message when the run ended in between', async () => {
  let messageGets = 0
  const fakeFetch: typeof fetch = (async (url: string) => {
    const u = String(url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/stream?')) {
      if (u.includes('after=5')) return json({ error: { type: 'conflict', code: 'replay_window_exceeded', message: 'aged out', retryable: false } }, 409)
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (u.includes('/messages/')) {
      const content = ++messageGets === 1 ? 'text so' : 'text so far, all of it'
      const heavy = u.includes(`include=${encodeURIComponent('reasoning,tool_calls')}`) ? { reasoning: `thought ${messageGets}`, tool_calls: [] } : {}
      return json({ id: 'm1', chat_id: 'c1', seq: 2, role: 'assistant', content, status: 'complete', version: 3, created_at: 't', edited: false, ...heavy })
    }
    return json({ id: 'run_1', chat_id: 'c1', message_id: 'm1', status: 'complete', event_seq: 120, error: null, created_at: 't', ended_at: 't2' })
  }) as unknown as typeof fetch

  const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: fakeFetch })
  const resumed = await client.resume('run_1', 5)
  assert.equal(resumed.resyncMessage?.content, 'text so far, all of it')
  assert.equal(resumed.resyncMessage?.reasoning, 'thought 2', 'the final re-read carries the reasoning too')
})

// No `done` frame follows an ended run's event_seq, so the outcome has to come from the run record
// resume() already read: the in-memory run's stream is empty, and once the daemon has dropped the
// run (pruned after an hour, or restarted) attaching only 409s again.
for (const [label, afterAttach] of [
  ['still in memory', () => new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })],
  ['dropped by the daemon', () => new Response(
    JSON.stringify({ error: { type: 'conflict', code: 'replay_window_exceeded', message: 'aged out', retryable: false } }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  )],
] as const) {
  test(`resume() past the replay window of a run that already ended (${label}) reports the run's outcome`, async () => {
    const fakeFetch: typeof fetch = (async (url: string) => {
      const u = String(url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (u.includes('/stream?')) {
        if (u.includes('after=5')) return json({ error: { type: 'conflict', code: 'replay_window_exceeded', message: 'aged out', retryable: false } }, 409)
        return afterAttach()
      }
      if (u.includes('/messages/')) {
        return json({ id: 'm1', chat_id: 'c1', seq: 2, role: 'assistant', content: 'partial', status: 'failed', version: 3, created_at: 't', edited: false })
      }
      return json({ id: 'run_1', chat_id: 'c1', message_id: 'm1', status: 'failed', event_seq: 120, error: { type: 'engine', code: 'daemon_restarted', message: 'restarted' }, created_at: 't', ended_at: 't2' })
    }) as unknown as typeof fetch

    const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: fakeFetch })
    const resumed = await client.resume('run_1', 5)
    const seen: string[] = []
    for await (const ev of resumed) seen.push(ev.event)
    assert.deepEqual(seen, [])
    assert.equal(resumed.outcome, 'failed', 'the run record is the source of truth once no done frame can arrive')
    assert.equal(resumed.resyncMessage?.content, 'partial')
  })
}

test('resume() within the window streams directly and leaves resyncMessage unset; no afterSeq omits after', async () => {
  const seenUrls: string[] = []
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async (url: string) => {
      seenUrls.push(String(url))
      return new Response('id: 3\nevent: done\ndata: {"status":"complete"}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof fetch,
  })
  const resumed = await client.resume('run_1', 2)
  for await (const _ of resumed) { /* drain */ }
  assert.equal(resumed.resyncMessage, undefined)
  assert.equal(resumed.outcome, 'complete')
  assert.ok(seenUrls[0].includes('after=2'))
  await client.resume('run_1', undefined)
  assert.ok(!seenUrls[1].includes('after='), `no cursor yet means replay from the start: ${seenUrls[1]}`)
})

// A resumed stream started with lastEventSeq undefined, so one that dropped before its first
// frame handed the next resume() no cursor, and that resume replayed the run from the start.
test('a resumed stream that drops before its first frame keeps the cursor it resumed from', async () => {
  const seenUrls: string[] = []
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async (url: string) => {
      seenUrls.push(String(url))
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof fetch,
  })
  const resumed = await client.resume('run_1', 5)
  for await (const _ of resumed) { /* dropped: no frame at all */ }
  assert.equal(resumed.outcome, 'unknown')
  assert.equal(resumed.lastEventSeq, 5)
  const again = await client.resume('run_1', resumed.lastEventSeq)
  for await (const _ of again) { /* drain */ }
  assert.ok(seenUrls[1].includes('after=5'), `the chained resume must not replay from the start: ${seenUrls[1]}`)

  const attached = client.runs.stream('run_1', 7)
  for await (const _ of attached) { /* drain */ }
  assert.equal(attached.lastEventSeq, 7, 'runs.stream(id, after) starts from its cursor too')
})

/** A fetch stub whose SSE body is a real ReadableStream the test controls. */
function controlledSse(): { fetch: typeof fetch; ctrl: Promise<ReadableStreamDefaultController<Uint8Array>>; cancelled: Promise<void> } {
  let resolveCtrl!: (c: ReadableStreamDefaultController<Uint8Array>) => void
  let resolveCancelled!: () => void
  const ctrl = new Promise<ReadableStreamDefaultController<Uint8Array>>((r) => { resolveCtrl = r })
  const cancelled = new Promise<void>((r) => { resolveCancelled = r })
  const body = new ReadableStream<Uint8Array>({
    start(c) { resolveCtrl(c) },
    cancel() { resolveCancelled() },
  })
  const fetchStub = (async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch
  return { fetch: fetchStub, ctrl, cancelled }
}

// A dropped connection made `reader.read()` reject, and that TypeError escaped the caller's
// `for await` — so the README's "check outcome === 'unknown', then reconcile" code never ran.
test('a connection that drops mid-stream ends the loop with outcome unknown instead of throwing', async () => {
  const sse = controlledSse()
  const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: sse.fetch })
  const stream = client.send('c1', { content: 'hi', owner: 'u1' })
  const c = await sse.ctrl
  const enc = new TextEncoder()
  c.enqueue(enc.encode('event: run\ndata: {"run_id":"run_1"}\n\nid: 0\nevent: delta\ndata: {"content":"a"}\n\nid: 1\nevent: del'))
  setTimeout(() => c.error(new TypeError('terminated')), 10)

  const seen: string[] = []
  for await (const ev of stream) seen.push(ev.event)
  assert.deepEqual(seen, ['run', 'delta'], 'frames before the drop are delivered; the cut-off partial frame is not')
  assert.equal(stream.outcome, 'unknown')
  assert.equal(stream.runId, 'run_1')
  assert.equal(stream.lastEventSeq, 0)
})

// Breaking out of the loop returned the generator without cancelling the reader, so the
// HTTP response stayed open and kept receiving frames for the rest of the generation.
test('breaking out of the loop early cancels the response body', async () => {
  const sse = controlledSse()
  const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: sse.fetch })
  const stream = client.send('c1', { content: 'hi', owner: 'u1' })
  const c = await sse.ctrl
  c.enqueue(new TextEncoder().encode('id: 0\nevent: delta\ndata: {"content":"a"}\n\n'))
  for await (const _ of stream) break
  const outcome = await Promise.race([sse.cancelled.then(() => 'cancelled'), new Promise((r) => setTimeout(() => r('still open'), 200))])
  assert.equal(outcome, 'cancelled')
})

test('runs.get/list/cancel/stream all forward owner as a query param', async () => {
  const seenUrls: string[] = []
  const fakeFetch: typeof fetch = (async (url: string) => {
    seenUrls.push(String(url))
    return new Response(
      JSON.stringify({ id: 'run_1', chat_id: 'c1', message_id: 'm1', status: 'complete', event_seq: 1, error: null, created_at: 't', ended_at: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  const client = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: fakeFetch })

  await client.runs.get('run_1', { owner: 'user_123' })
  await client.runs.cancel('run_1', { owner: 'user_123' })
  client.runs.stream('run_1', 5, { owner: 'user_123' })
  await new Promise((r) => setTimeout(r, 0))   // let the stream's fire-and-forget raw() call land

  assert.equal(seenUrls.length, 3)
  for (const u of seenUrls) assert.ok(u.includes('owner=user_123'), `expected owner=user_123 in ${u}`)
})

test('runs.list() forwards owner as a query param', async () => {
  let seenUrl = ''
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async (url: string) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch,
  })
  await client.runs.list({ owner: 'user_123' })
  assert.ok(seenUrl.includes('owner=user_123'), `expected owner=user_123 in ${seenUrl}`)
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

// The fetch promise was awaited only by the iterator, so a fetch that failed (daemon down) while
// the caller awaited something else before its `for await` was an unhandled rejection: Node kills
// the process (node:test fails the file) and the caller's try/catch around the loop never runs.
test('a fetch that fails before the caller starts iterating is thrown by the loop, not left unhandled', async () => {
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
  })
  const sent = client.send('c1', { content: 'hi', owner: 'u1' })
  const attached = client.runs.stream('run_1', 3)
  await new Promise((r) => setTimeout(r, 50))   // e.g. recording the pending send
  for (const stream of [sent, attached]) {
    await assert.rejects(async () => { for await (const _ of stream) { /* never */ } }, /fetch failed/)
  }
})

// Only send()'s stream gets a `run` frame, so a stream from resume()/runs.stream() had runId
// undefined and the second resume of a reconnect loop asked for /runs/undefined/stream (404).
test('streams from resume() and runs.stream() carry the run id, so resume() can be chained', async () => {
  const seenUrls: string[] = []
  let call = 0
  const client = new TurboLLMChat({
    baseUrl: 'http://x/api/ext/v1', apiKey: 'k',
    fetch: (async (url: string) => {
      const u = String(url)
      seenUrls.push(u)
      if (!u.includes('/stream') && !u.includes('/chats/')) {
        return new Response(
          JSON.stringify({ id: 'run_1', chat_id: 'c1', message_id: 'm1', status: 'complete', event_seq: 9, error: null, created_at: 't', ended_at: 't2' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (u.includes('after=99')) {
        return new Response(
          JSON.stringify({ error: { type: 'conflict', code: 'replay_window_exceeded', message: 'aged out', retryable: false } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        )
      }
      // Each attach drops after one frame (send's stream also gets its run frame).
      call++
      const run = u.includes('/chats/') ? 'event: run\ndata: {"run_id":"run_1","message_id":"m1"}\n\n' : ''
      return new Response(`${run}id: ${call}\nevent: delta\ndata: {"delta":"x"}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof fetch,
  })
  let stream = client.send('c1', { content: 'hi', owner: 'u1' })
  for (let round = 0; round < 3; round++) {
    for await (const _ of stream) { /* drain */ }
    assert.equal(stream.runId, 'run_1', `round ${round}: runId`)
    stream = await client.resume(stream.runId!, stream.lastEventSeq, { owner: 'u1' })
  }
  assert.ok(!seenUrls.some((u) => u.includes('undefined')), seenUrls.join(' | '))
  assert.equal(stream.runId, 'run_1', 'the within-window resume() stream')
  assert.equal(client.runs.stream('run_1', 2).runId, 'run_1')
  // resume() past the window, run already ended: the empty stream keeps the id as well.
  const ended = await client.resume('run_1', 99, { owner: 'u1' })
  assert.equal(ended.outcome, 'complete')
  assert.equal(ended.runId, 'run_1')
})

// raw() called `this.doFetch(...)`, so fetch ran as a method of the client. A browser's
// window.fetch and a Cloudflare Worker's fetch throw TypeError 'Illegal invocation' when `this`
// is neither the global object nor undefined: every call of a client built without
// options.fetch failed there, and so did one given `fetch: window.fetch`. The stub below
// refuses the same way.
test('fetch, the global one or options.fetch, is never called with the client as this', async () => {
  const seenThis: unknown[] = []
  const strictFetch = async function (this: unknown) {
    seenThis.push(this)
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), { status: 200 })
  } as unknown as typeof fetch
  const realFetch = globalThis.fetch
  globalThis.fetch = strictFetch
  try {
    const byDefault = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k' })
    assert.deepEqual(await byDefault.chats.list(), { data: [], has_more: false, next_cursor: null })
    const events = byDefault.runs.stream('run_1', 0)
    for await (const _ of events) { /* the JSON body has no frames */ }
  } finally {
    globalThis.fetch = realFetch
  }
  const given = new TurboLLMChat({ baseUrl: 'http://x/api/ext/v1', apiKey: 'k', fetch: strictFetch })
  await given.chats.list()
  assert.equal(seenThis.length, 3)
  assert.ok(seenThis.every((t) => !(t instanceof TurboLLMChat)), 'fetch was called as a method of the client')
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

// Type-level check, as above: SendParams.role was MessageRole, so send() took role 'assistant'
// at compile time although the server refuses any role but 'user' on a turn that starts a run
// (400 invalid_input). An assistant turn is appended with messages.append(), which takes either.
test("SendParams takes only role 'user'; AppendMessageInput still takes 'assistant'", () => {
  // @ts-expect-error a turn that starts a run must be role user
  const assistantTurn: SendParams = { owner: 'u1', role: 'assistant', content: 'an earlier reply' }
  const appendInput: AppendMessageInput = { owner: 'u1', role: 'assistant', content: 'an earlier reply' }
  const userTurn: SendParams = { owner: 'u1', role: 'user', content: 'next' }
  assert.equal(assistantTurn.role, appendInput.role)
  assert.equal(userTurn.role, 'user')
})
