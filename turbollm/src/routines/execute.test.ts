// turbollm/src/routines/execute.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { executeRoutine, resumeRoutineRun, runCliRoutineBranch } from './execute'
import type { CliRoutineDeps } from './cli-routine'
import { parsePendingToolCall } from './approval'
import type { Deps } from '../deps'
import type { Manager } from '../engines/manager'
import type { ModelRouter } from '../gateway/model-router'
import type { GenerationGate } from '../agents/gate'
import type { RoutineRunStatus } from './schema'

const AGENT = { id: 'agent-1', name: 'A', description: '', systemPrompt: '', skillIds: [], tools: [] as string[] }

function fakeDeps(opts: { loadedKey: string | null; activeRequests?: number; gate?: GenerationGate }): { d: Deps; db: ConversationStore; loadCalls: string[] } {
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
    store: { snapshot: () => ({ customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 }, daemon: { port: 6996 } }) },
    gate: opts.gate,
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

// Phase 3, Task 8: what used to be the 'not implemented yet' placeholder here is now a real call
// into cli-routine.ts's self-contained orchestrator. Asserted through runCliRoutineBranch's
// `_runCli` seam because the real orchestrator's very first step probes the installed `claude`
// binary — running it for real would spawn subprocesses and give a different answer on every
// machine.
test('claude_cli codingAgent: the CLI branch is wired with the right deps and reuses the scheduler-created run', async () => {
  const gate = { stats: () => ({ inFlight: 0, queued: 0, capacity: 1 }) } as unknown as GenerationGate
  const { d, db } = fakeDeps({ loadedKey: 'm', gate })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let captured: CliRoutineDeps | undefined
  const status = await runCliRoutineBranch(d, routine, run, async (_routine, deps) => {
    captured = deps
    // Stand in for the real orchestrator: write a terminal state of our own choosing, so the
    // read-back below is proving the branch reports what the ORCHESTRATOR wrote (not a hardcoded
    // status of its own).
    deps.store.updateRoutineRun(deps.existingRun!.id, { status: 'skipped', skipReason: 'cli_unavailable', endedAt: new Date().toISOString() })
  })

  assert.equal(status, 'skipped', "must read the orchestrator's own terminal status back off the row")
  assert.ok(captured)
  // The scheduler-created run is reused — otherwise every fire would write TWO rows.
  assert.equal(captured.existingRun, run)
  assert.equal(db.listRoutineRuns(routine.id).length, 1)
  assert.equal(captured.store, db)
  assert.equal(captured.gate, gate, 'must reuse the Deps gate instance, never construct a new one')
  assert.equal(captured.port, 6996)
  assert.equal(captured.getLoadedModelKey(), 'm')
})

// The single most regression-prone wiring point on this branch: `getEngineIdle` must be
// engineIsIdle(manager) — which reads manager.sessionStats().activeRequests, the ONLY signal that
// observes the main in-app chat stream — and NOT a gate.stats() read. A gate-only busy-check
// reports a live foreground chat as idle and would let a routine hot-swap the model out from under
// it (spec 20 §5). The gate below deliberately says "totally free" so a gate-based implementation
// would answer `true` here and fail.
test('claude_cli codingAgent: getEngineIdle sees a live in-app chat turn that the gate cannot', async () => {
  const freeGate = { stats: () => ({ inFlight: 0, queued: 0, capacity: 1 }) } as unknown as GenerationGate
  const routineOf = (db: ConversationStore) => {
    const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
    return { routine, run: db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) }) }
  }
  const capture = async (activeRequests: number): Promise<boolean> => {
    const { d, db } = fakeDeps({ loadedKey: 'm', activeRequests, gate: freeGate })
    const { routine, run } = routineOf(db)
    let idle: boolean | undefined
    await runCliRoutineBranch(d, routine, run, async (_r, deps) => {
      idle = deps.getEngineIdle()
      deps.store.updateRoutineRun(run.id, { status: 'ok', endedAt: new Date().toISOString() })
    })
    return idle!
  }
  assert.equal(await capture(1), false, 'a streaming chat turn must read as BUSY even though the gate is free')
  assert.equal(await capture(0), true)
})

// I1 (re-review): every claude_cli test above calls `runCliRoutineBranch` DIRECTLY, so the branch
// BODY was covered but the DISPATCH CONDITION in executeRoutine was not — the reviewer replaced it
// with `if (false)` and the whole 1891-test suite stayed green. These two tests drive
// `executeRoutine` itself through its `_runCliBranch` seam, so a deleted/inverted condition or a
// mistyped `codingAgent` literal fails loudly instead of silently routing every scheduled
// CLI-flavor fire into dispatchRoutine's "is not implemented yet" error.
test('executeRoutine routes a claude_cli Code Routine to the CLI branch and never reaches dispatchRoutine', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let seen: { routine: typeof routine; run: typeof run } | undefined
  const status = await executeRoutine(d, routine, run, async (_d, r, rn) => {
    seen = { routine: r, run: rn }
    return 'ok'
  })

  assert.ok(seen, 'the claude_cli dispatch condition must actually reach the CLI branch')
  assert.equal(seen.routine, routine)
  assert.equal(seen.run, run, 'the scheduler-created run row is handed straight through')
  assert.equal(status, 'ok', "executeRoutine must return the CLI branch's status verbatim")
  // dispatchRoutine was never reached: it would have written its 'not implemented yet' error via
  // finalizeOutcome. The row is untouched because the seam here deliberately writes nothing.
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'running')
  assert.equal(finalRun.error, undefined)
})

test('executeRoutine does NOT route a codingAgent: pi Code Routine to the CLI branch', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'pi' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let cliBranchCalled = false
  const status = await executeRoutine(d, routine, run, async () => { cliBranchCalled = true; return 'ok' })

  assert.equal(cliBranchCalled, false, 'the condition must be specific to claude_cli, not match every Code Routine')
  assert.equal(status, 'errored')
  // Proof it went through dispatchRoutine's in-app-pi runner instead (fakeDeps wires no codeRuns).
  assert.match(db.getRoutineRun(run.id)!.error ?? '', /codeRuns not wired/)
})

// I2 (re-review): the CLI branch skips createRunDeadline() on purpose (gate self-deadlock), which
// left it with NO wall-clock backstop at all. runCliCodeRoutine's very first await —
// `deps.isAvailable()` -> cli-preflight -> cli-launch.ts's `realRunCommand` — has no timer and
// settles only on the child's 'error'/'exit' events, so a wedged `claude --version` (reproduced
// live by the reviewer) never settles. The stand-in below models exactly that: an orchestrator
// call that never resolves. Without the Promise.race the run row stays 'running' with no endedAt
// forever and the scheduler's inFlight guard for this routine never clears, so it silently stops
// firing. The timeout is injected (25ms) so the bound is proven without a slow test.
test('a hung claude_cli availability probe still drives the run to a terminal state within the wall-clock bound', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const startedAt = Date.now()
  const status = await runCliRoutineBranch(d, routine, run, () => new Promise<void>(() => { /* never settles: the wedged probe */ }), 25)
  const elapsed = Date.now() - startedAt

  assert.equal(status, 'errored')
  assert.ok(elapsed < 5000, `must be bounded by the injected timeout, took ${elapsed}ms`)
  const finalRun = db.getRoutineRun(run.id)!
  assert.notEqual(finalRun.status, 'running', 'a stranded running row is the one outcome spec 20 §6 rules out')
  assert.equal(finalRun.status, 'errored')
  assert.ok(finalRun.endedAt, 'the terminal row must carry an endedAt so the run is genuinely finished')
  assert.match(finalRun.error ?? '', /wall-clock limit/)
})

// I2 companion: losing the race must not clobber a real outcome the orchestrator wrote in the same
// tick the timer fired — the read-back wins over the synthetic 'errored'.
test('a race timeout still reports the orchestrator\'s own terminal status when it did write one', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const status = await runCliRoutineBranch(d, routine, run, (_r, deps) => {
    deps.store.updateRoutineRun(run.id, { status: 'ok', result: 'done', endedAt: new Date().toISOString() })
    return new Promise<void>(() => { /* wrote its row, then wedged in its finally */ })
  }, 25)

  assert.equal(status, 'ok')
  assert.equal(db.getRoutineRun(run.id)!.result, 'done')
})

// M1 (re-review): the read-back's `?? 'errored'` only caught a MISSING row, but 'running' is a
// real RoutineRunStatus member — a still-running row was returned verbatim, and scheduler.ts's
// writeTerminalStatus would then stamp {status:'running', endedAt}: a row that reads as perpetually
// running yet carries an end time. Unreachable through the real orchestrator, which is exactly why
// it needs a test of its own.
test('runCliRoutineBranch reports errored, not running, when the orchestrator leaves the row unfinished', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  // Resolves normally (no race timeout) but writes nothing, so the row is still 'running'.
  const status = await runCliRoutineBranch(d, routine, run, async () => { /* writes no terminal row */ })
  assert.equal(status, 'errored', "a still-'running' row must fall back to 'errored', as the comment promises")
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
  // M4 fix: the ONLY in-tree way to catch a regression where finalizeOutcome stops returning
  // early for 'needs_approval' (and starts writing its own terminal state on top of what
  // stallRoutineRun already persisted) is to check that nothing else got written — status alone
  // doesn't prove that, since a wrongly-added write could still leave status untouched. endedAt
  // is never set by stallRoutineRun, so it staying unset here proves the orchestrator wrote
  // nothing of its own on this path.
  assert.equal(runs[0].endedAt, undefined)
})

test('resumeRoutineRun rejects a run that is not currently needs_approval', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  db.updateRoutineRun(run.id, { status: 'ok' })
  const result = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow')
  assert.equal(result.ok, false)
})

// M2(c) / C2 item 4: a live-execution review of Task 9's double-fire fix found that a run whose
// pendingToolCall can never be parsed used to stay at 'needs_approval' FOREVER (resumeRoutineRun
// returned early without ever moving the row), which durably re-triggered the exact same
// corrupt_pending_call failure on every retry and left routine-routes.ts's scheduler-release
// logic with no way to ever tell the run was actually done.
test('resumeRoutineRun moves a run with an unparseable pendingToolCall to a real terminal state, not stuck at needs_approval forever', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  // needs_approval but no pendingToolCall at all — parsePendingToolCall(undefined) returns null.
  db.updateRoutineRun(run.id, { status: 'needs_approval' })
  const result = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'corrupt_pending_call')
  const final = db.getRoutineRun(run.id)!
  assert.equal(final.status, 'errored')
  assert.ok(final.endedAt, 'must be a real terminal state, not left at needs_approval indefinitely')
  assert.match(final.error ?? '', /pending tool call could not be read/)

  // A second retry against the SAME permanently-corrupt run must behave identically (idempotent,
  // not throw), rather than assuming it's only ever hit once.
  const secondAttempt = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow')
  assert.equal(secondAttempt.ok, false)
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
  // errored (agent deleted out from under the routine — reaches finalizeOutcome's errored path
  // without any network call. Was the claude_cli placeholder until Phase 3's Task 8 replaced that
  // branch with a real orchestrator call, which cannot run here without spawning a subprocess.)
  {
    const { d, db } = fakeDeps({ loadedKey: 'm' })
    const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'deleted-agent' })
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

// I1 fix: every test above leaves d.gate undefined, so `if (d.gate)` is always false and the
// entire GenerationGate acquire/release/timeout path — including the 'bg' priority literal that
// IS spec 20 §5's "a routine never preempts foreground chat/Code" guarantee — was never actually
// exercised. A regression that changed 'bg' to 'fg', dropped release?.(), or removed the
// gate-timeout write would have shipped green. This test supplies a real (fake) gate.
test("executeRoutine acquires the GenerationGate at 'bg' priority and releases it once the run completes", async () => {
  let capturedPriority: string | undefined
  let releaseCalled = false
  const gate = {
    acquire: async (priority: 'fg' | 'bg') => {
      capturedPriority = priority
      return () => { releaseCalled = true }
    },
  } as unknown as GenerationGate
  const { d, db } = fakeDeps({ loadedKey: 'm', gate })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const fetchStub = stubFetchOk()
  let status: RoutineRunStatus
  try {
    status = await executeRoutine(d, routine, run)
  } finally { fetchStub.restore() }
  assert.equal(capturedPriority, 'bg')
  assert.equal(releaseCalled, true)
  assert.equal(status, 'ok')
})

// I1 fix (continued): the gate-acquire-timeout catch block — {status:'skipped',
// skipReason:'gate_timeout'} plus never dispatching at all — also had zero coverage.
test('a GenerationGate acquire timeout skips the run and never dispatches', async () => {
  const gate = { acquire: async () => { throw new Error('gate acquire timed out') } } as unknown as GenerationGate
  const { d, db } = fakeDeps({ loadedKey: 'm', gate })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let fetchCalled = false
  const original = globalThis.fetch
  globalThis.fetch = (async () => { fetchCalled = true; return new Response('{}', { status: 200 }) }) as typeof fetch
  let status: RoutineRunStatus
  try {
    status = await executeRoutine(d, routine, run)
  } finally { globalThis.fetch = original }
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'skipped')
  assert.equal(finalRun.skipReason, 'gate_timeout')
  assert.equal(status, 'skipped')
  assert.equal(fetchCalled, false)
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
  const pending = parsePendingToolCall(stalledRun.pendingToolCall)!

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

  const finalRun = db.getRoutineRun(stalledRun.id)!
  assert.equal(finalRun.status, 'ok')

  // M4 fix: actually count messages instead of just asserting status — a genuinely
  // double-dispatched resume would append TWO resumed rounds' worth of assistant messages (one
  // tool-call round + one final-answer round, each) to the same conversation, i.e. 4 assistant
  // rows instead of 2. This is what proves "only one continuation turn actually ran," not just
  // "the run ended up ok" (which a double-dispatch could also produce, just wastefully).
  const conv = d.db.getConversation(pending.convId, true)!
  const assistantMessages = (conv.messages ?? []).filter((m) => m.role === 'assistant')
  assert.equal(assistantMessages.length, 2, 'expected exactly one resumed round (tool-call message + final answer), not a double-dispatch')
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
