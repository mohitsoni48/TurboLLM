// Regression coverage for the OpenAI-protocol adapter that gives `pi`/`opencode`/DeepSeek Harness/
// `kilo`/`openclaw`/`hermes` the SAME agent scaffolding `claude` already had.
//
// The scaffolding was never agent-specific — it was PROTOCOL-specific, living only on
// /v1/messages. These tests pin the translation, because the whole value of the adapter is that
// the rules themselves are NOT duplicated: agent-guidance.ts's predicates run unchanged against a
// view of the OpenAI body. A drift between what those predicates expect and what the view produces
// would silently disable the rules for every OpenAI harness — which is exactly today's bug, and
// what this file exists to stop coming back.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOOP_ABORT_AFTER, LOOP_BREAK_AFTER } from '../code/agent-loop-rules'
import { analyzeTurn, trailingIdenticalCalls, trailingToolFailures } from './agent-guidance'
import {
  appendNudges,
  appendSystemRules,
  declaresTools,
  openAiRequestView,
  toolMessageIsError,
} from './openai-guidance'

/** An OpenAI assistant turn that calls one tool. `arguments` is a JSON STRING, as the wire format
 *  requires — the adapter parsing it is the thing under test. */
function assistantCall(name: string, args: unknown, id = 'call_1') {
  return { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}

function toolResult(content: string, tool_call_id = 'call_1', extra: Record<string, unknown> = {}) {
  return { role: 'tool', tool_call_id, content, ...extra }
}

// ── the view ────────────────────────────────────────────────────────────────

test('view maps assistant tool_calls to tool_use blocks with parsed input', () => {
  const view = openAiRequestView({ messages: [assistantCall('bash', { cmd: 'ls' })] })
  assert.equal(view.messages.length, 1)
  const blocks = view.messages[0].content
  assert.ok(Array.isArray(blocks))
  assert.deepEqual(blocks[0], { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' } })
})

test('view keeps an unparseable arguments string rather than dropping the call', () => {
  // toolCallSignature only needs a STABLE value to compare repetitions — dropping the call would
  // silently break loop detection for a client that streams malformed JSON.
  const view = openAiRequestView({
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'bash', arguments: '{oops' } }] }],
  })
  const blocks = view.messages[0].content as Array<{ input: unknown }>
  assert.equal(blocks[0].input, '{oops')
})

test('view maps a role:tool message onto a USER turn carrying tool_result', () => {
  // Load-bearing: trailingToolFailures and the nudge placement both scan USER messages. Mapping a
  // tool result to any other role would make both silently miss.
  const view = openAiRequestView({ messages: [toolResult('done')] })
  assert.equal(view.messages[0].role, 'user')
  const blocks = view.messages[0].content as Array<Record<string, unknown>>
  assert.equal(blocks[0].type, 'tool_result')
  assert.equal(blocks[0].tool_use_id, 'call_1')
})

test('view flattens array content parts to text', () => {
  const view = openAiRequestView({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  })
  assert.equal(view.messages[0].content, 'ab')
})

test('view reads tool names from both the wrapped and flattened shapes', () => {
  const view = openAiRequestView({
    tools: [{ type: 'function', function: { name: 'web_search' } }, { name: 'fetch_url' }],
  })
  assert.deepEqual(view.tools?.map((t) => t.name), ['web_search', 'fetch_url'])
})

test('view leaves tools undefined when none are declared', () => {
  assert.equal(openAiRequestView({ messages: [] }).tools, undefined)
})

// ── the is_error heuristic ───────────────────────────────────────────────────

test('an explicit is_error/error flag on the tool message wins over the text', () => {
  assert.equal(toolMessageIsError({ is_error: true, content: 'all good' }), true)
  assert.equal(toolMessageIsError({ error: true, content: 'all good' }), true)
  // An explicit false must NOT be second-guessed by the text heuristic.
  assert.equal(toolMessageIsError({ is_error: false, content: 'Error: nope' }), false)
})

test('the text fallback matches only a result that LEADS with a failure token', () => {
  assert.equal(toolMessageIsError({ content: 'Error: file not found' }), true)
  assert.equal(toolMessageIsError({ content: 'Traceback (most recent call last):' }), true)
  assert.equal(toolMessageIsError({ content: '  permission denied' }), true)
  // The plausible false positive: a Read that returns prose or source mentioning an error.
  assert.equal(toolMessageIsError({ content: 'Error handling is covered in section 4.' }), false)
  assert.equal(toolMessageIsError({ content: 'ok, wrote 3 files' }), false)
})

// ── the rules actually fire through the view ────────────────────────────────

test('loop detection counts identical OpenAI tool calls', () => {
  const messages = Array.from({ length: 3 }, (_, i) => assistantCall('bash', { cmd: 'ls' }, `c${i}`))
  const loop = trailingIdenticalCalls(openAiRequestView({ messages }).messages)
  assert.equal(loop?.name, 'bash')
  assert.equal(loop?.count, 3)
})

test('trailing failures are counted off role:tool messages', () => {
  const messages = [toolResult('Error: boom', 'a'), toolResult('Error: boom again', 'b')]
  assert.equal(trailingToolFailures(openAiRequestView({ messages }).messages), 2)
})

test('a repeated call at LOOP_BREAK_AFTER produces a nudge, not a tool block', () => {
  const messages = Array.from({ length: LOOP_BREAK_AFTER }, (_, i) => assistantCall('bash', { cmd: 'ls' }, `c${i}`))
  const g = analyzeTurn(openAiRequestView({ messages }))
  assert.equal(g.forceTextOnly, false)
  assert.ok(g.nudges.some((n) => n.includes('bash')))
})

test('a repeated call at LOOP_ABORT_AFTER forces text-only', () => {
  const messages = Array.from({ length: LOOP_ABORT_AFTER }, (_, i) => assistantCall('bash', { cmd: 'ls' }, `c${i}`))
  const g = analyzeTurn(openAiRequestView({ messages }))
  assert.equal(g.forceTextOnly, true)
})

test('standing rules name the OpenAI-style tool spellings the client actually declared', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], tools: [{ function: { name: 'web_search' } }, { function: { name: 'fetch_url' } }] }
  const g = analyzeTurn(openAiRequestView(body))
  const joined = g.system.join('\n')
  assert.ok(joined.includes('web_search'), 'should name web_search, not WebSearch')
  assert.ok(joined.includes('fetch_url'))
})

test('the routine hint reaches OpenAI clients too, and names the real origin', () => {
  const g = analyzeTurn(openAiRequestView({ messages: [{ role: 'user', content: 'hi' }] }), 'http://127.0.0.1:6996')
  assert.ok(g.system.some((s) => s.includes('http://127.0.0.1:6996/api/v1/routines')))
})

// ── declaresTools gate ──────────────────────────────────────────────────────

test('declaresTools distinguishes an agentic client from a plain chat app', () => {
  assert.equal(declaresTools({ tools: [{ function: { name: 'bash' } }] }), true)
  assert.equal(declaresTools({ tools: [] }), false)
  assert.equal(declaresTools({}), false)
})

// ── applying guidance back onto the real body ───────────────────────────────

test('system rules append to an EXISTING system message rather than inserting a new one', () => {
  // Keeps the engine's reusable prompt prefix one stable block, and some chat templates only
  // honour the first system message.
  const body: Record<string, unknown> = { messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'hi' }] }
  appendSystemRules(body, ['RULE'])
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 2)
  assert.equal(messages[0].content, 'base\n\nRULE')
})

test('system rules prepend a system message when the body has none', () => {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] }
  appendSystemRules(body, ['RULE'])
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, 'RULE')
})

test('no rules means the body is untouched', () => {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] }
  const before = JSON.stringify(body)
  appendSystemRules(body, [])
  appendNudges(body, [])
  assert.equal(JSON.stringify(body), before)
})

test('nudges append to a trailing user message', () => {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'do it' }] }
  appendNudges(body, ['[SYSTEM: stop]'])
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages[0].content, 'do it\n\n[SYSTEM: stop]')
})

test('nudges append to a trailing TOOL message as a plain string', () => {
  // A role:'tool' message with ARRAY content is rejected by some engines, so the text must be
  // concatenated rather than pushed as a block.
  const body: Record<string, unknown> = { messages: [toolResult('Error: boom')] }
  appendNudges(body, ['[SYSTEM: search]'])
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(typeof messages[0].content, 'string')
  assert.equal(messages[0].content, 'Error: boom\n\n[SYSTEM: search]')
})

test('nudges are SKIPPED on a trailing assistant message (client is prefilling a reply)', () => {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Sure, I' }] }
  appendNudges(body, ['[SYSTEM: stop]'])
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages[1].content, 'Sure, I')
  assert.equal(messages.length, 2)
})

test('nudges append as a text block when the user content is an array', () => {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  appendNudges(body, ['[SYSTEM: stop]'])
  const blocks = (body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[1], { type: 'text', text: '[SYSTEM: stop]' })
})
