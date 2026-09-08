// Unit coverage for the developer request log's pure ring-buffer logic (issue #211 follow-up).
// Route-level coverage (list/detail/stream/clear, auth, body gating over HTTP) lives in
// api/requests-routes.test.ts; capture-site coverage (gateway.ts / chat-upstream.ts actually
// populating entries) lives in gateway.request-log.test.ts and
// chat/chat-upstream.request-log.test.ts. This file only exercises RequestLog itself.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestLog, extractParams, summarizeRequest } from './request-log'

function draft(overrides: Partial<Parameters<RequestLog['start']>[0]> = {}) {
  return {
    source: 'openai' as const,
    harness: null,
    codeSessionId: null,
    modelKey: 'test-model',
    remote: null,
    stream: false,
    params: {},
    counts: { messages: 1, tools: 0, systemChars: 0 },
    ...overrides,
  }
}

test('RequestLog: start + finalize round-trip', () => {
  const log = new RequestLog()
  const id = log.start(draft({ params: { temperature: 0.7 } }))
  log.finalize(id, { status: 200, promptTokens: 10, completionTokens: 5, ttftMs: 12, durationMs: 340 })
  const [entry] = log.list()
  assert.equal(entry.status, 200)
  assert.equal(entry.tokens.prompt, 10)
  assert.equal(entry.tokens.completion, 5)
  assert.equal(entry.timings.ttftMs, 12)
  assert.deepEqual(entry.params, { temperature: 0.7 })
})

test('RequestLog: finalize on an evicted id is a no-op, not a throw', () => {
  const log = new RequestLog(1)
  const id = log.start(draft())
  log.start(draft()) // evicts the first entry (count cap = 1)
  assert.doesNotThrow(() => log.finalize(id, { status: 200 }))
  assert.equal(log.list().length, 1)
})

test('RequestLog: count cap evicts oldest first, most-recent-last ordering preserved', () => {
  const log = new RequestLog(3)
  const ids = [log.start(draft()), log.start(draft()), log.start(draft()), log.start(draft())]
  const rows = log.list()
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.id), ids.slice(1))
})

test('RequestLog: byte budget evicts oldest bodies before the count cap is hit', () => {
  const big = 'x'.repeat(1000)
  const log = new RequestLog(100, 2500) // ~2.5KB budget, well under the 100-entry count cap
  const id1 = log.start(draft({ requestBody: big } as never))
  log.finalize(id1, { status: 200, responseBody: big })
  const id2 = log.start(draft({ requestBody: big } as never))
  log.finalize(id2, { status: 200, responseBody: big })
  // Each entry holds ~2KB of body (1000+1000 bytes); the second entry alone is under budget,
  // but the first entry's bytes push the total over — it must be evicted.
  const rows = log.list({ bodies: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, id2)
})

test('RequestLog: bodies are null unless the caller opted in at start(), and list() strips them unless bodies:true', () => {
  const log = new RequestLog()
  const withBody = log.start(draft({ requestBody: '{"a":1}' } as never))
  const withoutBody = log.start(draft())
  log.finalize(withBody, { status: 200, responseBody: '{"b":2}' })
  log.finalize(withoutBody, { status: 200 })

  const stripped = log.list()
  assert.equal(stripped.find((e) => e.id === withBody)!.bodies, null)
  assert.equal(stripped.find((e) => e.id === withoutBody)!.bodies, null)

  const full = log.list({ bodies: true })
  assert.deepEqual(full.find((e) => e.id === withBody)!.bodies, { request: '{"a":1}', response: '{"b":2}' })
  assert.equal(full.find((e) => e.id === withoutBody)!.bodies, null)
})

test('RequestLog: filters by source, modelKey, status, since', () => {
  const log = new RequestLog()
  const a = log.start(draft({ source: 'openai', modelKey: 'm1' }))
  const b = log.start(draft({ source: 'anthropic', modelKey: 'm2' }))
  const c = log.start(draft({ source: 'chat', modelKey: 'm1' }))
  log.finalize(a, { status: 200 })
  log.finalize(b, { status: 500, error: { code: 'engine_error', message: 'boom' } })
  log.finalize(c, { status: 200 })

  assert.deepEqual(log.list({ source: 'anthropic' }).map((e) => e.id), [b])
  assert.deepEqual(log.list({ modelKey: 'm1' }).map((e) => e.id), [a, c])
  assert.deepEqual(log.list({ status: 'error' }).map((e) => e.id), [b])
  assert.deepEqual(log.list({ status: 'ok' }).map((e) => e.id), [a, c])

  // `since` is a strict `>` filter on ts (Date.now()-resolution, so same-millisecond entries
  // can tie) — assert the boundary cases rather than a specific millisecond split.
  const firstTs = log.get(a)!.ts
  assert.deepEqual(log.list({ since: firstTs - 1 }).map((e) => e.id), [a, b, c])
  assert.deepEqual(log.list({ since: Date.now() + 60_000 }), [])
})

test('RequestLog: clear() empties entries and resets the byte budget', () => {
  const log = new RequestLog()
  const id = log.start(draft({ requestBody: 'x'.repeat(500) } as never))
  log.finalize(id, { status: 200, responseBody: 'y'.repeat(500) })
  log.clear()
  assert.equal(log.list().length, 0)
  // After clear, a fresh large body should not be evicted by phantom leftover byte accounting.
  const id2 = log.start(draft({ requestBody: 'z'.repeat(500) } as never))
  log.finalize(id2, { status: 200, responseBody: 'w'.repeat(500) })
  assert.equal(log.list({ bodies: true })[0].bodies!.request.length, 500)
})

test('RequestLog: subscribe() fires on both start and finalize, unsubscribe stops delivery', () => {
  const log = new RequestLog()
  const seen: string[] = []
  const unsub = log.subscribe((e) => seen.push(`${e.id}:${e.status ?? 'pending'}`))
  const id = log.start(draft())
  log.finalize(id, { status: 200 })
  assert.deepEqual(seen, [`${id}:pending`, `${id}:200`])
  unsub()
  const id2 = log.start(draft())
  log.finalize(id2, { status: 200 })
  assert.deepEqual(seen, [`${id}:pending`, `${id}:200`]) // unchanged after unsubscribe
})

test('extractParams: whitelists known sampling params, drops everything else', () => {
  const params = extractParams({
    temperature: 0.8, top_p: 0.9, messages: [{ role: 'user', content: 'hi' }],
    stream: true, model: 'x', unknown_field: 'leak-me-not',
  })
  assert.deepEqual(params, { temperature: 0.8, top_p: 0.9 })
})

test('extractParams: tolerates a null/undefined body', () => {
  assert.deepEqual(extractParams(null), {})
  assert.deepEqual(extractParams(undefined), {})
})

test('summarizeRequest: counts messages, tools, and system-message chars', () => {
  const summary = summarizeRequest({
    messages: [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    tools: [{ type: 'function' }, { type: 'function' }],
  })
  assert.deepEqual(summary, { messages: 3, tools: 2, systemChars: 'be nice'.length })
})
