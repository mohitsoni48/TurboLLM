// turbollm/src/routines/chat-runner.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { ToolRegistry } from '../tools/tool-registry'
import { runChatRoutine, resumeChatRoutine } from './chat-runner'
import type { Routine } from './schema'
import { parsePendingToolCall, type PendingRoutineToolCall } from './approval'
import type { Deps } from '../deps'

// `run_code` and `fetch_url` are both real built-in tools that buildToolDefinitions() offers
// UNCONDITIONALLY (unlike `web_search`, which needs a configured search provider — see the
// fakeDeps() comment below for why that distinction matters). `run_code` additionally executes
// fully in-process (a sandboxed JS eval, no network/file/process access per its own tool
// description), so tests can exercise REAL tool execution without touching global.fetch, which
// is already reserved for stubbing the engine's own /v1/chat/completions calls.
const AGENT = { id: 'agent-1', name: 'Researcher', description: '', systemPrompt: 'You research things.', skillIds: [], tools: ['run_code'] }

function fakeDeps(overrides: Partial<{ customAgents: typeof AGENT[]; tools: ToolRegistry; engineKind: string; modelPath: string | null; toolCalls: boolean; ctx: number }> = {}): { d: Deps; db: ConversationStore } {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const d = {
    db,
    store: { snapshot: () => ({ customAgents: overrides.customAgents ?? [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }), dir: () => '/data/turbollm' },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'm', quant: '', ctx: overrides.ctx ?? 8192, vision: false } }),
      target: () => 'http://engine.invalid.local:1',
      currentOpts: () => (overrides.modelPath !== undefined ? { modelPath: overrides.modelPath } : null),
    },
    registry: { active: () => ({ kind: overrides.engineKind ?? 'llama-server' }) },
    // The library entry of the loaded model 'm': whether a .litertlm calls tools is its header's (models/litertlm.ts).
    scanner: { get: (key: string) => (key === 'm' && overrides.toolCalls !== undefined ? { key: 'm', toolCalls: overrides.toolCalls } : undefined) },
    // search: {} deliberately left unconfigured (searchConfigured() is false) — web_search is
    // NOT offered here on purpose. A real reviewer caught this in the original suite: every
    // test used web_search as its "allowed" tool while leaving search unconfigured, so
    // buildToolDefinitions() always sent an EMPTY tool list and every "tool executed"
    // assertion was actually asserting on execWebSearch's unavailable-tool error string, never
    // real execution. Tests below use run_code/fetch_url instead, which need no config.
    tools: overrides.tools ?? new ToolRegistry({ search: {}, sandbox: {}, mcpServers: [] } as never),
  } as unknown as Deps
  return { d, db }
}

function stubFetch(responses: Array<Record<string, unknown>>): { restore: () => void; calls: Array<Record<string, unknown>> } {
  const original = globalThis.fetch
  const calls: Array<Record<string, unknown>> = []
  let i = 0
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(init?.body as string))
    const body = responses[Math.min(i, responses.length - 1)]
    i++
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, calls }
}

function routine(store: ConversationStore, overrides: Partial<Routine> = {}): Routine {
  const r = store.createRoutine({ flavor: 'chat', prompt: 'Summarize my open PRs', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  return store.updateRoutine(r.id, overrides as never) ?? r
}

// Load-bearing for mlx-vlm: engineModelAlias('mlx-vlm', modelPath) only does the right thing if
// the real currently-loaded model path actually reaches the outgoing request body. This is the
// call-site-threading test the pure-function engineModelAlias unit tests (compat.test.ts) can't
// cover — it exercises the real chat-runner.ts wiring: registry.active().kind → engineModelAlias
// → manager.currentOpts()?.modelPath → request body's `model` field.
test('runChatRoutine sends manager.currentOpts().modelPath as the request model for mlx-vlm, not the internal key', async () => {
  const { d, db } = fakeDeps({ engineKind: 'mlx-vlm', modelPath: '/models/qwen2-vl-7b-mlx' })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
  try {
    await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(fetchStub.calls[0].model, '/models/qwen2-vl-7b-mlx')
  } finally { fetchStub.restore() }
})

// With keep-N 2 or more a routine's swap loads its model into a pool slot, which keeps the engine it was loaded on,
// and the user's model stays in the primary. The turns went to the primary, shaped for the primary's engine.
test("runChatRoutine sends every turn to the swap's pool slot, shaped for that slot's engine", async () => {
  const { d, db } = fakeDeps({ engineKind: 'llama-server', modelPath: '/models/user-model.gguf' })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const original = globalThis.fetch
  const urls: string[] = []
  const models: unknown[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    models.push((JSON.parse(init?.body as string) as { model: unknown }).model)
    return new Response(JSON.stringify({ choices: [{ message: { content: 'All PRs are green.' } }] }), { status: 200 })
  }) as typeof fetch
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal, { target: 'http://slot.invalid.local:2', engineKind: 'mlx-vlm', modelPath: '/models/qwen2-vl-7b-mlx' })
    assert.equal(outcome.status, 'ok')
    assert.deepEqual(urls, ['http://slot.invalid.local:2/v1/chat/completions'])
    assert.deepEqual(models, ['/models/qwen2-vl-7b-mlx'], "mlx-vlm's model field is the slot's model path, not the primary's")
  } finally { globalThis.fetch = original }
})

// A swap into the primary (keep-N 1, or keep-N 2 with nothing loaded) hands a route with no engine. Its `model` fallback
// is the primary's own key, as with no route, not the routine's key as stored (a model name or part of one).
test("a route to the primary names the primary's model, as with no route", async () => {
  const { d, db } = fakeDeps({ engineKind: 'llama-server', modelPath: '/models/m.gguf' })
  const r = db.createRoutine({ flavor: 'chat', prompt: 'Summarize my open PRs', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'M', agentId: 'agent-1' })
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
  try {
    for (const route of [{ target: 'http://engine.invalid.local:1' }, undefined]) {
      const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
      assert.equal((await runChatRoutine(d, r, run, new AbortController().signal, route)).status, 'ok')
    }
    assert.deepEqual(fetchStub.calls.map((b) => b.model), ['m', 'm'])
  } finally { fetchStub.restore() }
})

// Both LiteRT-LM servers take tools now, and a bundle whose template reads them shows them to its
// model (LFM2.5, Qwen3, Gemma 4). A routine agent's tools (AGENT has run_code, which
// buildToolDefinitions() offers unconditionally) were withheld from every LiteRT-LM model: they reach
// one that calls tools, and one whose template cannot show them (Gemma3-1B, LFM2.5-VL) still runs, without.
test('runChatRoutine sends the agent\'s tools to a LiteRT-LM model that calls tools, and none to one that cannot', async () => {
  for (const [toolCalls, sent] of [[true, true], [undefined, true], [false, false]] as const) {
    const { d, db } = fakeDeps({ engineKind: 'litert-lm', ...(toolCalls === undefined ? {} : { toolCalls }) })
    const r = routine(db)
    const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
    const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
    try {
      const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
      assert.equal(outcome.status, 'ok', 'the turn itself succeeds either way')
      const tools = fetchStub.calls[0].tools as Array<{ function: { name: string } }> | undefined
      if (sent) assert.deepEqual(tools?.map((t) => t.function.name), ['run_code'], `toolCalls ${toolCalls}`)
      else assert.equal(tools, undefined, 'a model whose template cannot show tools is sent none')
    } finally { fetchStub.restore() }
  }
})

test('runChatRoutine sends a LiteRT-LM model no tools that do not fit in its context', async () => {
  const { d, db } = fakeDeps({ engineKind: 'litert-lm', toolCalls: true, ctx: 600 })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
  try {
    assert.equal((await runChatRoutine(d, r, run, new AbortController().signal)).status, 'ok')
    assert.equal(fetchStub.calls[0].tools, undefined)
  } finally { fetchStub.restore() }
})

// The same agent on an engine that does take tools: proves the litert-lm test above withholds
// because of the model, not because the registry or agent came up empty.
test('runChatRoutine still sends tools on llama-server for the same agent', async () => {
  const { d, db } = fakeDeps({ engineKind: 'llama-server' })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
  try {
    await runChatRoutine(d, r, run, new AbortController().signal)
    assert.ok(Array.isArray(fetchStub.calls[0].tools) && fetchStub.calls[0].tools.length > 0, 'run_code must be offered on llama-server')
  } finally { fetchStub.restore() }
})

// A refused turn said only "Engine returned 400." in the run's record; LiteRT-LM's servers give their reason in the
// status line (the Android app's with a JSON body too, `litert-lm serve` with an HTML page), here alone.
test('a run the engine refuses records the engine\'s reason', async () => {
  const { d, db } = fakeDeps({ engineKind: 'litert-lm' })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 400, statusText: 'Invalid sampler parameters: ValueError: top_p must be between 0 and 1, got 1.5' })) as typeof fetch
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'errored')
    assert.equal((outcome as { error?: string }).error, 'Engine returned 400: Invalid sampler parameters: ValueError: top_p must be between 0 and 1, got 1.5')
  } finally { globalThis.fetch = original }
})

test('a final answer with no tool calls records status ok', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'All PRs are green.' })
  } finally { fetchStub.restore() }
})

// Closes the gap where a run's real conversation existed in the DB but nothing pointed at it —
// the routine's run history had no way to open it, only read the flattened `result` string back.
test('runChatRoutine persists the run.conversationId it created, before the loop even finishes', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  assert.equal(run.conversationId, undefined, 'not set yet at run creation — the scheduler creates the row before dispatch')
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'All PRs are green.' } }] }])
  try {
    await runChatRoutine(d, r, run, new AbortController().signal)
    const reloaded = db.getRoutineRun(run.id)
    assert.ok(reloaded?.conversationId, 'expected a conversationId to be persisted on the run')
    // The id genuinely resolves to a real, full conversation — not just an opaque string.
    const conv = db.getConversation(reloaded!.conversationId!, true)
    assert.ok(conv)
    assert.equal(conv?.kind, 'agent')
    assert.equal(conv?.messages?.[0]?.content, r.prompt)
  } finally { fetchStub.restore() }
})

test('resumeChatRoutine reuses the SAME conversationId already on the run — a resume never creates a second conversation', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const conv = db.createConversation({ kind: 'agent', modelKey: 'm', systemPrompt: AGENT.systemPrompt, agentId: AGENT.id })
  db.addMessage(conv.id, 'user', r.prompt)
  db.updateRoutineRun(run.id, { conversationId: conv.id })
  const pending: PendingRoutineToolCall = {
    convId: conv.id, assistantContent: '', precedingCalls: [],
    call: { id: 'c1', name: 'run_code', args: { code: 'return 40+2' } },
  }
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'Resumed and done.' } }] }])
  try {
    await resumeChatRoutine(d, r, run, pending, 'allow', new AbortController().signal)
    assert.equal(db.getRoutineRun(run.id)?.conversationId, conv.id)
  } finally { fetchStub.restore() }
})

test('a tool call within the allow-list actually executes (real result reaches the next round), and the loop continues to a final answer', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'run_code', arguments: '{"code":"return 1+2"}' } }] } }] },
    { choices: [{ message: { content: 'Found 3 open PRs.' } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'ok')
    // The round-2 request must carry run_code's REAL computed result ('3'), not an
    // unavailable-tool/error placeholder — this is what the original suite never actually
    // checked (see the fakeDeps() comment above).
    const round2Messages = fetchStub.calls[1].messages as Array<{ role: string; content: unknown }>
    const toolMsg = round2Messages.find((m) => m.role === 'tool')
    assert.equal(toolMsg?.content, '3')
  } finally { fetchStub.restore() }
})

test('a tool call outside the allow-list stalls the run durably instead of executing it', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db) // agent's tools: ['run_code'] only
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([
    { choices: [{ message: { content: 'let me check', tool_calls: [{ id: 'c1', function: { name: 'fetch_url', arguments: '{"url":"http://example.invalid"}' } }] } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'needs_approval' })
    const reloaded = db.getRoutineRun(run.id)
    assert.equal(reloaded?.status, 'needs_approval')
    assert.match(reloaded?.pendingToolCall ?? '', /fetch_url/)
  } finally { fetchStub.restore() }
})

test('a same-call loop past LOOP_ABORT_AFTER errors out instead of looping forever', async () => {
  const { d, db } = fakeDeps({ customAgents: [{ ...AGENT, tools: ['run_code'] }] })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const sameCall = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'run_code', arguments: '{"code":"return 1"}' } }] } }] }
  const fetchStub = stubFetch(Array(10).fill(sameCall))
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'errored')
    assert.match((outcome as { error: string }).error, /identical arguments/)
  } finally { fetchStub.restore() }
})

test('resumeChatRoutine on approve (tool already in the normal allow-list) executes it for real and continues to a final answer', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const conv = db.createConversation({ kind: 'agent', modelKey: 'm', systemPrompt: AGENT.systemPrompt, agentId: AGENT.id })
  db.addMessage(conv.id, 'user', r.prompt)
  const pending: PendingRoutineToolCall = {
    convId: conv.id, assistantContent: '', precedingCalls: [],
    call: { id: 'c1', name: 'run_code', args: { code: 'return 40+2' } }, // pretend this was the blocked one
  }
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'Resumed and done.' } }] }])
  try {
    const outcome = await resumeChatRoutine(d, r, run, pending, 'allow', new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'Resumed and done.' })
    // I2 regression: exactly one user turn in the resumed wire conversation, not two.
    const sent = fetchStub.calls[0].messages as Array<{ role: string; content: unknown }>
    assert.equal(sent.filter((m) => m.role === 'user').length, 1)
    // The approved call's REAL result ('42') must be what reached the engine.
    const toolMsg = sent.find((m) => m.role === 'tool')
    assert.equal(toolMsg?.content, '42')
  } finally { fetchStub.restore() }
})

test('resumeChatRoutine on deny errors out without calling the engine', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const pending: PendingRoutineToolCall = { convId: 'irrelevant', assistantContent: '', precedingCalls: [], call: { id: 'c1', name: 'run_code', args: {} } }
  const fetchStub = stubFetch([])
  try {
    const outcome = await resumeChatRoutine(d, r, run, pending, 'deny', new AbortController().signal)
    assert.equal(outcome.status, 'errored')
    assert.match((outcome as { error: string }).error, /denied/)
    assert.equal(fetchStub.calls.length, 0)
  } finally { fetchStub.restore() }
})

// ── C1 regression: approve must ACTUALLY execute the call, not just unblock it ──────────────
// The original resumeChatRoutine passed `agentAllowedTools: agent.tools` when executing the
// just-approved call — but that call is, BY CONSTRUCTION, the one tool NOT in agent.tools (that
// mismatch is exactly why it stalled). executeToolCallWithApproval's non-interactive branch
// checks `agentAllowedTools?.includes(name)`, found it missing, and fed the model a "Blocked:
// this tool requires interactive approval..." string — so approve silently behaved like deny,
// except it reported {status:'ok'} once the model glossed over the blocked-tool message. None
// of the pre-existing tests caught this because they all approved a tool that was ALREADY in
// the agent's allow-list — this test deliberately approves one that is NOT.
test('C1: resumeChatRoutine on approve for a tool OUTSIDE the normal allow-list actually executes it, not a "Blocked" placeholder', async () => {
  const { d, db } = fakeDeps({ customAgents: [{ ...AGENT, tools: ['fetch_url'] }] }) // run_code NOT allowed
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const conv = db.createConversation({ kind: 'agent', modelKey: 'm', systemPrompt: AGENT.systemPrompt, agentId: AGENT.id })
  db.addMessage(conv.id, 'user', r.prompt)
  const pending: PendingRoutineToolCall = {
    convId: conv.id, assistantContent: '', precedingCalls: [],
    call: { id: 'c1', name: 'run_code', args: { code: 'return 21*2' } },
  }
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'The answer is 42.' } }] }])
  try {
    const outcome = await resumeChatRoutine(d, r, run, pending, 'allow', new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'The answer is 42.' })
    const sent = fetchStub.calls[0].messages as Array<{ role: string; content: unknown }>
    const toolMsg = sent.find((m) => m.role === 'tool')
    assert.ok(toolMsg, 'expected a tool-role reply for the approved call')
    assert.doesNotMatch(String(toolMsg?.content), /Blocked/)
    assert.equal(toolMsg?.content, '42')
  } finally { fetchStub.restore() }
})

// ── I1/I4 regression: an earlier round's real tool activity must survive a later stall ──────
test("I1: resuming after a later-round stall still carries an earlier round's real tool activity to the engine", async () => {
  const { d, db } = fakeDeps({ customAgents: [{ ...AGENT, tools: ['run_code'] }] })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })

  let pending: PendingRoutineToolCall
  const fetchStub1 = stubFetch([
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'run_code', arguments: '{"code":"return 21+21"}' } }] } }] },
    { choices: [{ message: { content: 'checking something else', tool_calls: [{ id: 'c2', function: { name: 'delete_database', arguments: '{}' } }] } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'needs_approval' })
    const reloaded = db.getRoutineRun(run.id)
    const parsed = parsePendingToolCall(reloaded?.pendingToolCall)
    assert.ok(parsed)
    pending = parsed!
  } finally { fetchStub1.restore() }

  const fetchStub2 = stubFetch([{ choices: [{ message: { content: 'All done.' } }] }])
  try {
    const outcome2 = await resumeChatRoutine(d, r, run, pending!, 'allow', new AbortController().signal)
    assert.equal(outcome2.status, 'ok')
    const sent = fetchStub2.calls[0].messages as Array<{ role: string; content: unknown }>
    // Round 1's real run_code result ('42') must still be present in the resumed wire
    // conversation — not silently dropped because it belonged to an already-completed round.
    const roundOneToolMsg = sent.find((m) => m.role === 'tool' && String(m.content) === '42')
    assert.ok(roundOneToolMsg, "round 1's real run_code result must still be present in the resumed wire conversation")
    // And exactly one user turn overall (I2 must hold here too).
    assert.equal(sent.filter((m) => m.role === 'user').length, 1)
  } finally { fetchStub2.restore() }
})

// ── Phase 4 / C1: an unattended run must NEVER claim code authorization ─────────────────────
// Both executeToolCallWithApproval call sites in chat-runner.ts pass `isCodeAuthorized: false`
// deliberately: a timer-fired run has no inbound HTTP request to run codeGateBlocks against, and
// unattended code execution must not be able to author or fire MORE of itself. That choice was
// pinned only by a comment — flipping either site to `true` left the whole suite green. These two
// capture what actually reaches ToolRegistry.executeTool, so the flip is now a test failure.

/** A ToolRegistry double recording executeTool's 2nd argument. buildToolDefinitions is stubbed to
 *  the one tool the agent allows, since runChatRoundLoop calls it before the loop. */
function capturingTools(toolName: string): { tools: ToolRegistry; seen: unknown[] } {
  const seen: unknown[] = []
  const tools = {
    buildToolDefinitions: async () => [{ type: 'function', function: { name: toolName, description: '', parameters: {} } }],
    executeTool: async (_call: unknown, isCodeAuthorized?: unknown) => { seen.push(isCodeAuthorized); return 'captured' },
  } as unknown as ToolRegistry
  return { tools, seen }
}

test('C1: runChatRoundLoop executes every tool call with isCodeAuthorized false', async () => {
  const { tools, seen } = capturingTools('run_code')
  const { d, db } = fakeDeps({ tools })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'run_code', arguments: '{"code":"return 1"}' } }] } }] },
    { choices: [{ message: { content: 'done' } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'ok')
    assert.deepStrictEqual(seen, [false], 'a scheduled, unattended run must never present itself as code-authorized')
  } finally { fetchStub.restore() }
})

test('C1: resumeChatRoutine replays the just-approved call with isCodeAuthorized false', async () => {
  const { tools, seen } = capturingTools('run_code')
  const { d, db } = fakeDeps({ tools })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const conv = db.createConversation({ kind: 'agent', modelKey: 'm', systemPrompt: AGENT.systemPrompt, agentId: AGENT.id })
  db.addMessage(conv.id, 'user', r.prompt)
  const pending: PendingRoutineToolCall = {
    convId: conv.id, assistantContent: '', precedingCalls: [],
    call: { id: 'c1', name: 'create_routine', args: { flavor: 'code' } },
  }
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'Resumed.' } }] }])
  try {
    const outcome = await resumeChatRoutine(d, r, run, pending, 'allow', new AbortController().signal)
    assert.equal(outcome.status, 'ok')
    // A human approving ONE stalled tool call is not a standing grant to author/fire code routines,
    // and there is still no HTTP request to authorize against on this path.
    assert.deepStrictEqual(seen, [false])
  } finally { fetchStub.restore() }
})

// ── An unattended run may not author, edit or fire a routine on an MCP agent ────────────────
// chat-runner.ts runs every tool an agent lists with no approval, and a caller who may not use
// the owner's MCP tools (a keyless Serve identity, Access JWT or open-LAN peer) may still create a
// plain agent listing the routine tools, a chat routine on it, confirm it and run it. Its run then
// rewrote the prompt of the owner's routine on an MCP agent and fired it, running that MCP tool
// for the caller unapproved. Both runner call sites pass refuseMcpAgentsAndRoutines; these use the
// real registry over the real routine store, so a call site that drops it fails here.

const MCP_TOOL = 'mcp__srv_1__run'
const OWNER_MCP_AGENT = { id: 'owner-mcp', name: 'Shell', description: '', systemPrompt: '', skillIds: [], tools: [MCP_TOOL] }

/** The owner's MCP agent with an active chat routine on it, a plain confirmed routine, and a real
 *  ToolRegistry over the same routine store and agent list chat-runner.ts reads. */
function mcpRoutineDeps(callerTools: string[]) {
  const agents = [{ ...AGENT, tools: callerTools }, structuredClone(OWNER_MCP_AGENT)]
  const { d, db } = fakeDeps({ customAgents: agents })
  const fired: string[] = []
  const runNow = async (id: string) => { fired.push(id); return { ok: true as const } }
  const agentStore = { snapshot: () => ({ customAgents: agents }), update: (fn: (cfg: { customAgents: typeof agents }) => void) => fn({ customAgents: agents }) }
  Object.assign(d, { tools: new ToolRegistry({ search: {}, sandbox: {}, mcpServers: [] } as never, db, runNow, agentStore as never) })
  // Created on the MCP agent directly: a stored routine's agentId cannot change (routine() edits).
  const ownerRoutine = db.createRoutine({ flavor: 'chat', prompt: 'owner prompt', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: OWNER_MCP_AGENT.id })
  db.confirmRoutine(ownerRoutine.id, '2099-01-01T00:00:00.000Z')
  const plainRoutine = routine(db, { prompt: 'plain prompt' })
  db.confirmRoutine(plainRoutine.id, '2099-01-01T00:00:00.000Z')
  return { d, db, agents, fired, ownerRoutine, plainRoutine }
}

function toolCallRound(calls: Array<[string, Record<string, unknown>]>) {
  return { choices: [{ message: { content: null, tool_calls: calls.map(([name, args], i) => ({ id: `c${i + 1}`, function: { name, arguments: JSON.stringify(args) } })) } }] }
}

test("a routine's run cannot give an agent the owner's MCP tool, or author, edit or run a chat routine on one; the plain routine and the MCP tool itself are untouched", async () => {
  const { d, db, agents, fired, ownerRoutine, plainRoutine } = mcpRoutineDeps(['create_agent', 'create_routine', 'update_routine', 'run_routine_now'])
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const hourly = { kind: 'interval', everyMs: 3_600_000 }
  const fetchStub = stubFetch([
    toolCallRound([
      ['create_agent', { name: 'Mine', systemPrompt: 'attacker prompt', tools: [MCP_TOOL] }],
      ['create_routine', { flavor: 'chat', prompt: 'attacker prompt', scheduleDisplay: 'hourly', scheduleRule: hourly, modelKey: 'm', agentId: OWNER_MCP_AGENT.id }],
      ['update_routine', { routineId: ownerRoutine.id, prompt: 'attacker prompt', confirm: true }],
      ['run_routine_now', { routineId: ownerRoutine.id }],
      ['update_routine', { routineId: plainRoutine.id, prompt: 'new plain prompt', confirm: true }],
      ['run_routine_now', { routineId: plainRoutine.id }],
    ]),
    { choices: [{ message: { content: 'done' } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'ok')
    const results = (fetchStub.calls[1].messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'tool').map((m) => String(m.content))
    assert.equal(results.length, 6)
    assert.match(results[0], /An agent that uses an MCP server tool/)
    for (const refused of results.slice(1, 4)) assert.match(refused, /A routine whose agent uses an MCP server tool/)
    assert.match(results[4], /Updated routine /)
    assert.match(results[5], /is running now/)
    assert.deepEqual(agents.map((a) => a.id), [AGENT.id, OWNER_MCP_AGENT.id], 'no agent may be created')
    assert.equal(db.listRoutines().length, 3, 'no routine may be created')
    assert.equal(db.getRoutine(ownerRoutine.id)?.prompt, 'owner prompt', "the owner's MCP routine may not be edited")
    assert.equal(db.getRoutine(plainRoutine.id)?.prompt, 'new plain prompt')
    assert.deepEqual(fired, [plainRoutine.id], "the owner's MCP routine may not be fired")
  } finally { fetchStub.restore() }

  // The owner's own MCP routine still runs its MCP tool: it reaches the MCP lookup (no server is
  // connected here) rather than the refusal a live keyless chat gets.
  const ownerRun = db.createRoutineRun({ routineId: ownerRoutine.id, configSnapshot: JSON.stringify(ownerRoutine) })
  const ownerStub = stubFetch([toolCallRound([[MCP_TOOL, {}]]), { choices: [{ message: { content: 'done' } }] }])
  try {
    assert.equal((await runChatRoutine(d, db.getRoutine(ownerRoutine.id)!, ownerRun, new AbortController().signal)).status, 'ok')
    const toolMsg = (ownerStub.calls[1].messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'tool')
    assert.match(String(toolMsg?.content), /MCP server "srv-1" not connected/)
  } finally { ownerStub.restore() }
})

test("an approved stalled call in a routine's run cannot edit or fire the owner's routine on an MCP agent", async () => {
  // The run's agent lists no routine tool; the call it stalled on is approved through
  // /runs/:runId/approve, which a caller who may not use MCP tools may do for a non-MCP call.
  for (const [name, args] of [['update_routine', { prompt: 'attacker prompt', confirm: true }], ['run_routine_now', {}]] as const) {
    const { d, db, fired, ownerRoutine } = mcpRoutineDeps(['run_code'])
    const r = routine(db)
    const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
    const conv = db.createConversation({ kind: 'agent', modelKey: 'm', systemPrompt: AGENT.systemPrompt, agentId: AGENT.id })
    db.addMessage(conv.id, 'user', r.prompt)
    const pending: PendingRoutineToolCall = {
      convId: conv.id, assistantContent: '', precedingCalls: [],
      call: { id: 'c1', name, args: { ...args, routineId: ownerRoutine.id } },
    }
    const fetchStub = stubFetch([{ choices: [{ message: { content: 'Resumed.' } }] }])
    try {
      assert.equal((await resumeChatRoutine(d, r, run, pending, 'allow', new AbortController().signal)).status, 'ok')
      const toolMsg = (fetchStub.calls[0].messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'tool')
      assert.match(String(toolMsg?.content), /A routine whose agent uses an MCP server tool/, name)
      assert.equal(db.getRoutine(ownerRoutine.id)?.prompt, 'owner prompt', name)
      assert.deepEqual(fired, [], name)
    } finally { fetchStub.restore() }
  }
})

// ── I3 regression: a mid-request failure/abort must resolve, never throw uncaught ───────────
test('I3: a network failure inside a round resolves to an errored outcome instead of throwing', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const original = globalThis.fetch
  globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'errored')
    assert.match((outcome as { error: string }).error, /Engine request failed/)
  } finally { globalThis.fetch = original }
})

test('I3: an aborted signal mid-fetch resolves to the standard cancelled message, not an uncaught AbortError', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const ac = new AbortController()
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    ac.abort()
    throw new DOMException('The operation was aborted.', 'AbortError')
  }) as typeof fetch
  try {
    const outcome = await runChatRoutine(d, r, run, ac.signal)
    assert.deepEqual(outcome, { status: 'errored', error: 'Routine run timed out or was cancelled.' })
  } finally { globalThis.fetch = original }
})
