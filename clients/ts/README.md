# @turbollm/chat-client

A zero-runtime-dependency TypeScript client for TurboLLM's public **External Chat API**
(`/api/ext/v1`, [spec 27](../../docs/specs/27-external-chat-api.md)). It talks to the daemon
over plain `fetch` and SSE — nothing here imports from `turbollm/src`, so it can be published
and consumed standalone.

It exists mainly to get one detail right automatically: spec §7.3's reconciliation rule. If a
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
  baseUrl: 'http://localhost:11434/api/ext/v1', // your daemon's base URL + /api/ext/v1
  apiKey: process.env.TURBOLLM_API_KEY!,        // a tllm-ext-… key — server-side only, never in client JS
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
      process.stdout.write((ev.data as { content: string }).content)
      break
    case 'done':
      console.log('\ndone:', (ev.data as { status: string }).status)
      break
  }
}
```

`send()` returns a `RunStream` — an `AsyncIterable<ExtEvent>` you can `for await` directly. It
also exposes, once the stream has been consumed:

- `stream.runId` — the run's id, from the `run` frame.
- `stream.lastEventSeq` — the highest `event_seq` seen (the SSE `id:` field), the resume token
  for `?after=` reconnects.
- `stream.outcome` — `'complete' | 'failed' | 'aborted'` from the `done` frame's `status`, or
  `'unknown'` if the connection closed before a `done` frame ever arrived. **`'unknown'` is not
  an error** — it means "ask the run", not "it failed."

## Consuming a stream that got cut short

```ts
const stream = client.send(chat.id, { owner: 'user_123', content: 'Write a long story.' })
for await (const _ev of stream) { /* render tokens as they arrive */ }

if (stream.outcome === 'unknown' && stream.runId) {
  // Reconcile against the run record instead of guessing — the run may still be
  // streaming, or may have finished after the connection dropped.
  const run = await client.runs.get(stream.runId)
  console.log('actual status:', run.status)
}
```

Or skip the manual reconciliation and use `resume()`, which reattaches from the last known
`event_seq` and — per spec §7.3 — automatically falls back to `runs.get` + a fresh attach if the
server reports `409 replay_window_exceeded` (the cursor aged out of the run's in-memory replay
buffer):

```ts
const resumed = await client.resume(stream.runId!, stream.lastEventSeq ?? 0)
for await (const ev of resumed) { /* continue rendering */ }
```

## Handling errors

Every non-2xx response is thrown as an `ApiError`, carrying the parsed error envelope (spec
§7.1) as typed properties instead of a raw JSON body you'd have to re-parse:

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
- `runs.get(id)`, `.list()`, `.cancel(id)`, `.stream(runId, after?)`
- `send(chatId, params)` — append a message and start a run, returning a `RunStream`
- `resume(runId, afterSeq)` — reattach to an existing run, reconciling past the replay window
  automatically

All list endpoints return the cursor-paginated envelope `{ data, has_more, next_cursor }` (spec
§5.2) — pass `next_cursor` back in as `cursor` to page forward.

## Testing

```bash
npm install
npm test        # tsx --test src/*.test.ts
npm run typecheck
```

The test suite injects a fake `fetch` (via the `fetch` constructor option) — no daemon needs to
be running to exercise this client's parsing and reconciliation logic.
