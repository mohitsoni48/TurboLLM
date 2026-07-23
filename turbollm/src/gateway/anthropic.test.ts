// Gateway translation tests: the max-tokens clamp, and the live-progress wiring on
// the Anthropic stream translator (prefill % + token count published to the engine
// card, with prompt_progress chunks consumed rather than forwarded to the client).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampMaxTokens } from '../config/config'
import { mapToOpenAI, streamToAnthropic, type LiveProgress } from './anthropic'

// ── clampMaxTokens ──────────────────────────────────────────────────────────

test('clampMaxTokens: limit 0 (unlimited) leaves the request untouched', () => {
  assert.equal(clampMaxTokens(5000, 0), 5000)
  assert.equal(clampMaxTokens(undefined, 0), undefined)
})

test('clampMaxTokens: caps a larger request down to the limit', () => {
  assert.equal(clampMaxTokens(32000, 4096), 4096)
})

test('clampMaxTokens: keeps a smaller request as-is', () => {
  assert.equal(clampMaxTokens(1000, 4096), 1000)
})

test('clampMaxTokens: no request value falls back to the limit', () => {
  assert.equal(clampMaxTokens(undefined, 4096), 4096)
  assert.equal(clampMaxTokens(0, 4096), 4096)
})

// ── mapToOpenAI injects return_progress when streaming ──────────────────────

test('mapToOpenAI sets return_progress only for streaming requests', () => {
  const streamed = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, stream: true })
  assert.equal(streamed.return_progress, true)
  const nonStreamed = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 })
  assert.equal(nonStreamed.return_progress, undefined)
})

// ── mapToOpenAI forwards the extended-thinking budget ───────────────────────
// Regression coverage for a real bug (found + fully root-caused live 2026-07-23):
// mapToOpenAI never forwarded any thinking budget to thinking_budget_tokens (the
// field the engine's sampler actually reads — see chat-routes.ts's runGeneration for
// the same mechanism on the in-app chat path). With no budget forwarded, the local
// model reasoned unconstrained and could exhaust the entire max_tokens response on
// "thinking," leaving zero tokens for the actual answer — the request succeeds (200,
// valid stream) but the user sees no response at all.
//
// Captured from a REAL Claude Code request via temporary daemon-side logging:
// {"max_tokens":32000,"thinking":{"type":"adaptive","display":"omitted"},"stream":true}
// — note there is no `budget_tokens` at all, and `type` is `"adaptive"`, not the
// `"enabled"` this code originally (and wrongly) assumed was the only real shape.
// An adaptive/budget-less thinking request gets a conservative default (half of
// max_tokens) rather than being left unbounded — confirmed to fix the live repro
// (the exact request above, replayed against the real daemon, produced visible text
// after this fix; it produced nothing, twice in a row, before it).

test('mapToOpenAI forwards an explicit thinking.budget_tokens exactly, unchanged', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    thinking: { type: 'enabled', budget_tokens: 4096 },
  })
  assert.equal(oai.thinking_budget_tokens, 4096)
})

test('mapToOpenAI leaves thinking_budget_tokens unset when the caller sends no thinking field at all', () => {
  const oai = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 })
  assert.equal('thinking_budget_tokens' in oai, false)
})

test('mapToOpenAI defaults to half of max_tokens for adaptive thinking with no budget_tokens (the real Claude Code shape)', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    thinking: { type: 'adaptive', display: 'omitted' },
  })
  assert.equal(oai.thinking_budget_tokens, 16000)
})

test('mapToOpenAI defaults to half of max_tokens when thinking is enabled but budget_tokens is missing, zero, or negative', () => {
  const missing = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024, thinking: { type: 'enabled' } })
  assert.equal(missing.thinking_budget_tokens, 512)

  const zero = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 0 } })
  assert.equal(zero.thinking_budget_tokens, 512)

  const negative = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: -5 } })
  assert.equal(negative.thinking_budget_tokens, 512)
})

test('mapToOpenAI leaves thinking_budget_tokens unset when thinking is enabled but max_tokens is absent (nothing sane to default off of)', () => {
  const oai = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled' } })
  assert.equal('thinking_budget_tokens' in oai, false)
})

// ── mapToOpenAI maps a `role:'system'` entry inside `messages` correctly ────
// Regression coverage for a real bug (found + fully root-caused live 2026-07-23, via a
// captured real Claude Code request): Claude Code injects hook context (e.g. a
// SessionStart-hook block) as a `role:'system'` message directly inside `messages` —
// not just via the top-level `system` field. The per-message loop below only branched
// on `msg.role === 'user'`; anything else (including this system entry) fell into the
// assistant branch and got hardcoded to `role: 'assistant'`. That made the model see a
// conversation where the ASSISTANT had apparently already spoken (the hook-context
// text), so it treated its turn as already finished and emitted an immediate
// end-of-turn with zero content blocks — a real "no response" bug, not a timeout or
// crash. Replaying the exact captured request (2 messages: a user turn, then this
// system-role turn) against the fixed code produced a real thinking block + real text;
// against the pre-fix code it produced output_tokens:1 and no content blocks at all.
test('mapToOpenAI maps a mid-conversation role:"system" message to an OpenAI system message, not assistant', () => {
  const oai = mapToOpenAI({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [{ type: 'text', text: 'SessionStart hook additional context: ...' }] },
    ],
    max_tokens: 100,
  })
  const msgs = oai.messages as Array<{ role: string; content?: unknown }>
  const injected = msgs.find((m) => m.content === 'SessionStart hook additional context: ...')
  assert.ok(injected, 'the system-role message must appear in the mapped messages')
  assert.equal(injected!.role, 'system')
  assert.ok(
    !msgs.some((m) => m.role === 'assistant' && m.content === 'SessionStart hook additional context: ...'),
    'must NOT be relabeled as an assistant message',
  )
})

// ── streamToAnthropic live progress ─────────────────────────────────────────

/** Build a ReadableStream of OpenAI-style SSE bytes from raw line strings. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
      controller.close()
    },
  })
}

test('streamToAnthropic publishes prefill % then token counts, and never forwards prompt_progress', async () => {
  const upstream = sseStream([
    'data: {"prompt_progress":{"processed":50,"total":100}}',
    'data: {"prompt_progress":{"processed":100,"total":100}}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    'data: [DONE]',
  ])

  const live: LiveProgress[] = []
  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_1', undefined, (p) => live.push(p))) {
    events.push(evt)
  }

  // Prefill progress surfaced as a percent, then a running gen token count.
  assert.deepEqual(
    live.filter((p) => p.phase === 'prompt').map((p) => p.pct),
    [50, 100],
  )
  assert.deepEqual(
    live.filter((p) => p.phase === 'gen').map((p) => p.outputTokens),
    [1, 2],
  )

  // The client stream must NOT contain the internal prompt_progress chunks.
  const blob = events.map((e) => e.data).join('\n')
  assert.ok(!blob.includes('prompt_progress'), 'prompt_progress must be consumed, not forwarded')

  // The actual text still streamed through as Anthropic text_delta events.
  assert.ok(blob.includes('Hello') && blob.includes('world'))
})

// ── streamToAnthropic usage mapping ─────────────────────────────────────────

async function cacheReadFromTimings(timingsJson: string): Promise<number> {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    `data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50},"timings":${timingsJson}}`,
    'data: [DONE]',
  ])
  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_2')) events.push(evt)
  const delta = events.find((e) => e.event === 'message_delta')
  assert.ok(delta, 'message_delta event must be emitted')
  const parsed = JSON.parse(delta!.data) as { usage: { input_tokens: number; cache_read_input_tokens: number } }
  // input_tokens is the NON-cached remainder (prompt_tokens 100 − cache 20), not the
  // full prompt — Anthropic's usage fields are disjoint, so the cached prefix must not
  // be counted in both input_tokens and cache_read_input_tokens.
  assert.equal(parsed.usage.input_tokens, 80)
  return parsed.usage.cache_read_input_tokens
}

test('streamToAnthropic reads cache-reuse from `cache_n` (current llama.cpp field)', async () => {
  assert.equal(await cacheReadFromTimings('{"cache_n":20}'), 20)
})

test('streamToAnthropic still honors legacy `prompt_n_reuse` (older builds)', async () => {
  assert.equal(await cacheReadFromTimings('{"prompt_n_reuse":20}'), 20)
})

test('streamToAnthropic prefers `cache_n` over a stale `prompt_n_reuse`', async () => {
  assert.equal(await cacheReadFromTimings('{"cache_n":20,"prompt_n_reuse":0}'), 20)
})

test('streamToAnthropic emits cache_read_input_tokens: 0 when no timings field', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":30}}',
    'data: [DONE]',
  ])

  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_3')) {
    events.push(evt)
  }

  const delta = events.find((e) => e.event === 'message_delta')
  assert.ok(delta, 'message_delta event must be emitted')
  const parsed = JSON.parse(delta!.data) as { usage: { output_tokens: number; input_tokens: number; cache_read_input_tokens: number } }
  assert.equal(parsed.usage.output_tokens, 30)
  assert.equal(parsed.usage.input_tokens, 80)
  assert.equal(parsed.usage.cache_read_input_tokens, 0)
})
