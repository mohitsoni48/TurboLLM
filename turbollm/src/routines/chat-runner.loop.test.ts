// turbollm/src/routines/chat-runner.loop.test.ts
//
// Characterization of the Chat Routine's tool loop, pinned before it moved onto the shared generation core
// (scalability 5.6): the round ceiling and its error text, the same-call breaker and abort, the stall on a tool the
// agent does not list, what each round persists, how an engine failure, a timeout and an empty answer end a run, the
// request a routine sends, and what it leaves out of the machine's ledgers. chat-runner.test.ts covers the rest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import type { ToolRegistry } from '../tools/tool-registry'
import { runChatRoutine, resumeChatRoutine, MAX_TOOL_ITER } from './chat-runner'
import { parsePendingToolCall } from './approval'
import { LOOP_ABORT_AFTER, LOOP_BREAK_AFTER } from './runaway-guard'
import { lastLocalActivityMs, resetLocalActivity } from '../link/host-idle'
import type { Deps } from '../deps'

const AGENT = { id: 'agent-1', name: 'Researcher', description: '', systemPrompt: 'You research things.', skillIds: [], tools: ['run_code'] }

interface ToolDouble { tools: ToolRegistry; runs: Array<{ name: string; args: unknown }> }

/** A registry offering the agent's run_code, answering each call with `answer` (which may throw). */
function toolDouble(answer: (n: number, args: unknown) => string = (n) => `result ${n}`): ToolDouble {
  const runs: ToolDouble['runs'] = []
  const tools = {
    buildToolDefinitions: async () => [{ type: 'function', function: { name: 'run_code', description: '', parameters: {} } }],
    executeTool: async (call: { name: string; args: unknown }) => { runs.push({ name: call.name, args: call.args }); return answer(runs.length, call.args) },
  } as unknown as ToolRegistry
  return { tools, runs }
}

interface Ledgers { generationStarts: number; completions: number; liveGens: number; requestLogs: number }

function fakeDeps(opts: { tools: ToolRegistry; engineKind?: string; maxTokens?: number }): { d: Deps; db: ConversationStore; ledgers: Ledgers } {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const ledgers: Ledgers = { generationStarts: 0, completions: 0, liveGens: 0, requestLogs: 0 }
  const cfg = { customAgents: [AGENT], tools: { toolPolicies: {}, autoAllowAll: false }, modelDefaults: { maxTokens: opts.maxTokens ?? 0 }, requestLog: { enabled: true, captureBodies: false, maxEntries: 10 } }
  const d = {
    db,
    store: { snapshot: () => cfg, read: () => cfg, dir: () => '/data/turbollm' },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'm', quant: '', ctx: 8192, vision: false } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => ({ modelPath: '/models/m.gguf' }),
      generationStart: () => { ledgers.generationStarts++ },
      generationEnd: () => {},
      setLiveGen: () => { ledgers.liveGens++ },
      recordCompletion: () => { ledgers.completions++ },
    },
    registry: { active: () => ({ kind: opts.engineKind ?? 'llama-server' }) },
    scanner: { get: () => undefined },
    requestLog: { start: () => { ledgers.requestLogs++; return 'log-1' }, finalize: () => {} },
    tools: opts.tools,
  } as unknown as Deps
  return { d, db, ledgers }
}

type Reply = Record<string, unknown> | ((n: number) => Response | Record<string, unknown>)

/** The engine: answers request n with replies[n-1] (the last one repeats), recording every request body. */
function fakeEngine(replies: Reply[]): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const original = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const reply = replies[Math.min(bodies.length, replies.length) - 1]
    const r = typeof reply === 'function' ? reply(bodies.length) : reply
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 })
  }) as unknown as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = original } }
}

const answer = (content: string | null) => ({ choices: [{ message: { content } }] })
const callRound = (content: string | null, calls: Array<[string, string, Record<string, unknown>]>) =>
  ({ choices: [{ message: { content, tool_calls: calls.map(([id, name, args]) => ({ id, function: { name, arguments: JSON.stringify(args) } })) } }] })

function setup(opts: Parameters<typeof fakeDeps>[0]) {
  const deps = fakeDeps(opts)
  const r = deps.db.createRoutine({ flavor: 'chat', prompt: 'Summarize my open PRs', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = deps.db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const messages = () => deps.db.getConversation(deps.db.getRoutineRun(run.id)!.conversationId!, true)!.messages!
  return { ...deps, r, run, messages }
}

test(`the run ends at ${MAX_TOOL_ITER} tool rounds with the ceiling error, every round persisted and no extra pass`, async () => {
  const t = toolDouble()
  const s = setup({ tools: t.tools })
  const engine = fakeEngine([(n) => callRound(null, [[`c${n}`, 'run_code', { code: `return ${n}` }]])])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'errored', error: 'Exceeded the 16-round tool-call ceiling without finishing.' })
    assert.equal(engine.bodies.length, 16)
    assert.equal(t.runs.length, 16)
    const msgs = s.messages()
    assert.equal(msgs.length, 17)
    assert.deepEqual(msgs.slice(1).map((m) => [m.role, m.toolCalls.length]), Array(16).fill(['assistant', 1]))
  } finally { engine.restore() }
})

test('each completed tool round is appended as its own assistant message with the raw results, then the answer', async () => {
  const t = toolDouble((n) => { if (n === 2) throw new Error('boom'); return 'three' })
  const s = setup({ tools: t.tools })
  const engine = fakeEngine([
    callRound('let me check', [['c1', 'run_code', { code: 'return 3' }], ['c2', 'run_code', { code: 'throw 1' }]]),
    answer('Found 3 open PRs.'),
  ])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'Found 3 open PRs.' })
    const msgs = s.messages()
    assert.deepEqual(msgs.map((m) => [m.role, m.content]), [['user', 'Summarize my open PRs'], ['assistant', 'let me check'], ['assistant', 'Found 3 open PRs.']])
    assert.deepEqual(msgs[1].toolCalls, [
      { id: 'c1', name: 'run_code', args: { code: 'return 3' }, result: 'three' },
      { id: 'c2', name: 'run_code', args: { code: 'throw 1' }, result: 'Error: boom' },
    ])
    assert.deepEqual(msgs[2].toolCalls, [])
    const round2 = engine.bodies[1].messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
    assert.deepEqual(round2.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]), [['c1', 'three'], ['c2', 'Error: boom']])
  } finally { engine.restore() }
})

test(`a call repeated past LOOP_BREAK_AFTER (${LOOP_BREAK_AFTER}) is answered as blocked, not run, and the run goes on`, async () => {
  const t = toolDouble()
  const s = setup({ tools: t.tools })
  const same = callRound(null, [['c1', 'run_code', { code: 'return 1' }]])
  const engine = fakeEngine([same, same, same, same, answer('Gave up on that.')])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'Gave up on that.' })
    assert.equal(t.runs.length, LOOP_BREAK_AFTER)
    const blocked = 'Blocked: "run_code" was called with identical arguments too many times in a row — not executed.'
    assert.equal(s.messages()[4].toolCalls[0].result, blocked)
    const round5 = engine.bodies[4].messages as Array<{ role: string; content: unknown }>
    assert.equal(round5.at(-1)?.content, blocked)
  } finally { engine.restore() }
})

test(`a call repeated past LOOP_ABORT_AFTER (${LOOP_ABORT_AFTER}) errors the run, its round not persisted`, async () => {
  const t = toolDouble()
  const s = setup({ tools: t.tools })
  const engine = fakeEngine([callRound(null, [['c1', 'run_code', { code: 'return 1' }]])])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'errored', error: '"run_code" was called with identical arguments 7 times in a row — stopped automatically to avoid an infinite loop.' })
    assert.equal(engine.bodies.length, LOOP_ABORT_AFTER + 1)
    assert.equal(t.runs.length, LOOP_BREAK_AFTER)
    assert.equal(s.messages().length, 1 + LOOP_ABORT_AFTER)
  } finally { engine.restore() }
})

test("a call to a tool the agent does not list stalls the run with the round's earlier results, persisting nothing of the round", async () => {
  const t = toolDouble(() => 'ran')
  const s = setup({ tools: t.tools })
  const engine = fakeEngine([callRound('checking', [['c1', 'run_code', { code: 'return 1' }], ['c2', 'fetch_url', { url: 'http://x.invalid' }], ['c3', 'run_code', { code: 'return 2' }]])])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'needs_approval' })
    assert.equal(engine.bodies.length, 1)
    assert.equal(t.runs.length, 1, 'the calls after the stalled one never run')
    const reloaded = s.d.db.getRoutineRun(s.run.id)!
    assert.equal(reloaded.status, 'needs_approval')
    assert.deepEqual(parsePendingToolCall(reloaded.pendingToolCall), {
      convId: reloaded.conversationId, assistantContent: 'checking',
      precedingCalls: [{ id: 'c1', name: 'run_code', args: { code: 'return 1' }, result: 'ran' }],
      call: { id: 'c2', name: 'fetch_url', args: { url: 'http://x.invalid' } },
    })
    assert.equal(s.messages().length, 1)
  } finally { engine.restore() }
})

test('a resumed run persists the approved round, then each later round and the answer, counting its rounds afresh', async () => {
  const t = toolDouble(() => 'ran')
  const s = setup({ tools: t.tools })
  const first = fakeEngine([callRound('checking', [['c1', 'fetch_url', { url: 'http://x.invalid' }]])])
  try {
    assert.deepEqual(await runChatRoutine(s.d, s.r, s.run, new AbortController().signal), { status: 'needs_approval' })
  } finally { first.restore() }
  const pending = parsePendingToolCall(s.d.db.getRoutineRun(s.run.id)!.pendingToolCall)!
  const engine = fakeEngine([callRound(null, [['c2', 'run_code', { code: 'return 2' }]]), answer('All done.')])
  try {
    const outcome = await resumeChatRoutine(s.d, s.r, s.run, pending, 'allow', new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'All done.' })
    const msgs = s.messages()
    assert.deepEqual(msgs.map((m) => [m.role, m.content, m.toolCalls.map((c) => c.id)]), [
      ['user', 'Summarize my open PRs', []], ['assistant', 'checking', ['c1']], ['assistant', '', ['c2']], ['assistant', 'All done.', []],
    ])
    assert.deepEqual(t.runs.map((x) => x.name), ['fetch_url', 'run_code'])
  } finally { engine.restore() }
})

test('an engine failure in a later round ends the run with its status, keeping the rounds already persisted', async () => {
  const t = toolDouble()
  const s = setup({ tools: t.tools })
  const engine = fakeEngine([callRound(null, [['c1', 'run_code', { code: 'return 1' }]]), () => new Response(null, { status: 500 })])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'errored', error: 'Engine returned 500.' })
    assert.equal(s.messages().length, 2)
  } finally { engine.restore() }
})

test('a reply with no message, and one that is not JSON, end the run with their own errors', async () => {
  const t = toolDouble()
  for (const [reply, error] of [[{ error: 'nope' }, /^Engine returned no message\.$/], [() => new Response('not json', { status: 200 }), /^Engine request failed: /]] as const) {
    const s = setup({ tools: t.tools })
    const engine = fakeEngine([reply])
    try {
      const outcome = await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
      assert.equal(outcome.status, 'errored')
      assert.match((outcome as { error: string }).error, error)
      assert.equal(s.messages().length, 1)
    } finally { engine.restore() }
  }
})

test("a timeout during a round's tool call lets the round's other calls finish and persist, then ends the run as cancelled", async () => {
  const ac = new AbortController()
  const t = toolDouble((n) => { if (n === 1) ac.abort(); return `ran ${n}` })
  const s = setup({ tools: t.tools })
  const engine = fakeEngine([callRound(null, [['c1', 'run_code', { code: 'return 1' }], ['c2', 'run_code', { code: 'return 2' }]]), answer('never asked')])
  try {
    const outcome = await runChatRoutine(s.d, s.r, s.run, ac.signal)
    assert.deepEqual(outcome, { status: 'errored', error: 'Routine run timed out or was cancelled.' })
    assert.equal(t.runs.length, 2)
    assert.equal(engine.bodies.length, 1)
    assert.deepEqual(s.messages()[1].toolCalls.map((c) => c.result), ['ran 1', 'ran 2'])
  } finally { engine.restore() }
})

test('an empty final answer is the result as it is: one request, no extra pass', async () => {
  const s = setup({ tools: toolDouble().tools })
  const engine = fakeEngine([answer(null)])
  try {
    assert.deepEqual(await runChatRoutine(s.d, s.r, s.run, new AbortController().signal), { status: 'ok', result: '' })
    assert.equal(engine.bodies.length, 1)
    assert.deepEqual(s.messages().map((m) => [m.role, m.content]), [['user', 'Summarize my open PRs'], ['assistant', '']])
  } finally { engine.restore() }
})

test("a routine's request is one non-streaming completion with the agent's tools and the Settings cap, and no sampling — on vLLM too", async () => {
  const s = setup({ tools: toolDouble().tools, engineKind: 'vllm', maxTokens: 512 })
  const engine = fakeEngine([answer('ok')])
  try {
    await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)
    const body = engine.bodies[0]
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'tools'])
    assert.equal(body.stream, false)
    assert.equal(body.max_tokens, 512)
    assert.deepEqual((body.tools as Array<{ function: { name: string } }>).map((x) => x.function.name), ['run_code'])
    assert.deepEqual(body.messages, [{ role: 'system', content: 'You research things.' }, { role: 'user', content: 'Summarize my open PRs' }])
  } finally { engine.restore() }
})

test("a pool slot's own engine shapes the request, not the primary's", async () => {
  const s = setup({ tools: toolDouble().tools, engineKind: 'llama-server', maxTokens: 256 })
  const engine = fakeEngine([answer('ok')])
  try {
    await runChatRoutine(s.d, s.r, s.run, new AbortController().signal, { target: 'http://slot.invalid.local:2', engineKind: 'litert-lm', modelPath: '/models/m.litertlm' })
    assert.equal(engine.bodies[0].max_completion_tokens, 256)
    assert.equal('max_tokens' in engine.bodies[0], false)
  } finally { engine.restore() }
})

test("a routine's run writes nothing into the engine's ledgers, the owner's activity or the request log", async () => {
  const t = toolDouble()
  const s = setup({ tools: t.tools })
  resetLocalActivity()
  const engine = fakeEngine([callRound(null, [['c1', 'run_code', { code: 'return 1' }]]), answer('ok')])
  try {
    assert.equal((await runChatRoutine(s.d, s.r, s.run, new AbortController().signal)).status, 'ok')
    assert.deepEqual(s.ledgers, { generationStarts: 0, completions: 0, liveGens: 0, requestLogs: 0 })
    assert.equal(lastLocalActivityMs(), null)
  } finally { engine.restore() }
})
