// The generation core's three port contracts, driven with a fake persistence port and a fake
// engine, and with NO `db` and NO `chatTurns` on Deps: any reach past the ports into the chat
// database or the chat turn registry is a TypeError here, not a silent write to the wrong store
// (ext/generation.ts's header, point 2, is that bug).
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
