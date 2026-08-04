// turbollm/src/routines/chat-runner.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
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

function fakeDeps(overrides: Partial<{ customAgents: typeof AGENT[]; tools: ToolRegistry }> = {}): { d: Deps; db: ConversationStore } {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'chat-runner-test-')))
  const d = {
    db,
    store: { snapshot: () => ({ customAgents: overrides.customAgents ?? [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }) },
    manager: { status: () => ({ state: 'running', model: { key: 'm', name: 'm', quant: '', ctx: 8192, vision: false } }), target: () => 'http://engine.invalid.local:1' },
    registry: { active: () => ({ kind: 'llama-server' }) },
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
