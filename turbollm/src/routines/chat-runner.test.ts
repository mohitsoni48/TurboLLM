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
import type { PendingRoutineToolCall } from './approval'
import type { Deps } from '../deps'

const AGENT = { id: 'agent-1', name: 'Researcher', description: '', systemPrompt: 'You research things.', skillIds: [], tools: ['web_search'] }

function fakeDeps(overrides: Partial<{ customAgents: typeof AGENT[] }> = {}): { d: Deps; db: ConversationStore } {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'chat-runner-test-')))
  const d = {
    db,
    store: { snapshot: () => ({ customAgents: overrides.customAgents ?? [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }) },
    manager: { status: () => ({ state: 'running', model: { key: 'm', name: 'm', quant: '', ctx: 8192, vision: false } }), target: () => 'http://engine.invalid.local:1' },
    registry: { active: () => ({ kind: 'llama-server' }) },
    tools: new ToolRegistry({ search: {}, sandbox: {}, mcpServers: [] } as never),
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

test('a tool call within the allow-list executes and the loop continues to a final answer', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"query":"open prs"}' } }] } }] },
    { choices: [{ message: { content: 'Found 3 open PRs.' } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'ok')
  } finally { fetchStub.restore() }
})

test('a tool call outside the allow-list stalls the run durably instead of executing it', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db) // agent's tools: ['web_search'] only
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const fetchStub = stubFetch([
    { choices: [{ message: { content: 'let me check', tool_calls: [{ id: 'c1', function: { name: 'run_code', arguments: '{"code":"1+1"}' } }] } }] },
  ])
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.deepEqual(outcome, { status: 'needs_approval' })
    const reloaded = db.getRoutineRun(run.id)
    assert.equal(reloaded?.status, 'needs_approval')
    assert.match(reloaded?.pendingToolCall ?? '', /run_code/)
  } finally { fetchStub.restore() }
})

test('a same-call loop past LOOP_ABORT_AFTER errors out instead of looping forever', async () => {
  const { d, db } = fakeDeps({ customAgents: [{ ...AGENT, tools: ['web_search'] }] })
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const sameCall = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }
  const fetchStub = stubFetch(Array(10).fill(sameCall))
  try {
    const outcome = await runChatRoutine(d, r, run, new AbortController().signal)
    assert.equal(outcome.status, 'errored')
    assert.match((outcome as { error: string }).error, /identical arguments/)
  } finally { fetchStub.restore() }
})

test('resumeChatRoutine on approve executes the approved call and continues to a final answer', async () => {
  const { d, db } = fakeDeps()
  const r = routine(db)
  const run = db.createRoutineRun({ routineId: r.id, configSnapshot: JSON.stringify(r) })
  const conv = db.createConversation({ kind: 'agent', modelKey: 'm', systemPrompt: AGENT.systemPrompt, agentId: AGENT.id })
  db.addMessage(conv.id, 'user', r.prompt)
  const pending: PendingRoutineToolCall = {
    convId: conv.id, assistantContent: '', precedingCalls: [],
    call: { id: 'c1', name: 'web_search', args: { query: 'x' } }, // pretend this was the blocked one
  }
  const fetchStub = stubFetch([{ choices: [{ message: { content: 'Resumed and done.' } }] }])
  try {
    const outcome = await resumeChatRoutine(d, r, run, pending, 'allow', new AbortController().signal)
    assert.deepEqual(outcome, { status: 'ok', result: 'Resumed and done.' })
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
