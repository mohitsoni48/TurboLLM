# @turbollm/chat-client

A zero-runtime-dependency TypeScript client for TurboLLM's public **External Chat API**
(`/api/ext/v1`; the daemon serves its OpenAPI document at `GET /api/ext/v1/openapi.json`). It
talks to the daemon over plain `fetch` and SSE — nothing here imports from `turbollm/src`, so it
can be published and consumed standalone.

It exists mainly to get one detail right automatically: the API's reconciliation rule. If a
stream closes without ever seeing a `done` frame, that is not a failure — it's *unknown*, and
the run record (`GET /runs/{id}`) is the source of truth. `RunStream` tracks this for you.

## Install

This package has no runtime dependencies and relies on the global `fetch` (Node 18+, or any
environment — browser, edge runtime — that ships one). Copy `src/` into your project, or once
published:

```bash
npm install @turbollm/chat-client
```

## Construct the client

```ts
import { TurboLLMChat } from '@turbollm/chat-client'

const client = new TurboLLMChat({
  baseUrl: 'http://127.0.0.1:6996/api/ext/v1', // your daemon's base URL (default port 6996) + /api/ext/v1
  apiKey: process.env.TURBOLLM_API_KEY!,       // a tllm-… key with a non-local tenant — server-side only, never in client JS
})
```

The API key is always sent as `Authorization: Bearer <key>` — never in a query string, so it
can't leak into logs, proxies, or the browser's own history.

## Create a chat and send a message

```ts
const chat = await client.chats.create({ owner: 'user_123', title: 'Quarterly analysis' })

for await (const ev of client.send(chat.id, { owner: 'user_123', content: 'Summarize this.' })) {
  switch (ev.event) {
    case 'run':
      console.log('run started', ev.data)
      break
    case 'delta':
      process.stdout.write((ev.data as { delta: string }).delta)
      break
    case 'done':
      console.log('\ndone:', (ev.data as { status: string }).status)
      break
  }
}
```

`send()` returns a `RunStream` — an `AsyncIterable<ExtEvent>` you can `for await` directly. It
also exposes, once the stream has been consumed:

- `stream.runId` — the run's id, from the `run` frame (a stream from `resume()` or
  `runs.stream()` carries the id it was attached to).
- `stream.lastEventSeq` — the highest `event_seq` seen (the SSE `id:` field), the resume token
  for `?after=` reconnects. `after` is exclusive: the server sends only the frames after it, so
  nothing you already rendered is sent twice. It is `undefined` until the first frame arrives (a
  stream from `resume()` or `runs.stream(id, after)` starts at the cursor it was attached from).
- `stream.outcome` — `'complete' | 'failed' | 'aborted'` from the `done` frame's `status`, or
  `'unknown'` if the connection closed before a `done` frame ever arrived. **`'unknown'` is not
  an error** — it means "ask the run", not "it failed." A connection that drops mid-stream ends
  the `for await` loop normally with `outcome === 'unknown'`; it does not throw.

Breaking out of the loop early closes the connection. That does not cancel the run; use
`runs.cancel` for that.

## Consuming a stream that got cut short

```ts
const stream = client.send(chat.id, { owner: 'user_123', content: 'Write a long story.' })
for await (const _ev of stream) { /* render tokens as they arrive */ }

if (stream.outcome === 'unknown' && stream.runId) {
  // Reconcile against the run record instead of guessing — the run may still be
  // streaming, or may have finished after the connection dropped. `owner` must match
  // whichever owner the run was created under (every run route is owner-scoped
  // server-side, same as chats/messages) — omitting it defaults to 'default'.
  const run = await client.runs.get(stream.runId, { owner: 'user_123' })
  console.log('actual status:', run.status)
}
```

Or skip the manual reconciliation and use `resume()`, which reattaches after the last known
`event_seq`. If the server reports `409 replay_window_exceeded` (the cursor aged out of the run's
in-memory replay buffer), the frames in between are gone. `resume()` then does what the server
asks: it re-reads the message, attaches at the run's current `event_seq`, and sets
`resyncMessage` on the returned stream. When it is set, replace your rendered text with it
instead of appending. It is read with `include: ['reasoning', 'tool_calls']`, so replace a
rendered reasoning view or tool calls from it too:

```ts
const resumed = await client.resume(stream.runId!, stream.lastEventSeq, { owner: 'user_123' })
if (resumed.resyncMessage) { /* replace your rendered text with resumed.resyncMessage.content */ }
for await (const ev of resumed) { /* continue rendering */ }
```

The message is checkpointed periodically while it streams, so `resyncMessage` can trail the
reattach point slightly. Once the run has ended, `messages.get` returns the final text. If the
run had already ended by then, `resyncMessage` is that final text, the returned stream yields no
frames, and its `outcome` is the run's own status.

## Handling errors

Every non-2xx response is thrown as an `ApiError`, carrying the parsed error envelope as typed
properties instead of a raw JSON body you'd have to re-parse:

```ts
import { ApiError } from '@turbollm/chat-client'

try {
  await client.chats.get('missing_id')
} catch (e) {
  if (e instanceof ApiError) {
    // e.type is one of the 9 frozen values: invalid_request | auth | not_found | conflict
    // | capacity | engine | storage | unsupported | internal
    // e.code is the open, precise reason (e.g. "model_not_loaded", "version_conflict")
    console.error(e.type, e.code, e.message, 'retryable:', e.retryable)
    if (e.retryable && e.retryAfterMs) {
      await new Promise((r) => setTimeout(r, e.retryAfterMs))
      // ...retry
    }
  }
}
```

## API surface

- `chats.list(opts?)`, `.create(input)`, `.get(id, opts?)`, `.update(id, patch)`, `.delete(id, opts?)`
- `messages.list(chatId, opts?)`, `.get(id, opts?)`, `.update(id, patch)`, `.delete(id, opts?)`,
  `.append(chatId, input)` — the `generate: false` path: appends a message with no run, for
  back-filling history without touching the GPU
- `runs.get(id, opts?)`, `.list(opts?)`, `.cancel(id, opts?)`, `.stream(runId, after?, opts?)` —
  every run route is owner-scoped server-side, so pass `{ owner }` here whenever the run wasn't
  created under the default owner
- `send(chatId, params)` — append a message and start a run, returning a `RunStream`
- `resume(runId, afterSeq?, opts?)` — reattach to an existing run after `afterSeq`, reconciling
  past the replay window (check `resyncMessage`); `opts.owner` must match the run's owner, same
  as the calls above

`chats.list` and `messages.list` return the cursor-paginated envelope `{ data, has_more,
next_cursor }` — pass `next_cursor` back in as `cursor` to page forward.
`runs.list` returns the runs as a plain array, and only the recent ones: the owner's newest 100
stored runs and any the daemon still holds in memory. The server does not page them, so an
older run is reachable only by id through `runs.get`.

## Testing

```bash
npm install
npm test        # tsx --test src/*.test.ts
npm run typecheck
```

The test suite injects a fake `fetch` (via the `fetch` constructor option) — no daemon needs to
be running to exercise this client's parsing and reconciliation logic.
