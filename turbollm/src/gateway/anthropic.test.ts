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

test('mapToOpenAI forwards an explicit thinking.budget_tokens exactly, unchanged, when it fits within half of max_tokens', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    thinking: { type: 'enabled', budget_tokens: 4096 },
  })
  assert.equal(oai.thinking_budget_tokens, 4096)
})

// Regression coverage for a real gap flagged by pre-release review (2026-07-23): a server-side
// maxTokens cap clamps req.max_tokens in gateway.ts BEFORE mapToOpenAI runs, but a client's
// explicit budget_tokens doesn't know about that cap. An explicit budget >= the (possibly
// clamped) max_tokens could reintroduce the exact "no response" bug this file's other tests
// guard against, just via the explicit-budget path instead of the no-budget default path.
test('mapToOpenAI clamps an explicit thinking.budget_tokens that exceeds half of max_tokens', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 24000 },
  })
  assert.equal(oai.thinking_budget_tokens, 2048)
})

test('mapToOpenAI forwards an explicit thinking.budget_tokens unclamped when max_tokens is absent', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 24000 },
  })
  assert.equal(oai.thinking_budget_tokens, 24000)
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

// ── mapToOpenAI folds every system-role text into ONE leading message ──────
// Regression for a real bug hit live (2026-07-29): a mid-conversation role:'system' message
// (fixed above to map correctly, not as 'assistant') was still emitted at its ORIGINAL position
// in `messages` — after the top-level `system` field's own message and after any user/assistant
// turns before it. That produced an array like [system, user, assistant, system, ...], which a
// strict jinja chat template (Qwen3.6/Ornith) rejects outright with a real 400: `Jinja Exception:
// System message must be at the beginning`. Every system-role text (the top-level `system` field
// AND any mid-conversation role:'system' entries) must fold into exactly one message at index 0.
test('mapToOpenAI folds a top-level system field + a mid-conversation system message into ONE leading system message', () => {
  const oai = mapToOpenAI({
    system: 'You are Claude Code.',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: [{ type: 'text', text: 'SessionStart hook additional context: ...' }] },
      { role: 'user', content: 'do the thing' },
    ],
    max_tokens: 100,
  })
  const msgs = oai.messages as Array<{ role: string; content?: unknown }>
  assert.equal(msgs.filter((m) => m.role === 'system').length, 1, 'exactly one system message must survive')
  assert.equal(msgs[0].role, 'system', 'the system message must be first — the whole point of the fix')
  assert.equal(msgs[0].content, 'You are Claude Code.\n\nSessionStart hook additional context: ...')
  assert.deepEqual(
    msgs.slice(1).map((m) => m.role),
    ['user', 'assistant', 'user'],
    'every other message keeps its original order and role, with the system entry removed from its old position',
  )
})

test('mapToOpenAI: a mid-conversation system message with no top-level system field still ends up first', () => {
  const oai = mapToOpenAI({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [{ type: 'text', text: 'hook context' }] },
    ],
    max_tokens: 100,
  })
  const msgs = oai.messages as Array<{ role: string; content?: unknown }>
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, 'hook context')
  assert.equal(msgs[1].role, 'user')
})

// ── mapToOpenAI strips JSON-Schema `format` from tool parameters ────────────
// Regression for a real bug hit live (2026-07-29): a Notion MCP tool's deeply-nested rich_text
// schema had a `date.start` field with `format: 'date'`. llama.cpp's JSON-schema-to-grammar
// converter has a bug for that format — it emits regex-style `\d` escapes GBNF doesn't support,
// which fails to parse and breaks tool-calling for the WHOLE request (a real 400: "Failed to
// initialize samplers: failed to parse grammar"), not just that one field. `format` must be
// stripped recursively — through nested `properties`, `items`, and `anyOf` — before forwarding
// any tool schema to the engine.
test('mapToOpenAI strips a top-level `format` keyword from a tool parameter schema', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [
      {
        name: 'set_date',
        input_schema: { type: 'object', properties: { day: { type: 'string', format: 'date' } } },
      },
    ],
  })
  const tools = oai.tools as Array<{ function: { parameters: Record<string, unknown> } }>
  const day = (tools[0].function.parameters.properties as Record<string, unknown>).day as Record<string, unknown>
  assert.equal('format' in day, false, 'format must be stripped, not just ignored')
  assert.equal(day.type, 'string', 'the rest of the schema must survive untouched')
})

test('mapToOpenAI strips `format` recursively through nested properties, arrays, and anyOf', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [
      {
        name: 'notion_create_comment',
        input_schema: {
          type: 'object',
          properties: {
            rich_text: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  mention: {
                    anyOf: [
                      { type: 'object', properties: { date: { type: 'object', properties: { start: { type: 'string', format: 'date' } } } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    ],
  })
  // Walk the exact same nested path a real Notion tool schema has and confirm no `format`
  // key survives anywhere in the tree — a JSON.stringify round-trip is the simplest whole-tree check.
  const tools = oai.tools as Array<{ function: { parameters: unknown } }>
  assert.equal(JSON.stringify(tools[0].function.parameters).includes('"format"'), false)
})

// ── mapToOpenAI ALSO strips `pattern` — the same failure class, a different keyword ────────
// `pattern` is an arbitrary caller-supplied regex, compiled into GBNF the same way `format` is —
// a strictly BIGGER risk than format's fixed conversions, since any construct a third-party
// tool's regex happens to use can fail the same way, via a different tool/field each time.
test('mapToOpenAI strips a `pattern` keyword from a tool parameter schema, nested or not', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [
      {
        name: 'set_phone',
        input_schema: {
          type: 'object',
          properties: {
            phone: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' },
            contact: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Z0-9]{8}$' } } },
          },
        },
      },
    ],
  })
  const tools = oai.tools as Array<{ function: { parameters: unknown } }>
  const serialized = JSON.stringify(tools[0].function.parameters)
  assert.equal(serialized.includes('"pattern"'), false, 'pattern must be stripped, nested or not')
  assert.ok(serialized.includes('"phone"'), 'the rest of the schema must survive untouched')
})

// ── mapToOpenAI strips the numeric/length/count BOUND keywords too ──────────────────────────
// A second, distinct grammar failure mode, root-caused from the engine's own dump of the failing
// grammar: llama.cpp compiles bound keywords into GBNF `{m,n}` repetition operators and giant
// digit-range rules, then refuses the grammar when rule-complexity × repetition trips its guard
// ("number of rules that are going to be repeated multiplied by the new repetition exceeds sane
// defaults"). The real failing request carried all three shapes asserted below.
test('mapToOpenAI strips bound keywords that llama.cpp compiles into {m,n} repetitions', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [
      {
        name: 'sync_assets',
        input_schema: {
          type: 'object',
          properties: {
            // `maxItems: 255` → `(item){0,255}` in GBNF
            assets: {
              type: 'array',
              maxItems: 255,
              minItems: 1,
              // `maxLength` → `char{1,255}`
              items: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 255 } } },
            },
            // `maximum: Number.MAX_SAFE_INTEGER` → ONE rule thousands of elements long
            offset: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
            ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.01 },
          },
        },
      },
    ],
  })
  const params = (oai.tools as Array<{ function: { parameters: unknown } }>)[0].function.parameters
  const serialized = JSON.stringify(params)

  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    assert.equal(serialized.includes(`"${keyword}"`), false, `${keyword} must be stripped, at any depth`)
  }
  // Structure — the part constrained decoding actually needs — must survive intact.
  assert.ok(serialized.includes('"assets"') && serialized.includes('"offset"') && serialized.includes('"ratio"'))
  assert.ok(serialized.includes('"array"') && serialized.includes('"integer"'), 'types must survive')
  assert.ok(serialized.includes('"items"') && serialized.includes('"name"'), 'nested shape must survive')
})

// Pre-release review catch (PR #86): the strip matched by key at EVERY depth, so a tool parameter
// whose NAME collides with a schema keyword was deleted along with the keyword. Claude Code's own
// Grep tool takes a required parameter literally named `pattern`, so this fired constantly and
// silently — the engine was handed a tool with no `pattern` argument that still required one.
test('mapToOpenAI keeps tool PARAMETERS whose name collides with a schema keyword (pattern/format/maximum)', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [{
      name: 'Grep',
      input_schema: {
        type: 'object',
        properties: {
          // Every one of these is a legitimate parameter NAME that is also a schema keyword.
          pattern: { type: 'string', description: 'regex', maxLength: 2000 },
          format: { type: 'string', enum: ['content', 'files'] },
          maximum: { type: 'integer', minimum: 0 },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    }],
  })
  const params = (oai.tools as Array<{ function: { parameters: { properties: Record<string, unknown>; required: string[] } } }>)[0].function.parameters

  assert.deepEqual(
    Object.keys(params.properties).sort(),
    ['format', 'maximum', 'path', 'pattern'],
    'a parameter must never be dropped because its NAME matches a schema keyword',
  )
  // The schema must not contradict itself: everything `required` names still has to exist.
  for (const name of params.required) {
    assert.ok(name in params.properties, `required "${name}" must still be defined`)
  }
  // …while the bound keywords INSIDE those parameters' own schemas are still stripped.
  const serialized = JSON.stringify(params)
  assert.equal(serialized.includes('"maxLength"'), false, 'pattern.maxLength must still be stripped')
  assert.equal(serialized.includes('"minimum"'), false, 'maximum.minimum must still be stripped')
  assert.ok(serialized.includes('"enum"'), 'enum inside a keyword-named parameter still survives')
})

test('mapToOpenAI keeps `enum`, which constrains decoding without emitting any repetition', () => {
  const oai = mapToOpenAI({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
    tools: [{ name: 'pick', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } } }],
  })
  const params = (oai.tools as Array<{ function: { parameters: unknown } }>)[0].function.parameters
  assert.ok(JSON.stringify(params).includes('"enum"'), 'enum is alternation, not repetition — keep it')
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

// ── streamToAnthropic: engine timings reach the usage callback (ADR-300) ─────
//
// This is the Claude Code path. It used to report tokens only, so everything downstream had to
// derive tok/s by dividing by the request's total wall-clock — which counts the OTHER phase's
// time against each rate and read decode ~6x low on a real agentic turn (763 tokens on a 62 s
// request → 12.3 tok/s, against the engine's measured ~78).

test('streamToAnthropic hands the engine\'s own prompt/gen rates to onUsage', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":152263,"completion_tokens":763},' +
      '"timings":{"prompt_per_second":2900.5,"predicted_per_second":77.95}}',
    'data: [DONE]',
  ])
  let usage: { inputTokens: number; outputTokens: number; promptTps?: number; genTps?: number } | null = null
  for await (const _ of streamToAnthropic(upstream, 'test-model', 'msg_tps', (u) => { usage = u })) { /* drain */ }

  assert.ok(usage, 'onUsage must fire')
  const u = usage as unknown as { inputTokens: number; outputTokens: number; promptTps?: number; genTps?: number }
  assert.equal(u.inputTokens, 152263)
  assert.equal(u.outputTokens, 763)
  assert.equal(u.promptTps, 2900.5)
  assert.equal(u.genTps, 77.95)
})

test('streamToAnthropic reports no rates at all when the engine sent none — never a fabricated 0', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    'data: [DONE]',
  ])
  let usage: { promptTps?: number; genTps?: number } | null = null
  for await (const _ of streamToAnthropic(upstream, 'test-model', 'msg_tps2', (u) => { usage = u })) { /* drain */ }

  assert.ok(usage)
  const u = usage as unknown as { promptTps?: number; genTps?: number }
  assert.equal(u.promptTps, undefined)
  assert.equal(u.genTps, undefined)
})

// ── streamToAnthropic tool-call observation (onToolCalls) ───────────────────
//
// The side channel gateway.ts uses to credit a terminal-agent Code session for the edits its CLI
// makes: the CLI applies them inside its own subprocess and never reports back, so this stream is
// the only place the daemon ever sees them. The engine splits one call across many deltas sharing
// a `tool_calls[].index` — `id`/`function.name` only on the first, `function.arguments` in
// fragments after it — so a call is only whole once the stream ends.

test('streamToAnthropic reassembles a tool call whose arguments arrive across several deltas', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Editing that file."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_01","function":{"name":"Edit","arguments":"{\\"file_path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/repo/a.ts\\",\\"old_string\\":\\"let x = 1\\""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"new_string\\":\\"const x = 2\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
    'data: [DONE]',
  ])

  let calls: { id: string; name: string; input: unknown }[] | null = null
  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_tools', undefined, undefined, (c) => { calls = c })) {
    events.push(evt)
  }

  assert.ok(calls, 'onToolCalls must fire')
  const observed = calls as unknown as { id: string; name: string; input: Record<string, string> }[]
  assert.equal(observed.length, 1)
  assert.equal(observed[0].id, 'toolu_01')
  assert.equal(observed[0].name, 'Edit', 'the name arrives only on the FIRST delta of the run and must survive the later ones')
  assert.deepEqual(observed[0].input, { file_path: '/repo/a.ts', old_string: 'let x = 1', new_string: 'const x = 2' })

  // Observation only — the client's own stream must be byte-for-byte what it was before: one
  // tool_use block started with the name, then the raw argument fragments as input_json_delta.
  const starts = events.filter((e) => e.event === 'content_block_start').map((e) => JSON.parse(e.data) as { content_block: { type: string; name?: string; id?: string } })
  assert.deepEqual(starts.map((s) => s.content_block.type), ['text', 'tool_use'])
  assert.equal(starts[1].content_block.name, 'Edit')
  const partials = events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => JSON.parse(e.data) as { delta: { type: string; partial_json?: string } })
    .filter((d) => d.delta.type === 'input_json_delta')
    .map((d) => d.delta.partial_json)
  assert.equal(partials.length, 3, 'each argument fragment is still forwarded unbuffered as it arrives')
  assert.equal(partials.join(''), '{"file_path":"/repo/a.ts","old_string":"let x = 1","new_string":"const x = 2"}')
})

test('streamToAnthropic keeps two tool calls in the same turn apart by their index', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_a","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/repo/"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"new.ts\\",\\"content\\":\\"hi\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"toolu_b","function":{"name":"Bash","arguments":"{\\"command\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"ls\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])

  let calls: { id: string; name: string; input: unknown }[] | null = null
  for await (const _ of streamToAnthropic(upstream, 'test-model', 'msg_tools2', undefined, undefined, (c) => { calls = c })) { /* drain */ }

  const observed = calls as unknown as { id: string; name: string; input: Record<string, string> }[]
  assert.deepEqual(observed.map((t) => [t.id, t.name]), [['toolu_a', 'Write'], ['toolu_b', 'Bash']])
  assert.deepEqual(observed[0].input, { file_path: '/repo/new.ts', content: 'hi' })
  assert.deepEqual(observed[1].input, { command: 'ls' })
})

// Fires with an EMPTY array rather than not firing at all: the observer's question is "did a real
// turn happen on this session", of which the tool calls are only one part — a text-only reply
// still counts (see recordCodeSessionToolCalls' optimistic 'done' marking).
test('streamToAnthropic still fires onToolCalls, with an empty list, for a turn with no tool calls', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"No tools needed."}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}',
    'data: [DONE]',
  ])
  let calls: unknown[] | null = null
  for await (const _ of streamToAnthropic(upstream, 'test-model', 'msg_notools', undefined, undefined, (c) => { calls = c })) { /* drain */ }
  assert.deepEqual(calls, [])
})

test('streamToAnthropic drops a tool call whose argument fragments never form valid JSON, keeping the rest', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_trunc","function":{"name":"Edit","arguments":"{\\"file_path\\":\\"/repo/a"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"toolu_ok","function":{"name":"Write","arguments":"{\\"file_path\\":\\"/repo/b.ts\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  let calls: { id: string }[] | null = null
  for await (const _ of streamToAnthropic(upstream, 'test-model', 'msg_trunc', undefined, undefined, (c) => { calls = c })) { /* drain */ }
  assert.deepEqual((calls as unknown as { id: string }[]).map((t) => t.id), ['toolu_ok'])
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
