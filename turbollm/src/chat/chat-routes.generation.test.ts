// Characterization of runGeneration's loop behaviors that no other chat-routes test pinned, written
// against the code BEFORE the loop moved into generation-core.ts (scalability tier 5, item 5.6), so
// the move is checked against what the loop did, not against what the core was meant to do.
//
// Covered here: the tool-round ceiling, a reply that is reasoning only (the BUG-001 extra pass),
// finish_reason 'length', the request body every round sends (sampling keys, the max_tokens cap,
// thinking and reasoning-effort fields), the usage ledger (recordCompletion, generationStart/End),
// the terminal write (the 'done' payload is the persisted row; the conversation is touched), and a
// fetch that throws (engine_stopped).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { runGeneration } from './chat-routes.js'
import { ChatRuns } from './chat-runs.js'
import { ChatTurns } from './chat-turns.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'
import { tmpDir } from '../test-support/tmp'

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown; tool_choice?: unknown }> }

interface Ledger {
  generationStarts: number
  generationEnds: number
  completions: Array<Record<string, unknown>>
  liveGens: Array<Record<string, unknown>>
  toolRuns: string[]
  touched: string[]
}

function mkHarness(cfgOver: { maxTokens?: number; toolPolicies?: Record<string, string> } = {}) {
  const dir = tmpDir('tllm-chat-generation-')
  const store = new ConversationStore(dir)
  const ledger: Ledger = { generationStarts: 0, generationEnds: 0, completions: [], liveGens: [], toolRuns: [], touched: [] }
  const touch = store.touchConversation.bind(store)
  store.touchConversation = (id: string) => { ledger.touched.push(id); touch(id) }
  const cfg = {
    modelDefaults: { maxTokens: cfgOver.maxTokens ?? 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: cfgOver.toolPolicies ?? {}, autoAllowAll: false },
  }
  const d = {
    chatTurns: new ChatTurns(), chatRuns: new ChatRuns(),
    db: store,
    store: { snapshot: () => cfg, read: () => cfg, dir: () => dir },
    scanner: { get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    tools: {
      buildToolDefinitions: async () => [{ type: 'function', function: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } } }],
      executeTool: async (call: { name: string }) => { ledger.toolRuns.push(call.name); return 'echoed' },
    },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'Test Model', ctx: 8192 } }),
      target: () => 'http://127.0.0.1:8081',
      currentOpts: () => null,
      generationStart: () => { ledger.generationStarts++ },
      generationEnd: () => { ledger.generationEnds++ },
      setLiveGen: (g: Record<string, unknown>) => { ledger.liveGens.push(g) },
      recordCompletion: (c: Record<string, unknown>) => { ledger.completions.push(c) },
    },
  } as unknown as Deps
  return { d, store, ledger, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

type Harness = ReturnType<typeof mkHarness>

function seed(h: Harness, convPatch: Record<string, unknown> = {}) {
  const conv = h.store.createConversation()
  if (Object.keys(convPatch).length) h.store.updateConversation(conv.id, convPatch as never)
  h.store.addMessage(conv.id, 'user', 'hi')
  h.store.addMessage(conv.id, 'assistant', '', { stats: { aborted: false } })
  h.ledger.touched.length = 0 // seeding touches it too; only the turn's own touches count
  return { conv: h.store.getConversation(conv.id, true)!, assistantMsg: h.store.getLastMessage(conv.id)! }
}

function ctxFor(seeded: ReturnType<typeof seed>, over: Record<string, unknown> = {}) {
  return {
    convId: seeded.conv.id,
    conv: seeded.conv,
    engineMessages: [{ role: 'user', content: 'hi' }],
    assistantMsg: seeded.assistantMsg,
    upstream: { modelField: 'm-alias', modelName: 'Test Model', ctxMax: 8192, target: 'http://127.0.0.1:8081' },
    ac: new AbortController(),
    thinkingBudget: -1,
    reasoningEffort: undefined,
    isCodeAuthorized: false,
    ...over,
  }
}

const sse = (...chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const content = (text: string) => ({ choices: [{ delta: { content: text } }] })
const finish = (reason: string, extra: Record<string, unknown> = {}) => ({ choices: [{ delta: {}, finish_reason: reason }], ...extra })
const toolCall = (id: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'echo', arguments: '{}' } }] } }] })

/** Answers each engine request with the next scripted SSE body (the last one repeats), and records every body sent. */
function scriptEngine(next: (n: number) => string): { bodies: Body[]; restore: () => void } {
  const original = globalThis.fetch
  const bodies: Body[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Body)
    return new Response(next(bodies.length), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = original } }
}

async function withHarness(h: Harness, engine: { restore: () => void }, body: () => Promise<void>): Promise<void> {
  try { await body() } finally { engine.restore(); h.cleanup() }
}

test('a model that calls a tool every round stops at the ceiling: 17 rounds, 16 tool runs, then the empty-reply pass', async () => {
  const h = mkHarness({ toolPolicies: { echo: 'allow' } })
  const engine = scriptEngine((n) => n <= 17 ? sse(toolCall(`call-${n}`), finish('tool_calls')) : sse(content('Final answer.'), finish('stop')))
  await withHarness(h, engine, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, () => {}, ctxFor(seeded) as never)
    assert.equal(engine.bodies.length, 18, '17 tool rounds (the 17th is not run) plus the BUG-001 pass')
    assert.equal(h.ledger.toolRuns.length, 16)
    const last = engine.bodies[17]
    assert.equal(last.tool_choice, 'none')
    assert.deepEqual(last.messages.at(-1), { role: 'user', content: 'Please now write your final answer based on what you found.' })
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'Final answer.')
    assert.equal(row.toolCalls?.length, 16)
    assert.deepEqual(row.toolCalls![0], { id: 'call-1', name: 'echo', args: {}, result: 'echoed' })
    // Round 2 carries round 1's call and its result.
    assert.deepEqual(engine.bodies[1].messages.slice(-2), [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{}' } }] },
      { role: 'tool', content: 'echoed', tool_call_id: 'call-1' },
    ])
  })
})

test('a reply that is reasoning only gets one extra pass with tool_choice none, whose text is the reply', async () => {
  const h = mkHarness()
  const engine = scriptEngine((n) => n === 1
    ? sse({ choices: [{ delta: { reasoning_content: 'thinking hard' } }] }, finish('stop'))
    : sse(content('The answer.'), finish('stop')))
  const events: string[] = []
  await withHarness(h, engine, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, (ev) => { events.push(ev.event) }, ctxFor(seeded) as never)
    assert.equal(engine.bodies.length, 2)
    assert.equal(engine.bodies[0].tool_choice, undefined)
    assert.equal(engine.bodies[1].tool_choice, 'none')
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'The answer.')
    assert.equal(row.reasoning, 'thinking hard')
    assert.equal(row.stats.aborted, false)
    assert.deepEqual(events, ['reasoning', 'delta', 'done'])
  })
})

test('finish_reason length ends the turn as a finished reply: saved whole, not aborted, no error', async () => {
  const h = mkHarness()
  const timings = { prompt_n: 20, prompt_ms: 10, prompt_per_second: 2000, predicted_n: 64, predicted_ms: 640, predicted_per_second: 100 }
  const engine = scriptEngine(() => sse(content('A reply that ran out of tokens'), finish('length', { usage: { prompt_tokens: 20, completion_tokens: 64 }, timings })))
  const events: Array<{ event: string; data: unknown }> = []
  await withHarness(h, engine, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, (ev) => { events.push(ev) }, ctxFor(seeded) as never)
    assert.equal(engine.bodies.length, 1)
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.content, 'A reply that ran out of tokens')
    assert.equal(row.stats.aborted, false)
    assert.equal(row.stats.genTokens, 64)
    assert.equal(row.stats.ctxUsed, 84)
    assert.equal(events.some((e) => e.event === 'error'), false)
    assert.equal(events.at(-1)?.event, 'done')
  })
})

test('every round sends the thread sampling under engine names, the capped max_tokens, stop strings and thinking fields', async () => {
  const h = mkHarness({ maxTokens: 4096 })
  const engine = scriptEngine(() => sse(content('ok'), finish('stop')))
  await withHarness(h, engine, async () => {
    const seeded = seed(h, { sampling: { temp: 0.5, repeatPenalty: 1.1, max_tokens: 9000, stop: ['END'], seed: 7 }, preserveThinking: true })
    await runGeneration(h.d, () => {}, ctxFor(seeded, { thinkingBudget: 0 }) as never)
    const b = engine.bodies[0]
    assert.equal(b.model, 'm-alias')
    assert.equal(b.stream, true)
    assert.deepEqual(b.stream_options, { include_usage: true })
    assert.equal(b.return_progress, true)
    assert.equal(b.temperature, 0.5)
    assert.equal(b.repeat_penalty, 1.1)
    assert.equal(b.seed, 7)
    assert.equal(b.max_tokens, 4096, 'the Settings cap wins over a larger thread max_tokens')
    assert.deepEqual(b.stop, ['END'])
    assert.equal(b.thinking_budget_tokens, 0)
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false, preserve_thinking: true })
  })
})

test('with no cap and no thread max_tokens none is sent; a reasoning effort goes in the template kwargs, off turns thinking off', async () => {
  const h = mkHarness()
  const engine = scriptEngine(() => sse(content('ok'), finish('stop')))
  await withHarness(h, engine, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, () => {}, ctxFor(seeded, { reasoningEffort: 'low', thinkingBudget: 512 }) as never)
    assert.equal('max_tokens' in engine.bodies[0], false)
    assert.equal(engine.bodies[0].thinking_budget_tokens, 512)
    // A new conversation preserves thinking by default (createConversation), so that rides along.
    assert.deepEqual(engine.bodies[0].chat_template_kwargs, { preserve_thinking: true, reasoning_effort: 'low' })
    await runGeneration(h.d, () => {}, ctxFor(seed(h), { reasoningEffort: 'off' }) as never)
    assert.equal(engine.bodies[1].thinking_budget_tokens, 0)
    assert.deepEqual(engine.bodies[1].chat_template_kwargs, { enable_thinking: false, preserve_thinking: true })
  })
})

test('a vLLM engine gets repetition_penalty and no tools', async () => {
  const h = mkHarness({ toolPolicies: { echo: 'allow' } })
  ;(h.d as unknown as { registry: unknown }).registry = { active: () => ({ kind: 'vllm', id: 'e1', capabilities: {} }) }
  const engine = scriptEngine(() => sse(content('ok'), finish('stop')))
  await withHarness(h, engine, async () => {
    const seeded = seed(h, { sampling: { repeatPenalty: 1.2 } })
    await runGeneration(h.d, () => {}, ctxFor(seeded) as never)
    assert.equal(engine.bodies[0].repetition_penalty, 1.2)
    assert.equal('repeat_penalty' in engine.bodies[0], false)
    assert.equal('tools' in engine.bodies[0], false)
  })
})

test('a finished turn records its numbers once in the engine ledger and balances generationStart/End', async () => {
  const h = mkHarness()
  const timings = { prompt_n: 30, prompt_ms: 15, prompt_per_second: 2000, predicted_n: 12, predicted_ms: 120, predicted_per_second: 100 }
  const engine = scriptEngine(() => sse({ prompt_progress: { processed: 30, total: 30 } }, content('Some streamed reply text, long enough to clear the parser lookahead'), finish('stop', { usage: { prompt_tokens: 30, completion_tokens: 12 }, timings })))
  await withHarness(h, engine, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, () => {}, ctxFor(seeded) as never)
    assert.equal(h.ledger.generationStarts, 1)
    assert.equal(h.ledger.generationEnds, 1)
    assert.deepEqual(h.ledger.completions, [{ inputTokens: 30, outputTokens: 12, promptTps: 2000, genTps: 100 }])
    assert.deepEqual(h.ledger.liveGens[0], { phase: 'prompt', pct: 100, outputTokens: 0 })
    assert.equal(h.ledger.liveGens.at(-1)?.phase, 'gen')
  })
})

test('the turn ends with one terminal write: done carries the persisted row, and the conversation is touched', async () => {
  const h = mkHarness()
  const engine = scriptEngine(() => sse(content('Hello there, friend.'), finish('stop')))
  const events: Array<{ event: string; data: unknown }> = []
  await withHarness(h, engine, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, (ev) => { events.push(ev) }, ctxFor(seeded) as never)
    const done = events.at(-1)!
    assert.equal(done.event, 'done')
    assert.deepEqual((done.data as { message: unknown }).message, h.store.getMessage(seeded.assistantMsg.id))
    assert.deepEqual(h.ledger.touched, [seeded.conv.id])
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.model, 'Test Model')
    assert.equal(row.stats.ctxMax, 8192)
  })
})

test('a fetch that throws ends the turn with engine_stopped, not aborted, and no measured context', async () => {
  const h = mkHarness()
  const original = globalThis.fetch
  globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  const events: Array<{ event: string; data: unknown }> = []
  await withHarness(h, { restore: () => { globalThis.fetch = original } }, async () => {
    const seeded = seed(h)
    await runGeneration(h.d, (ev) => { events.push(ev) }, ctxFor(seeded) as never)
    assert.deepEqual(events.map((e) => e.event), ['error', 'done'])
    assert.deepEqual(events[0].data, { code: 'engine_stopped', message: 'fetch failed' })
    const row = h.store.getMessage(seeded.assistantMsg.id)!
    assert.equal(row.stats.aborted, false)
    assert.equal('ctxUsed' in row.stats, false)
    assert.equal(h.ledger.generationEnds, 1)
  })
})
