// turbollm/src/routines/execute.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { executeRoutine, resumeRoutineRun } from './execute'
import type { Deps } from '../deps'
import type { Manager } from '../engines/manager'
import type { ModelRouter } from '../gateway/model-router'
import type { RoutineRunStatus } from './schema'

const AGENT = { id: 'agent-1', name: 'A', description: '', systemPrompt: '', skillIds: [], tools: [] as string[] }

function fakeDeps(opts: { loadedKey: string | null; activeRequests?: number }): { d: Deps; db: ConversationStore; loadCalls: string[] } {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'execute-test-')))
  const loadCalls: string[] = []
  let current = opts.loadedKey
  const manager = {
    status: () => ({ state: 'running', model: current ? { key: current } : null }),
    sessionStats: () => ({ activeRequests: opts.activeRequests ?? 0 }),
    target: () => 'http://engine.invalid.local:1',
  } as unknown as Manager
  const modelRouter = { loadExplicit: async (key: string) => { loadCalls.push(key); current = key; return { target: 'http://x' } } } as unknown as ModelRouter
  const d = {
    db, manager, modelRouter,
    registry: { active: () => ({ kind: 'llama-server' }) },
    store: { snapshot: () => ({ customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }) },
  } as unknown as Deps
  return { d, db, loadCalls }
}

function stubFetchOk(): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 })) as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

function stubFetchStall(): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'not_allowed_tool', arguments: '{}' } }] } }],
  }), { status: 200 })) as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

test('chat flavor, model already loaded: no swap, run finishes ok', async () => {
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  // Mirrors scheduler.ts's tick(): the caller creates the run row BEFORE calling executeRoutine.
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const fetchStub = stubFetchOk()
  let status: RoutineRunStatus
  try {
    status = await executeRoutine(d, routine, run)
  } finally { fetchStub.restore() }
  const runs = db.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'ok')
  assert.equal(status, 'ok')
  assert.equal(loadCalls.length, 0)
})

test('different model loaded and busy: skips with skipReason model_busy, never calls fetch', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'other', activeRequests: 1 })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let fetchCalled = false
  const original = globalThis.fetch
  globalThis.fetch = (async () => { fetchCalled = true; return new Response('{}', { status: 200 }) }) as typeof fetch
  let status: RoutineRunStatus
  try {
    status = await executeRoutine(d, routine, run)
  } finally { globalThis.fetch = original }
  const runs = db.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'skipped')
  assert.equal(runs[0].skipReason, 'model_busy')
  assert.equal(status, 'skipped')
  assert.equal(fetchCalled, false)
})

test('claude_cli codingAgent is a clean not-implemented-yet placeholder, not a crash', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const status = await executeRoutine(d, routine, run)
  const runs = db.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /not implemented/)
  assert.equal(status, 'errored')
})

test('a stalled (needs_approval) outcome is never overwritten by the orchestrator', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const fetchStub = stubFetchStall()
  let status: RoutineRunStatus
  try {
    status = await executeRoutine(d, routine, run)
  } finally { fetchStub.restore() }
  const runs = db.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'needs_approval')
  assert.equal(status, 'needs_approval')
})

test('resumeRoutineRun rejects a run that is not currently needs_approval', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  db.updateRoutineRun(run.id, { status: 'ok' })
  const result = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow')
  assert.equal(result.ok, false)
})

// Reconciliation with scheduler.ts's real RoutineSchedulerDeps.runRoutine contract
// ((routine, run) => Promise<RoutineRunStatus>, scheduler owns run-row creation/finalization):
// proves executeRoutine's RETURN VALUE — the property Task 10's `runRoutine: (routine, run) =>
// executeRoutine(deps, routine, run)` wiring will depend on — actually matches what got written
// to the row, for every terminal-ish outcome this orchestrator can reach. Not redundant with the
// assertions above: those check the DB row; this explicitly checks return-value/DB-row agreement
// as its own property, across all four outcomes in one place.
test("executeRoutine's return value always matches the RoutineRunStatus written to the run row", async () => {
  // ok
  {
    const { d, db } = fakeDeps({ loadedKey: 'm' })
    const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
    const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    const fetchStub = stubFetchOk()
    let status: RoutineRunStatus
    try { status = await executeRoutine(d, routine, run) } finally { fetchStub.restore() }
    assert.equal(status, 'ok')
    assert.equal(status, db.getRoutineRun(run.id)!.status)
  }
  // skipped (model busy)
  {
    const { d, db } = fakeDeps({ loadedKey: 'other', activeRequests: 1 })
    const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
    const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    const status = await executeRoutine(d, routine, run)
    assert.equal(status, 'skipped')
    assert.equal(status, db.getRoutineRun(run.id)!.status)
  }
  // errored (claude_cli placeholder)
  {
    const { d, db } = fakeDeps({ loadedKey: 'm' })
    const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
    const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    const status = await executeRoutine(d, routine, run)
    assert.equal(status, 'errored')
    assert.equal(status, db.getRoutineRun(run.id)!.status)
  }
  // needs_approval
  {
    const { d, db } = fakeDeps({ loadedKey: 'm' })
    const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
    const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    const fetchStub = stubFetchStall()
    let status: RoutineRunStatus
    try { status = await executeRoutine(d, routine, run) } finally { fetchStub.restore() }
    assert.equal(status, 'needs_approval')
    assert.equal(status, db.getRoutineRun(run.id)!.status)
  }
})

// Additional test beyond the brief's 5: verifies the idempotency guard added to
// resumeRoutineRun (see execute.ts's doc comment on that function, and progress.md's Task 7
// "minor (deferred)" finding this closes). Two concurrent resumeRoutineRun calls for the SAME
// stalled run must not both dispatch the approved action — exactly one should succeed, the
// other must fail cleanly with 'not_stalled' rather than starting a second continuation turn.
test('resumeRoutineRun guards against a double-dispatch on the same stalled run', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const stallStub = stubFetchStall()
  try {
    await executeRoutine(d, routine, run)
  } finally { stallStub.restore() }
  const stalledRun = db.getRoutineRun(run.id)!
  assert.equal(stalledRun.status, 'needs_approval')

  const okStub = stubFetchOk()
  let results: Array<{ ok: boolean; code?: string }>
  try {
    results = await Promise.all([
      resumeRoutineRun(d, stalledRun, 'allow'),
      resumeRoutineRun(d, stalledRun, 'allow'),
    ])
  } finally { okStub.restore() }

  const okCount = results.filter((r) => r.ok).length
  assert.equal(okCount, 1, 'exactly one of the two concurrent resumes should succeed')
  const rejected = results.find((r) => !r.ok) as { ok: false; code: string }
  assert.equal(rejected.code, 'not_stalled')

  // Only one continuation turn should have actually run: the routine's chat conversation
  // (created once by executeRoutine) should show exactly one final assistant answer from the
  // resumed round, not two.
  const finalRun = db.getRoutineRun(stalledRun.id)!
  assert.equal(finalRun.status, 'ok')
})

// Additional test: if dispatch throws instead of resolving to an outcome (an unexpected error
// from the underlying runner plumbing, not one of withPinnedModel's own known outcomes), the
// claim resumeRoutineRun makes before dispatching must still be reverted — otherwise the run is
// permanently stuck at 'running' with no way to ever retry it, which would be worse than the
// pre-idempotency-fix behavior.
test('resumeRoutineRun reverts its claim if dispatch throws instead of resolving', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const stallStub = stubFetchStall()
  try {
    await executeRoutine(d, routine, run)
  } finally { stallStub.restore() }
  const stalledRun = db.getRoutineRun(run.id)!
  assert.equal(stalledRun.status, 'needs_approval')

  // Force withPinnedModel (and therefore the whole dispatch) to throw instead of resolving.
  ;(d as unknown as { manager: Manager }).manager = {
    status: () => { throw new Error('engine exploded') },
  } as unknown as Manager

  await assert.rejects(() => resumeRoutineRun(d, stalledRun, 'allow'), /engine exploded/)
  const reverted = db.getRoutineRun(stalledRun.id)!
  assert.equal(reverted.status, 'needs_approval')
})
