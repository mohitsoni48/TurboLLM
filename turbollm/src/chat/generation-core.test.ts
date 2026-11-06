// The generation core's three port contracts, driven with a fake persistence port and a fake
// engine, and with NO `db` and NO `chatTurns` on Deps: any reach past the ports into the chat
// database or the chat turn registry is a TypeError here, not a silent write to the wrong store
// (ext/generation.ts's header, PERSISTENCE, is that bug).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runGenerationCore, type ApprovalPolicy, type FinalReply, type GenerationPersistence, type GenerationTurn, type ReplySnapshot } from './generation-core.js'
import type { Deps } from '../deps.js'
import type { EmitSink } from './emit-sink.js'

interface FakePersistence extends GenerationPersistence {
  progress: ReplySnapshot[]
  finals: FinalReply[]
  restoreCalls: number
  tracked: Array<() => void>
  untracked: number
}

function fakePersistence(opts: { restores?: boolean } = {}): FakePersistence {
  const p: FakePersistence = {
    progress: [], finals: [], restoreCalls: 0, tracked: [], untracked: 0,
    saveProgress: (reply) => { p.progress.push(structuredClone(reply)) },
    trackProgressSave: (save) => { p.tracked.push(save); return () => { p.untracked++ } },
    restoreUnproduced: () => { p.restoreCalls++; return opts.restores ?? false },
    finalize: (reply) => { p.finals.push(reply); return { id: 'reply-1', content: reply.content } },
  }
  return p
}

function approval(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return { interactive: false, isCodeAuthorized: false, refuseMcp: true, convOverrides: () => ({}), ...over }
}

interface FakeDeps { d: Deps; toolRuns: Array<{ name: string; isCodeAuthorized: boolean }>; settled: number }

function fakeDeps(cfg: { maxTokens?: number; toolPolicies?: Record<string, string>; engineKind?: string } = {}): FakeDeps {
  const toolRuns: FakeDeps['toolRuns'] = []
  const snapshot = {
    modelDefaults: { maxTokens: cfg.maxTokens ?? 0 },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: cfg.toolPolicies ?? {}, autoAllowAll: false, chatApprovalWaitMinutes: 0 },
  }
  const d = {
    store: { snapshot: () => snapshot, dir: () => '/data' },
    scanner: { get: () => undefined },
    registry: { active: () => ({ kind: cfg.engineKind ?? 'llama.cpp', id: 'e1', capabilities: {} }) },
    tools: {
      buildToolDefinitions: async () => [{ type: 'function', function: { name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} } } }],
      executeTool: async (call: { name: string }, isCodeAuthorized: boolean) => { toolRuns.push({ name: call.name, isCodeAuthorized }); return 'found it' },
    },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'Model', ctx: 4096 } }),
      currentOpts: () => null,
      generationStart: () => {}, generationEnd: () => {}, setLiveGen: () => {}, recordCompletion: () => {},
    },
  } as unknown as Deps
  return { d, toolRuns, settled: 0 }
}

function turnFor(over: Partial<GenerationTurn> = {}): GenerationTurn {
  return {
    convId: 'conv-1',
    conv: { id: 'conv-1', sampling: {}, preserveThinking: false },
    engineMessages: [{ role: 'user', content: 'hi' }],
    upstream: { modelField: 'm', modelName: 'Model', ctxMax: 4096, target: 'http://127.0.0.1:1', engineKind: over.upstream?.engineKind },
    ac: new AbortController(),
    thinkingBudget: -1,
    reasoningEffort: undefined,
    ...over,
  }
}

const sse = (...chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
const content = (text: string) => ({ choices: [{ delta: { content: text } }] })
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] }
const lookupCall = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }] }

/** Answers request n with `reply(n)` (a Response or an SSE body), recording every request body. */
function fakeEngine(reply: (n: number, init?: RequestInit) => Response | string | Promise<Response>): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const original = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const r = await reply(bodies.length, init)
    return typeof r === 'string' ? new Response(r, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : r
  }) as unknown as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = original } }
}

async function run(deps: FakeDeps, persistence: FakePersistence, policy: ApprovalPolicy, sink: EmitSink, turn = turnFor()) {
  return runGenerationCore(deps.d, turn, { persistence, sink, approval: policy, onSettled: () => { deps.settled++ } })
}

test('persistence: the terminal write gets the exact reply, and done carries what it returned', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  const engine = fakeEngine(() => sse(content('A finished reply, long enough to stream.'), stop))
  const events: Array<{ event: string; data: unknown }> = []
  try {
    const outcome = await run(deps, p, approval(), (ev) => { events.push(ev) })
    assert.equal(p.finals.length, 1)
    const final = p.finals[0]
    assert.equal(final.content, 'A finished reply, long enough to stream.')
    assert.equal(final.reasoning, '')
    assert.deepEqual(final.toolCalls, [])
    assert.equal(final.researchMeta, undefined)
    assert.equal(final.stats.aborted, false)
    assert.equal(final.stats.model, 'Model')
    assert.equal(final.stats.ctxMax, 4096)
    assert.deepEqual(events.at(-1), { event: 'done', data: { message: { id: 'reply-1', content: 'A finished reply, long enough to stream.' } } })
    assert.deepEqual(outcome, { restored: false, aborted: false, content: 'A finished reply, long enough to stream.' })
    assert.equal(deps.settled, 1, 'onSettled runs once, before the terminal write')
  } finally { engine.restore() }
})

test('persistence: a progress save the daemon asks for gets the reply so far, and is untracked when the turn ends', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const engine = fakeEngine(() => new Response(new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(content('Streamed so far, well past the parser lookahead.'))}\n\n`))
      await held
      c.enqueue(new TextEncoder().encode(sse(stop)))
      c.close()
    },
  }), { status: 200 }))
  try {
    const done = run(deps, p, approval(), () => {})
    while (p.tracked.length === 0 || !p.tracked[0]) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 20))
    p.tracked[0]()
    assert.deepEqual(p.progress, [{ content: 'Streamed so far, well past the parser lookahead.', reasoning: '', toolCalls: [] }])
    p.tracked[0]()
    assert.equal(p.progress.length, 1, 'an unchanged reply is not saved again')
    release()
    await done
    assert.equal(p.untracked, 1)
  } finally { engine.restore() }
})

test('persistence: an engine that refuses before producing anything is restored, and nothing is finalized', async () => {
  const deps = fakeDeps()
  const p = fakePersistence({ restores: true })
  const engine = fakeEngine(() => new Response('busy', { status: 503 }))
  const events: string[] = []
  try {
    const outcome = await run(deps, p, approval(), (ev) => { events.push(ev.event) })
    assert.equal(p.restoreCalls, 1)
    assert.equal(p.finals.length, 0)
    assert.equal(outcome.restored, true)
    assert.deepEqual(events, ['error'])
  } finally { engine.restore() }
})

test('persistence: a failure after text was produced is never restored; the text is finalized', async () => {
  const deps = fakeDeps()
  const p = fakePersistence({ restores: true })
  const engine = fakeEngine(() => sse(content('Some text before the failure arrives.'), { error: 'boom' }))
  try {
    await run(deps, p, approval(), () => {})
    assert.equal(p.restoreCalls, 0)
    assert.equal(p.finals[0].content, 'Some text before the failure arrives.')
  } finally { engine.restore() }
})

test('approval: a non-interactive policy answers an ask tool at once with a block, and the tool never runs', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  const engine = fakeEngine((n) => n === 1 ? sse(lookupCall) : sse(content('Answered without the tool.'), stop))
  const events: Array<{ event: string; data: unknown }> = []
  try {
    await run(deps, p, approval({ interactive: false }), (ev) => { events.push(ev) })
    assert.equal(deps.toolRuns.length, 0)
    assert.match(p.finals[0].toolCalls[0].result ?? '', /^Blocked: this tool requires interactive approval/)
    assert.equal(events.some((e) => (e.data as { status?: string }).status === 'awaiting_approval'), false)
  } finally { engine.restore() }
})

test('approval: an interactive policy asks and waits; a Stop while it waits is a deny', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  const engine = fakeEngine(() => sse(lookupCall))
  const turn = turnFor()
  const waits: boolean[] = []
  try {
    const done = run(deps, p, approval({ interactive: true, onApprovalWait: (w) => { waits.push(w) } }), (ev) => {
      if ((ev.data as { status?: string }).status === 'awaiting_approval') setTimeout(() => turn.ac.abort(), 5)
    }, turn)
    await done
    assert.deepEqual(waits, [true, false])
    assert.equal(deps.toolRuns.length, 0)
    assert.equal(p.finals[0].stats.aborted, true)
  } finally { engine.restore() }
})

test('approval: the policy\'s conversation overrides and code authorization reach the tool call', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  const engine = fakeEngine((n) => n === 1 ? sse(lookupCall) : sse(content('Used the tool to answer this.'), stop))
  try {
    await run(deps, p, approval({ convOverrides: () => ({ lookup: 'allow' }), isCodeAuthorized: true, refuseMcp: false }), () => {})
    assert.deepEqual(deps.toolRuns, [{ name: 'lookup', isCodeAuthorized: true }])
    assert.equal(p.finals[0].toolCalls[0].result, 'found it')
  } finally { engine.restore() }
})

test('sink: a sink that throws on every write costs no output — the reply is still finalized', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  const engine = fakeEngine(() => sse(content('Generated while nobody was listening.'), stop))
  try {
    await run(deps, p, approval(), () => { throw new Error('client gone') })
    assert.equal(p.finals[0].content, 'Generated while nobody was listening.')
  } finally { engine.restore() }
})

test('engine shaping: max_tokens is clamped to the Settings cap, and moved to max_completion_tokens for a local LiteRT-LM engine', async () => {
  const engine = fakeEngine(() => sse(content('ok'), stop))
  try {
    await run(fakeDeps({ maxTokens: 256 }), fakePersistence(), approval(), () => {}, turnFor({ conv: { id: 'conv-1', sampling: { max_tokens: 1000 } } }))
    assert.equal(engine.bodies[0].max_tokens, 256)
    const litert = turnFor({ upstream: { modelField: 'm', modelName: 'Model', ctxMax: 4096, target: 'http://127.0.0.1:1', engineKind: 'litert-lm' } })
    await run(fakeDeps({ maxTokens: 256, engineKind: 'litert-lm' }), fakePersistence(), approval(), () => {}, litert)
    assert.equal(engine.bodies[1].max_completion_tokens, 256)
    assert.equal('max_tokens' in engine.bodies[1], false)
  } finally { engine.restore() }
})

// ── The upstream's own engine, and the options a caller with nobody watching runs the loop with (a routine's run) ──

const json = (message: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 })
const jsonCall = (id: string, args: Record<string, unknown>, text: string | null = null) =>
  json({ content: text, tool_calls: [{ id, function: { name: 'lookup', arguments: JSON.stringify(args) } }] })
const unattended = (over: Partial<GenerationTurn> = {}): GenerationTurn => turnFor({
  loop: { transport: 'json', toolRoundCeiling: 3, extraPass: false, ledgers: false, toolsOnEveryEngine: true, stopBetweenToolCalls: false },
  ...over,
})

test("engine shaping follows the upstream's own engine (a pool slot's), not the primary's; without one, the primary's", async () => {
  const engine = fakeEngine(() => sse(content('ok'), stop))
  const slot = (engineKind: string) => turnFor({
    conv: { id: 'conv-1', sampling: { repeatPenalty: 1.1 } },
    upstream: { modelField: 'm', modelName: 'Model', ctxMax: 4096, target: 'http://127.0.0.1:1', engineKind },
  })
  try {
    await run(fakeDeps({ maxTokens: 256, engineKind: 'llama.cpp' }), fakePersistence(), approval(), () => {}, slot('litert-lm'))
    assert.equal(engine.bodies[0].max_completion_tokens, 256)
    await run(fakeDeps({ engineKind: 'llama.cpp' }), fakePersistence(), approval(), () => {}, slot('vllm'))
    assert.equal(engine.bodies[1].repetition_penalty, 1.1)
    await run(fakeDeps({ engineKind: 'vllm' }), fakePersistence(), approval(), () => {}, turnFor({ conv: { id: 'conv-1', sampling: { repeatPenalty: 1.1 } } }))
    assert.equal(engine.bodies[2].repetition_penalty, 1.1)
  } finally { engine.restore() }
})

test('json transport: one non-streaming completion per round, its text taken as the engine gives it', async () => {
  const engine = fakeEngine((n) => n === 1 ? jsonCall('c1', { q: 'x' }) : json({ content: '<think>hm</think>The answer.' }))
  try {
    const outcome = await run(fakeDeps(), fakePersistence(), approval({ agentAllowedTools: ['lookup'] }), () => {}, unattended())
    assert.deepEqual(Object.keys(engine.bodies[0]).sort(), ['messages', 'model', 'stream', 'tools'])
    assert.equal(engine.bodies[0].stream, false)
    assert.equal(outcome.content, '<think>hm</think>The answer.')
    const round2 = engine.bodies[1].messages as Array<{ role: string; content: unknown; tool_calls?: unknown }>
    assert.deepEqual(round2.slice(1), [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', content: 'found it', tool_call_id: 'c1' },
    ])
  } finally { engine.restore() }
})

test('json transport: a reply with no message is an engine failure, an HTTP refusal carries its status, a throw its message', async () => {
  const cases: Array<[() => Response, unknown]> = [
    [() => new Response('{}', { status: 200 }), { kind: 'engine', message: 'Engine returned no message.' }],
    [() => new Response(null, { status: 500 }), { kind: 'http', status: 500, reason: undefined }],
    [() => { throw new TypeError('fetch failed') }, { kind: 'thrown', message: 'fetch failed', request: true }],
  ]
  for (const [reply, failure] of cases) {
    const engine = fakeEngine(reply)
    try {
      const outcome = await run(fakeDeps(), fakePersistence(), approval(), () => {}, unattended())
      assert.deepEqual(outcome.failure, failure)
    } finally { engine.restore() }
  }
})

test('toolRoundCeiling: the turn ends exceeded after that many tool rounds, every one run, with no extra pass', async () => {
  const deps = fakeDeps()
  const engine = fakeEngine((n) => jsonCall(`c${n}`, { q: n }))
  try {
    const outcome = await run(deps, fakePersistence(), approval({ agentAllowedTools: ['lookup'] }), () => {}, unattended())
    assert.equal(outcome.exceeded, true)
    assert.equal(engine.bodies.length, 3)
    assert.equal(deps.toolRuns.length, 3)
  } finally { engine.restore() }
})

test('extraPass false: an empty answer stays empty; the live chat makes its BUG-001 extra pass', async () => {
  const engine = fakeEngine(() => sse(content('<think>only thinking</think>'), stop))
  try {
    await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor({ loop: { extraPass: false } }))
    assert.equal(engine.bodies.length, 1)
    await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor())
    assert.equal(engine.bodies.length, 3)
  } finally { engine.restore() }
})

test("ledgers false: nothing reaches the engine's counters, the completion stats or the request log", async () => {
  const deps = fakeDeps()
  const touched: string[] = []
  const m = deps.d.manager as unknown as Record<string, () => void>
  for (const k of ['generationStart', 'generationEnd', 'setLiveGen', 'recordCompletion']) m[k] = () => { touched.push(k) }
  const cfg = { requestLog: { enabled: true, captureBodies: false, maxEntries: 5 } }
  Object.assign(deps.d.store, { read: () => cfg })
  Object.assign(deps.d, { requestLog: { start: () => { touched.push('requestLog'); return 'id' }, finalize: () => {} } })
  const engine = fakeEngine(() => sse({ prompt_progress: { processed: 1, total: 2 } }, content('A reply long enough to stream.'), stop))
  try {
    await run(deps, fakePersistence(), approval(), () => {}, turnFor({ loop: { ledgers: false } }))
    assert.deepEqual(touched, [])
    await run(deps, fakePersistence(), approval(), () => {}, turnFor())
    assert.deepEqual([...new Set(touched)].sort(), ['generationEnd', 'generationStart', 'recordCompletion', 'requestLog', 'setLiveGen'])
  } finally { engine.restore() }
})

test('toolsOnEveryEngine: vLLM is offered the tools; the live chat withholds them there', async () => {
  const engine = fakeEngine(() => sse(content('ok'), stop))
  try {
    await run(fakeDeps({ engineKind: 'vllm' }), fakePersistence(), approval(), () => {}, turnFor({ loop: { toolsOnEveryEngine: true } }))
    assert.equal(Array.isArray(engine.bodies[0].tools), true)
    await run(fakeDeps({ engineKind: 'vllm' }), fakePersistence(), approval(), () => {}, turnFor())
    assert.equal('tools' in engine.bodies[1], false)
  } finally { engine.restore() }
})

test("stopBetweenToolCalls false: a stop during a round's call lets its other calls run, and the next round is never asked", async () => {
  const deps = fakeDeps()
  const turn = unattended()
  const tools = deps.d.tools as unknown as { executeTool: (call: { name: string }) => Promise<string> }
  tools.executeTool = async (call) => { deps.toolRuns.push({ name: call.name, isCodeAuthorized: false }); turn.ac.abort(); return 'ran' }
  const two = () => json({ content: null, tool_calls: [{ id: 'a', function: { name: 'lookup', arguments: '{}' } }, { id: 'b', function: { name: 'lookup', arguments: '{"n":2}' } }] })
  const engine = fakeEngine(two)
  try {
    const outcome = await run(deps, fakePersistence(), approval({ agentAllowedTools: ['lookup'] }), () => {}, turn)
    assert.equal(outcome.aborted, true)
    assert.equal(deps.toolRuns.length, 2)
    assert.equal(engine.bodies.length, 1)
  } finally { engine.restore() }
})

test('appendToolRound: each settled round is handed over with its raw results, and the terminal write carries only what came after', async () => {
  const rounds: unknown[] = []
  const p = fakePersistence()
  p.appendToolRound = (round) => { rounds.push(structuredClone(round)) }
  const engine = fakeEngine((n) => n === 1 ? jsonCall('c1', { q: 'x' }, 'let me look') : json({ content: 'Done.' }))
  try {
    const outcome = await run(fakeDeps(), p, approval({ agentAllowedTools: ['lookup'] }), () => {}, unattended())
    assert.deepEqual(rounds, [{ content: 'let me look', calls: [{ id: 'c1', name: 'lookup', args: { q: 'x' }, result: 'found it' }] }])
    assert.equal(outcome.content, 'Done.')
    assert.equal(p.finals[0].content, 'Done.')
    assert.deepEqual(p.finals[0].toolCalls, [])
  } finally { engine.restore() }
})

test('beforeToolCall: a block answers the call without running it; a stop ends the turn there, nothing finalized', async () => {
  const deps = fakeDeps()
  const p = fakePersistence()
  const seen: unknown[] = []
  const engine = fakeEngine((n) => n === 1 ? jsonCall('c1', { q: 1 }, 'first') : jsonCall('c2', { q: 2 }))
  try {
    const outcome = await runGenerationCore(deps.d, unattended(), {
      persistence: p, sink: () => {}, approval: approval({ agentAllowedTools: ['lookup'] }),
      beforeToolCall: (call, round) => {
        seen.push([call.id, round.content, round.calls.length])
        return call.id === 'c1' ? { block: 'not this one' } : { stop: 'stalled on c2' }
      },
    })
    assert.equal(outcome.stopped, 'stalled on c2')
    assert.equal(deps.toolRuns.length, 0)
    assert.deepEqual(seen, [['c1', 'first', 0], ['c2', '', 0]])
    assert.equal((engine.bodies[1].messages as Array<{ content: unknown }>).at(-1)?.content, 'not this one')
    assert.equal(p.finals.length, 0)
  } finally { engine.restore() }
})

test('beforeToolCall: with no tool registry its calls still reach it, and one it lets run is answered as having none', async () => {
  const deps = fakeDeps()
  Object.assign(deps.d, { tools: undefined })
  const seen: string[] = []
  const engine = fakeEngine((n) => n === 1 ? jsonCall('c1', { q: 1 }) : n === 2 ? jsonCall('c2', { q: 2 }) : json({ content: 'never' }))
  try {
    const outcome = await runGenerationCore(deps.d, unattended(), {
      persistence: fakePersistence(), sink: () => {}, approval: approval(),
      beforeToolCall: (call) => { seen.push(call.id); return call.id === 'c1' ? 'run' : { stop: 'stalled' } },
    })
    assert.equal(outcome.stopped, 'stalled')
    assert.deepEqual(seen, ['c1', 'c2'])
    assert.equal((engine.bodies[1].messages as Array<{ content: unknown }>).at(-1)?.content, 'Error: no tool registry available.')
  } finally { engine.restore() }
})

test("a LiteRT-LM upstream's own library key picks the model whose tool support decides the round's tools", async () => {
  const deps = fakeDeps({ engineKind: 'litert-lm' })
  Object.assign(deps.d, { scanner: { get: (key: string) => (key === 'slot-model' ? { key, toolCalls: false } : undefined) } })
  const engine = fakeEngine(() => sse(content('ok'), stop))
  try {
    const upstream = { modelField: 'slot-model', modelName: 'Slot', ctxMax: 4096, target: 'http://127.0.0.1:2', engineKind: 'litert-lm', libraryKey: 'slot-model' }
    await run(deps, fakePersistence(), approval(), () => {}, turnFor({ upstream }))
    assert.equal('tools' in engine.bodies[0], false)
  } finally { engine.restore() }
})

test("engine messages keep a prior round's tool calls and results", async () => {
  const engine = fakeEngine(() => sse(content('ok'), stop))
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', content: 'found it', tool_call_id: 'c0' },
  ]
  try {
    await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor({ engineMessages: history }))
    assert.deepEqual(engine.bodies[0].messages, history)
  } finally { engine.restore() }
})

// ── What the public API's run needs of the loop (ext/generation.ts): each a defaulted-off option or port ──────────

const usage = { prompt_tokens: 3, completion_tokens: 2 }
/** A response whose body is `chunks` as SSE, then held open (`hold`) or broken off (`fail`) instead of ended. */
function openStream(chunks: unknown[], end: 'hold' | 'fail'): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
      if (end === 'fail') setTimeout(() => controller.error(new Error('terminated')), 10)
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const deltas = (events: Array<{ event: string; data: unknown }>): string =>
  events.filter((e) => e.event === 'delta').map((e) => (e.data as { delta: string }).delta).join('')

test("engineSampling: the caller's mapped sampling goes UNDER the request's own fields, with its stop strings; conv.sampling is not read", async () => {
  const engine = fakeEngine(() => sse(content('ok'), stop))
  try {
    await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor({
      conv: { id: 'conv-1', sampling: { temp: 0.9, stop: ['NO'] } },
      engineSampling: { fields: { temperature: 0.2, model: 'evil', messages: [], stream: false, stream_options: {} }, stop: ['END'] },
      loop: { returnProgress: false },
    }))
    const body = engine.bodies[0]
    assert.deepEqual(Object.keys(body), ['temperature', 'model', 'messages', 'stream', 'stream_options', 'stop', 'tools'])
    assert.equal(body.temperature, 0.2)
    assert.equal(body.model, 'm')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.deepEqual(body.stop, ['END'])
  } finally { engine.restore() }
})

test('returnProgress false: the streamed request does not ask for prompt progress; the live chat does', async () => {
  const engine = fakeEngine(() => sse(content('ok'), stop))
  try {
    await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor({ loop: { returnProgress: false } }))
    assert.equal('return_progress' in engine.bodies[0], false)
    await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor())
    assert.equal(engine.bodies[1].return_progress, true)
  } finally { engine.restore() }
})

test("announceToolCalls false: a call the model streams is not announced as pending; the call's own events still come", async () => {
  const toolCallEvents = async (loop: GenerationTurn['loop']) => {
    const events: Array<{ event: string; data: unknown }> = []
    const engine = fakeEngine((n) => n === 1 ? sse(lookupCall) : sse(content('The answer, long enough to stream.'), stop))
    try {
      await run(fakeDeps(), fakePersistence(), approval(), (ev) => { events.push(ev) }, turnFor({ loop }))
    } finally { engine.restore() }
    return events.filter((e) => e.event === 'tool_call').map((e) => (e.data as { status: string }).status)
  }
  assert.deepEqual(await toolCallEvents({ announceToolCalls: false }), ['done'])
  assert.deepEqual(await toolCallEvents(undefined), ['pending', 'done'])
})

test('streamErrors ignore: an error chunk in the stream is read past; the live chat fails on it', async () => {
  const engine = fakeEngine(() => sse({ error: { message: 'boom' } }, content('Read past the error chunk, long enough.'), stop))
  try {
    const p = fakePersistence()
    const ignored = await run(fakeDeps(), p, approval(), () => {}, turnFor({ loop: { streamErrors: 'ignore' } }))
    assert.equal(ignored.failure, undefined)
    assert.equal(p.finals[0].content, 'Read past the error chunk, long enough.')
    const failed = await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor())
    assert.equal(failed.failure?.kind, 'engine')
  } finally { engine.restore() }
})

test('interruptedTail asStreamed: a broken-off reply keeps no text the parser held back; the live chat keeps it', async () => {
  const cases: Array<[GenerationTurn['loop'], string]> = [[{ interruptedTail: 'asStreamed' }, ''], [undefined, 'short']]
  for (const [loop, expected] of cases) {
    const engine = fakeEngine(() => openStream([content('short')], 'fail'))
    const events: Array<{ event: string; data: unknown }> = []
    const p = fakePersistence()
    try {
      const outcome = await run(fakeDeps(), p, approval(), (ev) => { events.push(ev) }, turnFor({ loop }))
      assert.deepEqual(outcome.failure, { kind: 'thrown', message: 'terminated' })
      assert.equal(p.finals[0].content, expected)
      assert.equal(deltas(events), '')
    } finally { engine.restore() }
  }
})

test('interruptedTail asStreamed: a stop that ends the read quietly streams the held-back text before it ends the turn', async () => {
  for (const loop of [{ interruptedTail: 'asStreamed' as const }, undefined]) {
    const turn = turnFor({ loop })
    // A reply still shorter than the parser's opening lookahead when the stop comes: all of it held back.
    const engine = fakeEngine(() => { setTimeout(() => turn.ac.abort(), 30); return openStream([content('short')], 'hold') })
    const events: Array<{ event: string; data: unknown }> = []
    const p = fakePersistence()
    try {
      const outcome = await run(fakeDeps(), p, approval(), (ev) => { events.push(ev) }, turn)
      assert.equal(outcome.aborted, true)
      assert.equal(p.finals[0].content, 'short')
      // Streamed as stored for the public API; the live chat's refetch reads the stored reply.
      assert.equal(deltas(events), loop ? 'short' : '')
    } finally { engine.restore() }
  }
})

test('progressCadence everyChange: saveProgress is told of every change as it happens, with what changed', async () => {
  const saves: Array<{ content: string; toolCalls: number; cause: string | undefined }> = []
  const p = fakePersistence()
  p.progressCadence = 'everyChange'
  p.saveProgress = (reply, cause) => { saves.push({ content: reply.content, toolCalls: reply.toolCalls.length, cause }) }
  const engine = fakeEngine((n) => n === 1 ? sse(content('Looking that up for you, one moment.'), lookupCall) : sse(content('Found.'), stop))
  try {
    await run(fakeDeps(), p, approval(), () => {}, turnFor())
    assert.equal(saves[0].cause, 'text')
    assert.ok('Looking that up for you, one moment.'.startsWith(saves[0].content) && saves[0].content.length > 0)
    assert.deepEqual(saves.find((s) => s.cause === 'toolCall'), { content: 'Looking that up for you, one moment.', toolCalls: 1, cause: 'toolCall' })
    assert.deepEqual(saves.at(-1), { content: 'Looking that up for you, one moment.Found.', toolCalls: 1, cause: 'text' })
  } finally { engine.restore() }
})

test('onUsage: told of each usage object the engine sends, as it sends it', async () => {
  const seen: unknown[] = []
  const engine = fakeEngine(() => sse(content('A reply long enough to stream here.'), stop, { choices: [], usage }))
  try {
    await runGenerationCore(fakeDeps().d, turnFor(), { persistence: fakePersistence(), sink: () => {}, approval: approval(), onUsage: (u) => { seen.push(u) } })
    assert.deepEqual(seen, [usage])
  } finally { engine.restore() }
})

test('a failure says whether the request itself threw, or the reading of its reply', async () => {
  const cases: Array<[() => Response, unknown]> = [
    [() => { throw new TypeError('fetch failed') }, { kind: 'thrown', message: 'fetch failed', request: true }],
    [() => openStream([], 'fail'), { kind: 'thrown', message: 'terminated' }],
  ]
  for (const [reply, failure] of cases) {
    const engine = fakeEngine(reply)
    try {
      assert.deepEqual((await run(fakeDeps(), fakePersistence(), approval(), () => {}, turnFor())).failure, failure)
    } finally { engine.restore() }
  }
})
