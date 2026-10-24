// turbollm/src/routines/execute.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { executeRoutine, resumeRoutineRun, runCliRoutineBranch, runCliInteractiveBranch } from './execute'
import { runCliCodeRoutine, type CliRoutineDeps } from './cli-routine'
import { runCliInteractiveRoutine, sweepInteractiveCliRuns, terminalLookupsBySession, type CliInteractiveDeps } from './cli-interactive-runner'
import { VERSION_PROBE_DEADLINE_MS } from './cli-preflight'
import type { BoundedRunCommand } from '../cli-launch'
import { parsePendingToolCall, stallRoutineRun } from './approval'
import type { Deps } from '../deps'
import type { Manager } from '../engines/manager'
import type { ModelRouter } from '../gateway/model-router'
import { GenerationGate } from '../agents/gate'
import { CodeRunManager, type CodeSessionRunner } from '../code/code-run-manager'
import type { RoutineRunStatus } from './schema'
import { tmpDir } from '../test-support/tmp'
import { realEngineSetUp } from '../test-support/stand-in-engine'
import { TerminalManager } from '../terminal/terminal-manager'
import { isTerminalBackendAvailable, getTerminalManager } from '../terminal/terminal-routes'
import { PTYSession } from '../terminal/pty-session'

const AGENT = { id: 'agent-1', name: 'A', description: '', systemPrompt: '', skillIds: [], tools: [] as string[] }

function fakeDeps(opts: { loadedKey: string | null; activeRequests?: number; gate?: GenerationGate; autotuneRunning?: boolean }): { d: Deps; db: ConversationStore; loadCalls: string[]; reloadCalls: string[][] } {
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const loadCalls: string[] = []
  // withPinnedModel's restore hands a restore a ComfyUI render refused to reloadAfterRender (model-swap.ts).
  const reloadCalls: string[][] = []
  let current = opts.loadedKey
  const manager = {
    status: () => ({ state: 'running', model: current ? { key: current } : null }),
    sessionStats: () => ({ activeRequests: opts.activeRequests ?? 0 }),
    target: () => 'http://engine.invalid.local:1',
    currentOpts: () => null,
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async (key: string) => { loadCalls.push(key); current = key; return { target: 'http://x' } },
    reloadAfterRender: (modelKey: string, routineModelKey: string) => { reloadCalls.push([modelKey, routineModelKey]) },
  } as unknown as ModelRouter
  const d = {
    db, manager, modelRouter,
    registry: { active: () => ({ kind: 'llama-server' }) },
    store: {
      snapshot: () => ({ customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 }, daemon: { port: 6996 } }),
      // Only ever read by TerminalManager's constructor (orphan-safety pidfile dir) when
      // runCliInteractiveBranch's `getTerminalManager(d)` builds the module singleton for the
      // first time in this process — a real tmp dir keeps that harmless in tests that never
      // actually spawn a PTY (they replace `_runInteractive` before it would be reached).
      dir: () => tmpDir('execute-test-terminals-'),
    },
    gate: opts.gate,
    bench: { isRunning: () => opts.autotuneRunning ?? false },
  } as unknown as Deps
  return { d, db, loadCalls, reloadCalls }
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

test('ComfyUI busy on swap-in: skips with skipReason comfyui_busy, not errored (ADR-386)', async () => {
  const { d, db, reloadCalls } = fakeDeps({ loadedKey: 'other' })
  // Force the swap-in load itself to report ComfyUI's own busy refusal, the same shape
  // ModelRouter.loadExplicit returns when its ComfyUI-sharing guard is holding the model.
  ;(d.modelRouter as unknown as ModelRouter).loadExplicit = async () =>
    ({ status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' })
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
  assert.equal(runs[0].skipReason, 'comfyui_busy')
  assert.equal(status, 'skipped')
  assert.equal(fetchCalled, false)
  assert.deepEqual(reloadCalls, [['other', 'm']], "the render's release reloads the user's model, not the routine's")
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

// `--port`/`--addr` (the Android app's 7000, `turbollm --port 8080`) win over daemon.port, so the
// routine's ANTHROPIC_BASE_URL must use the port the listener really bound, or claude dials 6996.
test('claude_cli codingAgent: ANTHROPIC_BASE_URL uses the bound port, not the configured one', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  d.bindPort = 7000
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let captured: CliRoutineDeps | undefined
  await runCliRoutineBranch(d, routine, run, async (_routine, deps) => {
    captured = deps
    deps.store.updateRoutineRun(deps.existingRun!.id, { status: 'skipped', skipReason: 'cli_unavailable', endedAt: new Date().toISOString() })
  })
  assert.equal(captured?.port, 7000)
})

// `--addr [::1]:6996` binds nothing on 127.0.0.1: the routine's CLI must be told the bound address.
test('claude_cli codingAgent: the routine gets the address the listener is bound to', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  d.bindHost = '::1'
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let captured: CliRoutineDeps | undefined
  await runCliRoutineBranch(d, routine, run, async (_routine, deps) => {
    captured = deps
    deps.store.updateRoutineRun(deps.existingRun!.id, { status: 'skipped', skipReason: 'cli_unavailable', endedAt: new Date().toISOString() })
  })
  assert.equal(captured?.host, '::1')
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

// ── ask/plan dispatch: the interactive (live-terminal) branch, sibling to the CLI branch above ──
// (cli-interactive-runner.ts). "auto" stays on the one-shot `-p` path (already covered above);
// "ask"/"plan" can actually hit a permission prompt, so those route here instead.

test('executeRoutine routes a claude_cli routine with permissionMode "ask" to the interactive branch, not the one-shot branch', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let cliBranchCalled = false
  let interactiveSeen: { routine: typeof routine; run: typeof run } | undefined
  const status = await executeRoutine(
    d, routine, run,
    async () => { cliBranchCalled = true; return 'ok' },
    async (_d, r, rn) => { interactiveSeen = { routine: r, run: rn }; return 'needs_approval' },
  )

  assert.equal(cliBranchCalled, false, 'ask must never reach the one-shot non-interactive branch')
  assert.ok(interactiveSeen, 'the interactive branch must actually be reached')
  assert.equal(interactiveSeen.routine, routine)
  assert.equal(interactiveSeen.run, run)
  assert.equal(status, 'needs_approval')
})

test('executeRoutine routes a claude_cli routine with permissionMode "plan" to the interactive branch too', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'plan' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let interactiveCalled = false
  const status = await executeRoutine(
    d, routine, run,
    async () => { assert.fail('plan must not reach the one-shot branch'); return 'errored' },
    async () => { interactiveCalled = true; return 'needs_approval' },
  )
  assert.equal(interactiveCalled, true)
  assert.equal(status, 'needs_approval')
})

test('executeRoutine keeps permissionMode "auto" on the one-shot branch, never the interactive one', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let cliBranchCalled = false
  const status = await executeRoutine(
    d, routine, run,
    async () => { cliBranchCalled = true; return 'ok' },
    async () => { assert.fail('auto must not reach the interactive branch'); return 'errored' },
  )
  assert.equal(cliBranchCalled, true)
  assert.equal(status, 'ok')
})

// Auto-tune runs its probes on the primary and never raises activeRequests, so engineIsIdle() read idle all through a
// tune, and a routine that came due swapped the probe's model out: the tune failed, its stopEngine() stopped the
// routine's model mid-run, and the restore left the tuned model loaded with the router's flags as the model last
// loaded. A running tune reads busy on every routine path.
test('a chat routine that comes due during auto-tune skips with model_busy and never swaps', async () => {
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'tuned-model', autotuneRunning: true })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let fetchCalled = false
  const original = globalThis.fetch
  globalThis.fetch = (async () => { fetchCalled = true; return new Response('{}', { status: 200 }) }) as typeof fetch
  let status: RoutineRunStatus
  try {
    status = await executeRoutine(d, routine, run)
  } finally { globalThis.fetch = original }
  assert.equal(status, 'skipped')
  assert.equal(db.getRoutineRun(run.id)!.skipReason, 'model_busy')
  assert.deepEqual(loadCalls, [])
  assert.equal(fetchCalled, false)
})

test('an Approve during auto-tune answers model_busy and leaves the run awaiting approval', async () => {
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'tuned-model', autotuneRunning: true })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const conv = db.createConversation({ kind: 'agent', modelKey: 'm' })
  stallRoutineRun(db, run.id, { convId: conv.id, assistantContent: '', precedingCalls: [], call: { id: 'c1', name: 'not_allowed_tool', args: {} } })

  const res = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow')

  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'model_busy')
  assert.equal(db.getRoutineRun(run.id)!.status, 'needs_approval')
  assert.deepEqual(loadCalls, [])
})

test('both CLI branches read a running auto-tune as busy', async () => {
  const freeGate = { stats: () => ({ inFlight: 0, queued: 0, capacity: 1 }) } as unknown as GenerationGate
  const capture = async (autotuneRunning: boolean): Promise<boolean[]> => {
    const { d, db } = fakeDeps({ loadedKey: 'tuned-model', gate: freeGate, autotuneRunning })
    const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
    const idle: boolean[] = []
    await runCliRoutineBranch(d, routine, db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) }), async (_r, deps) => {
      idle.push(deps.getEngineIdle())
      deps.store.updateRoutineRun(deps.existingRun!.id, { status: 'ok', endedAt: new Date().toISOString() })
    })
    await runCliInteractiveBranch(d, routine, db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) }), async (_r, rr, deps) => {
      idle.push(deps.getEngineIdle())
      deps.store.updateRoutineRun(rr.id, { status: 'ok', endedAt: new Date().toISOString() })
      return 'ok'
    })
    return idle
  }
  assert.deepEqual(await capture(true), [false, false], 'a tune in progress must read as BUSY')
  assert.deepEqual(await capture(false), [true, true])
})

// The CLI restores pass `restoreAfter` (ModelRouter.undoSwapRecord): a wiring that drops it left a keep-N 2 restore
// that found the user's model still running with the routine's model recorded as the one last loaded. The behaviour is
// tested in cli-routine.test.ts and cli-interactive-runner.test.ts against a real router.
test("both CLI branches pass a restore's options on to ModelRouter.loadExplicit", async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const calls: unknown[][] = []
  ;(d.modelRouter as unknown as ModelRouter).loadExplicit = async (...args: unknown[]) => { calls.push(args); return { target: 'x' } }
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const swap = { target: 'x', lastLoaded: { replaced: { modelKey: 'user-model', engineId: 'e' }, recorded: { modelKey: 'm', engineId: 'e' } } }
  await runCliRoutineBranch(d, routine, run, async (_routine, deps) => {
    await deps.loadExplicit('user-model', undefined, { restoreAfter: swap })
    deps.store.updateRoutineRun(run.id, { status: 'ok', endedAt: new Date().toISOString() })
  })
  await runCliInteractiveBranch(d, routine, db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) }), async (_routine, rr, deps) => {
    await deps.loadExplicit('user-model', undefined, { restoreAfter: swap })
    deps.store.updateRoutineRun(rr.id, { status: 'ok', endedAt: new Date().toISOString() })
    return 'ok'
  })

  assert.deepEqual(calls, [['user-model', undefined, { restoreAfter: swap }], ['user-model', undefined, { restoreAfter: swap }]])
})

test('runCliInteractiveBranch is wired with the right deps and reuses the scheduler-created run', async () => {
  const gate = { stats: () => ({ inFlight: 0, queued: 0, capacity: 1 }) } as unknown as GenerationGate
  const { d, db } = fakeDeps({ loadedKey: 'm', gate })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  let captured: CliInteractiveDeps | undefined
  const status = await runCliInteractiveBranch(d, routine, run, async (_routine, _run, deps) => {
    captured = deps
    // Stand in for the real orchestrator — never actually spawns a terminal (createTerminal is
    // NOT called), so this test needs no real node-pty/TerminalManager behaviour, only its wiring.
    deps.store.updateRoutineRun(run.id, { status: 'needs_approval' })
    return 'needs_approval'
  })

  assert.equal(status, 'needs_approval', "must return the orchestrator's own status verbatim")
  assert.ok(captured)
  assert.equal(captured.store, db)
  assert.equal(captured.gate, gate, 'must reuse the Deps gate instance, never construct a new one')
  assert.equal(captured.getLoadedModelKey(), 'm')
  assert.equal(db.listRoutineRuns(routine.id).length, 1, 'the scheduler-created run must be reused, not duplicated')
})

// TerminalManager is keyed by its own terminal id, so every kickoff lookup must map
// the Code session id first (the shared terminalLookupsBySession wiring cli.ts's sweep uses).
// Handing the session id straight through misses every time. Patches the prototype, which only the
// real manager has, so without node-pty this is skipped rather than passing vacuously on the stub.
test('runCliInteractiveBranch: the terminal lookups map the Code session id to the terminal id', { skip: !isTerminalBackendAvailable() && 'node-pty not installed' }, async (t) => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const proto = TerminalManager.prototype
  t.mock.method(proto, 'findByCodeSessionId', (sessionId: string) => (sessionId === 'session-1' ? 'terminal-1' : null))
  t.mock.method(proto, 'isActive', (id: string) => id === 'terminal-1')
  t.mock.method(proto, 'isAgentExited', (id: string) => id === 'terminal-1')
  t.mock.method(proto, 'getExitCode', (id: string) => (id === 'terminal-1' ? 3 : undefined))
  const killed: string[] = []
  t.mock.method(proto, 'kill', (id: string) => { killed.push(id) })

  let captured: CliInteractiveDeps | undefined
  await runCliInteractiveBranch(d, routine, run, async (_routine, _run, deps) => {
    captured = deps
    deps.store.updateRoutineRun(run.id, { status: 'needs_approval' })
    return 'needs_approval'
  })

  assert.ok(captured)
  assert.equal(captured.isTerminalActive('session-1'), true)
  assert.equal(captured.isAgentExited('session-1'), true)
  assert.equal(captured.getExitCode('session-1'), 3)
  captured.killTerminal('session-1')
  assert.deepEqual(killed, ['terminal-1'])
})

test('a hung interactive kickoff still drives the run to a terminal state within its (shorter) wall-clock bound', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const startedAt = Date.now()
  const status = await runCliInteractiveBranch(d, routine, run, () => new Promise<never>(() => { /* never settles */ }), 25)
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 2000, `expected the 25ms bound to win, took ${elapsed}ms`)
  assert.equal(status, 'errored')
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'errored')
  assert.match(finalRun.error ?? '', /kickoff limit/)
  assert.ok(finalRun.endedAt)
})

// A model swap can take far longer than the kickoff bound (each load may take up to the manager's
// 600 s readiness limit). Counting it against the bound made every fire of a routine pinned to a
// slow-loading model load it, abandon the run, reload the previous model and never start the CLI.
function slowSwapKickoff(): { d: Deps; db: ConversationStore; loads: string[]; routine: ReturnType<ConversationStore['createRoutine']>; run: ReturnType<ConversationStore['createRoutineRun']> } {
  const { d, db } = fakeDeps({ loadedKey: 'small-model' })
  const loads: string[] = []
  // The production wiring's own loadExplicit (d.modelRouter), slower than the 25 ms bound below.
  ;(d.modelRouter as unknown as ModelRouter).loadExplicit = async (key: string) => { loads.push(key); await new Promise((res) => setTimeout(res, 150)); return { target: 'x' } }
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'big-model', workspacePath: '/repo', codingAgent: 'opencode_cli', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  return { d, db, loads, routine, run }
}

test('a model swap slower than the interactive kickoff bound still launches the CLI', async () => {
  let terminalsSpawned = 0
  const createTerminal: CliInteractiveDeps['createTerminal'] = async () => { terminalsSpawned++; return { ok: true, terminalId: 't' } }
  const { d, db, loads, routine, run } = slowSwapKickoff()
  const status = await runCliInteractiveBranch(d, routine, run, (r, rr, deps) =>
    runCliInteractiveRoutine(r, rr, { ...deps, isAvailable: async () => true, createTerminal }), 25)
  assert.equal(status, 'needs_approval')
  assert.equal(terminalsSpawned, 1)
  assert.equal(db.getRoutineRun(run.id)!.status, 'needs_approval')
  assert.deepEqual(loads, ['big-model'], 'the pinned model stays loaded for the run')
})

// The bound is only paused for the swap: a step after it that hangs is still cut off, the CLI never
// starts afterwards, and the swap is undone.
test('the interactive kickoff bound is re-armed after the model swap', async () => {
  let terminalsSpawned = 0
  const createTerminal: CliInteractiveDeps['createTerminal'] = async () => { await new Promise((res) => setTimeout(res, 150)); terminalsSpawned++; return { ok: true, terminalId: 't' } }
  const { d, db, loads, routine, run } = slowSwapKickoff()
  let kickoffDone!: Promise<RoutineRunStatus>
  const status = await runCliInteractiveBranch(d, routine, run, (r, rr, deps) => {
    kickoffDone = runCliInteractiveRoutine(r, rr, { ...deps, isAvailable: async () => true, createTerminal, killTerminal: () => {} })
    return kickoffDone
  }, 25)
  assert.equal(status, 'errored')
  assert.equal(await kickoffDone, 'errored')
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'errored', 'must not flip back to needs_approval')
  assert.match(finalRun.error ?? '', /interactive opencode CLI session exceeded the 25ms kickoff limit/)
  assert.ok(finalRun.endedAt)
  assert.deepEqual(loads, ['big-model', 'small-model'], 'the swap made for the abandoned run is undone')
})

// A routine's terminal is created server-side and nobody may ever open it. TerminalManager's own
// idle reaper (every 60 s, 5 min without a viewer) used to kill it, CLI and all, after about 5-6
// minutes, and the next routine sweep then finalized the run as 'ended unexpectedly'. The routine
// sweep owns its lifetime up to the 30-minute bound. Real TerminalManager and createAgentTerminal;
// only the PTY itself is faked.
test('an unattended interactive routine terminal outlives the 5-minute idle reaper, up to the routine bound', { skip: !isTerminalBackendAvailable() && 'node-pty not installed' }, async (t) => {
  t.mock.method(PTYSession, 'spawn', () => {
    let exited = false
    return {
      onData: () => {}, onExit: () => {}, getPid: () => 0, write: () => {}, resize: () => {}, getScrollback: () => '',
      dispose: () => { exited = true }, isExited: () => exited,
    }
  })
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: tmpDir('execute-routine-terminal-'), codingAgent: 'opencode_cli', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const status = await runCliInteractiveBranch(d, routine, run, (r, rr, deps) => runCliInteractiveRoutine(r, rr, { ...deps, isAvailable: async () => true }))
  assert.equal(status, 'needs_approval')
  const tm = getTerminalManager(d)
  const codeSessionId = db.getRoutineRun(run.id)!.codeSessionId!
  const terminalId = tm.findByCodeSessionId(codeSessionId)
  assert.ok(terminalId)
  try {
    // What the manager's own 60 s sweep sees six minutes later, with no viewer ever attached.
    ;(tm as unknown as { idleSince: Map<string, number> }).idleSince.set(terminalId, Date.now() - 6 * 60_000)
    tm.cleanupIdle()
    const sweepDeps = { store: db, loadExplicit: d.modelRouter.loadExplicit, reloadAfterRender: () => {}, ...terminalLookupsBySession(() => tm) }
    sweepInteractiveCliRuns({ ...sweepDeps, now: () => new Date(Date.now() + 6 * 60_000) })
    assert.equal(db.getRoutineRun(run.id)!.status, 'needs_approval', 'the run is still in progress')
    assert.equal(tm.isActive(terminalId), true)
    // The routine's own 30-minute bound still ends it.
    sweepInteractiveCliRuns({ ...sweepDeps, now: () => new Date(Date.now() + 31 * 60_000) })
    assert.equal(db.getRoutineRun(run.id)!.status, 'errored')
    assert.match(db.getRoutineRun(run.id)!.error ?? '', /No approval decision was made/)
    assert.equal(tm.findByCodeSessionId(codeSessionId), null)
  } finally {
    tm.kill(terminalId)
  }
})

test('an interactive kickoff abandoned while its terminal is being started closes that terminal again', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const killed: string[] = []
  let sessionId = ''
  let kickoffDone!: Promise<RoutineRunStatus>
  const status = await runCliInteractiveBranch(d, routine, run, (r, rr, deps) => {
    kickoffDone = runCliInteractiveRoutine(r, rr, {
      ...deps,
      isAvailable: async () => true,
      // A terminal start that outlasts the bound and does not itself honour the abort.
      createTerminal: async (agentRun) => { sessionId = agentRun.id; await new Promise((res) => setTimeout(res, 150)); return { ok: true, terminalId: 't' } },
      killTerminal: (id) => { killed.push(id) },
    })
    return kickoffDone
  }, 25)
  assert.equal(status, 'errored')
  assert.equal(await kickoffDone, 'errored')
  assert.deepEqual(killed, [sessionId])
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'errored', 'must not flip back to needs_approval')
  assert.match(finalRun.error ?? '', /kickoff limit/)
})

// I2 (re-review): the CLI branch skips createRunDeadline() on purpose (gate self-deadlock), which
// left it with NO wall-clock backstop at all. runCliCodeRoutine's very first await —
// `deps.isAvailable()` -> cli-preflight -> cli-launch.ts's `realRunCommand` — had no timer and
// settled only on the child's 'error'/'exit' events, so a wedged `claude --version` (reproduced
// live) never settled. That probe has a deadline of its own now (isCliAvailable,
// realRunCommandWithin), at which the run is skipped (the cli_unavailable tests further down); the
// race still covers any other unbounded await in the orchestrator, which is what the stand-in
// below models: an orchestrator call that never resolves. Without the Promise.race the run row
// stays 'running' with no endedAt forever and the scheduler's inFlight guard for this routine
// never clears, so it silently stops firing. The timeout is injected (25ms) so the bound is proven
// without a slow test.
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

// The same for the one-shot path: the wall-clock bound covers the model swap, which can outlast it. Once
// the bound has written 'errored' (and the scheduler has released the routine), the still-running
// orchestrator used to go on to spawn the CLI behind that row — a second fire could then run in the
// same workspace — and to overwrite the row with the CLI's own outcome.
const CLI_OK_STDOUT = '{"type":"result","is_error":false,"result":"done"}'
test('a one-shot CLI run that outlasts its bound during the model swap never spawns the CLI afterwards', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'big-model', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let spawned = 0
  const loads: string[] = []
  let runDone!: Promise<void>
  const status = await runCliRoutineBranch(d, routine, run, (r, deps) => {
    runDone = runCliCodeRoutine(r, {
      ...deps,
      isAvailable: async () => true,
      getLoadedModelKey: () => 'small-model',
      getEngineIdle: () => true,
      gate: { stats: () => ({ inFlight: 0, queued: 0, capacity: 1 }) } as unknown as GenerationGate,
      // A model swap slower than the bound.
      loadExplicit: async (key) => { loads.push(key); await new Promise((res) => setTimeout(res, 150)); return { target: 'x' } },
      permissionModeChoices: async () => [],
      runProcess: async () => { spawned++; return { exitCode: 0, timedOut: false, stdout: CLI_OK_STDOUT, stderr: '' } },
    })
    return runDone
  }, 25)
  assert.equal(status, 'errored')
  await runDone
  assert.equal(spawned, 0, 'a timed-out run must not spawn the CLI')
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'errored', 'must not be overwritten by the abandoned run')
  assert.match(finalRun.error ?? '', /wall-clock limit/)
  assert.deepEqual(loads, ['big-model', 'small-model'], 'the swap made for the abandoned run is undone')
})

test('a one-shot CLI run abandoned while the CLI runs kills it and leaves the errored row alone', async () => {
  const { d, db } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let signal: AbortSignal | undefined
  let runDone!: Promise<void>
  const status = await runCliRoutineBranch(d, routine, run, (r, deps) => {
    runDone = runCliCodeRoutine(r, {
      ...deps,
      isAvailable: async () => true,
      permissionModeChoices: async () => [],
      // A CLI that outlasts the bound: it stops when killed (runClaudeCliProcess honours the signal)
      // and otherwise finishes successfully a little later.
      runProcess: (_args, opts) => new Promise((resolve) => {
        signal = opts.signal
        const done = () => resolve({ exitCode: 0, timedOut: false, stdout: CLI_OK_STDOUT, stderr: '' })
        opts.signal?.addEventListener('abort', done)
        setTimeout(done, 150)
      }),
    })
    return runDone
  }, 25)
  assert.equal(status, 'errored')
  await runDone
  assert.equal(signal?.aborted, true, 'the running CLI is killed when the bound gives up on it')
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'errored', 'must not be overwritten by the abandoned run')
  assert.match(finalRun.error ?? '', /wall-clock limit/)
})

// A CLI whose `--version` has not answered by VERSION_PROBE_DEADLINE_MS (realRunCommandWithin ends it then) skips the
// routine's run before the model or the gate is touched. Counted as installed, as the Code agent picker counts it, the
// run would go on with a CLI that does not answer: swap in its pinned model and hold it until the run's own bound (10
// minutes one-shot, up to 30 parked for an interactive run). The preflight is execute.ts's own wiring; only the command
// under it (`_runProbe`) answers 'timeout', as realRunCommandWithin does at the deadline.
function unansweredProbe(): { runProbe: BoundedRunCommand; probed: Array<[string, string[], number]> } {
  const probed: Array<[string, string[], number]> = []
  return { probed, runProbe: async (bin, args, deadlineMs) => { probed.push([bin, args, deadlineMs]); return 'timeout' } }
}

/** A gate that counts every read and acquire, and is otherwise free. */
function countingGate(): { gate: GenerationGate; touched: () => number } {
  let touched = 0
  const gate = {
    stats: () => { touched++; return { inFlight: 0, queued: 0, capacity: 1 } },
    acquire: async () => { touched++; return () => {} },
  } as unknown as GenerationGate
  return { gate, touched: () => touched }
}

test('a one-shot CLI routine whose `claude --version` does not answer is skipped as cli_unavailable, never touching the model or the gate', async (t) => {
  const warned: string[] = []
  t.mock.method(console, 'warn', (line: string) => { warned.push(line) })
  const { gate, touched } = countingGate()
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'small-model', gate })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'big-model', workspacePath: '/repo', codingAgent: 'claude_cli' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const { runProbe, probed } = unansweredProbe()
  let spawned = 0
  const status = await runCliRoutineBranch(d, routine, run, (r, deps) => runCliCodeRoutine(r, {
    ...deps,
    // Never the real CLI, whatever the preflight answers.
    permissionModeChoices: async () => [],
    runProcess: async () => { spawned++; return { exitCode: 0, timedOut: false, stdout: CLI_OK_STDOUT, stderr: '' } },
  }), undefined, runProbe)
  assert.equal(status, 'skipped')
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'skipped')
  assert.equal(finalRun.skipReason, 'cli_unavailable')
  assert.ok(finalRun.endedAt)
  assert.deepEqual(probed, [['claude', ['--version'], VERSION_PROBE_DEADLINE_MS]])
  assert.deepEqual(loadCalls, [], 'the pinned model is never swapped in')
  assert.equal(touched(), 0, 'the gate is never read')
  assert.equal(spawned, 0, 'the CLI never runs')
  assert.deepEqual(warned, [`[routines] \`claude --version\` did not answer within ${VERSION_PROBE_DEADLINE_MS} ms: it was ended, and the routine skips claude`])
})

test('an interactive CLI routine whose `opencode --version` does not answer is skipped as cli_unavailable, never touching the model or the gate', async (t) => {
  const warned: string[] = []
  t.mock.method(console, 'warn', (line: string) => { warned.push(line) })
  const { gate, touched } = countingGate()
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'small-model', gate })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'big-model', workspacePath: '/repo', codingAgent: 'opencode_cli', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const { runProbe, probed } = unansweredProbe()
  let terminals = 0
  const status = await runCliInteractiveBranch(d, routine, run, (r, rr, deps) => runCliInteractiveRoutine(r, rr, {
    ...deps,
    // Never a real terminal, whatever the preflight answers.
    createTerminal: async () => { terminals++; return { ok: true, terminalId: 't' } },
    killTerminal: () => {},
  }), undefined, runProbe)
  assert.equal(status, 'skipped')
  const finalRun = db.getRoutineRun(run.id)!
  assert.equal(finalRun.status, 'skipped')
  assert.equal(finalRun.skipReason, 'cli_unavailable')
  assert.ok(finalRun.endedAt)
  assert.deepEqual(probed, [['opencode', ['--version'], VERSION_PROBE_DEADLINE_MS]], "the routine's own harness is probed")
  assert.deepEqual(loadCalls, [], 'the pinned model is never swapped in')
  assert.equal(touched(), 0, 'the gate is never read')
  assert.equal(terminals, 0, 'no terminal is opened')
  assert.deepEqual(warned, [`[routines] \`opencode --version\` did not answer within ${VERSION_PROBE_DEADLINE_MS} ms: it was ended, and the routine skips opencode`])
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

// An in-app pi Code session acquires the GenerationGate itself before every provider request
// (code-session.ts's before_provider_request hook). executeRoutine used to ALSO hold the gate for
// the whole run, so on a single-slot engine the session queued behind its own routine and the run
// could only ever time out. Real gate + real CodeRunManager; the runner mirrors code-session.ts's
// per-request acquire (with a short timeout so the pre-fix deadlock fails fast instead of hanging).
test('pi Code routine does not deadlock against its own per-request gate acquire on a single-slot engine', async () => {
  const gate = new GenerationGate(() => 1)
  const { d, db } = fakeDeps({ loadedKey: 'm', gate })
  ;(d.store as unknown as { snapshot: () => unknown }).snapshot = () => ({ daemon: { autoGenerateTitles: false } })
  let sessionGotGate = false
  const runner: CodeSessionRunner = (async (params) => {
    const release = await gate.acquire('fg', { signal: params.signal, timeoutMs: 500 })
    sessionGotGate = true
    release()
    return { finalText: 'done', contextUsed: 0, contextMax: 0, aborted: false }
  }) as CodeSessionRunner
  d.codeRuns = new CodeRunManager(d, { runner })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60000 }, modelKey: 'm', workspacePath: tmpDir('execute-pi-gate-'), codingAgent: 'pi', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const status = await executeRoutine(d, routine, run)
  assert.equal(sessionGotGate, true, 'the pi session must be able to take the only engine slot')
  assert.equal(status, 'ok')
  assert.deepEqual(gate.stats(), { inFlight: 0, queued: 0, capacity: 1 })
})

test('resumeRoutineRun does not hold the routine-level gate while a pi Code run is dispatched', async () => {
  let held = 0
  const gate = { acquire: async () => { held++; let done = false; return () => { if (!done) { done = true; held-- } } } } as unknown as GenerationGate
  const { d, db } = fakeDeps({ loadedKey: 'm', gate })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60000 }, modelKey: 'm', workspacePath: tmpDir('execute-pi-gate-'), codingAgent: 'pi', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const conv = db.createConversation({ kind: 'code', modelKey: 'm' })
  stallRoutineRun(db, run.id, { convId: conv.id, assistantContent: '', precedingCalls: [], call: { id: 'c1', name: 'bash', args: {} }, sessionId: conv.id })
  // The deny dispatch writes the run's terminal state; record whether the gate was held then.
  let heldAtDispatch: number | undefined
  const update = db.updateRoutineRun.bind(db)
  db.updateRoutineRun = ((id, patch) => { if (patch.status === 'errored') heldAtDispatch = held; return update(id, patch) }) as typeof db.updateRoutineRun
  const res = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'deny')
  assert.equal(res.ok, true)
  assert.equal(heldAtDispatch, 0)
  assert.equal(held, 0)
  assert.equal(db.getRoutineRun(run.id)!.status, 'errored')
})

// A pi Code routine does not hold the gate for its whole run (see above), but its model swap and
// its restore must still wait for whoever holds the only slot: a chat routine, auto-compaction, a
// title or memory call take the gate without raising activeRequests, so engineIsIdle() alone
// reports the engine idle while they generate, and the swap would stop the engine under them.
function piGateHarness(): { gate: GenerationGate; d: Deps; db: ConversationStore; events: string[]; holdGate: (label: string, ms: number) => Promise<void>; sessionStarted: Promise<void> } {
  const gate = new GenerationGate(() => 1)
  const { d, db } = fakeDeps({ loadedKey: 'user-model', gate })
  ;(d.store as unknown as { snapshot: () => unknown }).snapshot = () => ({ daemon: { autoGenerateTitles: false } })
  const events: string[] = []
  const router = d.modelRouter as unknown as { loadExplicit: (key: string) => Promise<unknown> }
  const load = router.loadExplicit
  router.loadExplicit = (key: string) => { events.push(`load ${key} (gate inFlight=${gate.stats().inFlight})`); return load(key) }
  const holdGate = async (label: string, ms: number) => {
    const release = await gate.acquire('bg')
    events.push(`${label} takes gate`)
    await new Promise((r) => setTimeout(r, ms))
    events.push(`${label} releases gate`)
    release()
  }
  let started!: () => void
  const sessionStarted = new Promise<void>((r) => { started = r })
  const runner: CodeSessionRunner = (async (params) => {
    started()
    const release = await gate.acquire('fg', { signal: params.signal, timeoutMs: 2000 })
    events.push('pi session request')
    release()
    // Leave room for another gate holder to start while the routine's model is loaded.
    await new Promise((r) => setTimeout(r, 30))
    return { finalText: 'done', contextUsed: 0, contextMax: 0, aborted: false }
  }) as CodeSessionRunner
  d.codeRuns = new CodeRunManager(d, { runner })
  return { gate, d, db, events, holdGate, sessionStarted }
}

test('a pi Code routine waits for another gate holder before swapping its model in', async () => {
  const { gate, d, db, events, holdGate } = piGateHarness()
  const routine = db.createRoutine({ flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60000 }, modelKey: 'routine-model', workspacePath: tmpDir('execute-pi-swap-'), codingAgent: 'pi', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const other = holdGate('chat routine', 150)
  await new Promise((r) => setImmediate(r))
  const status = await executeRoutine(d, routine, run)
  await other
  assert.equal(status, 'ok')
  assert.deepEqual(events, [
    'chat routine takes gate',
    'chat routine releases gate',
    'load routine-model (gate inFlight=1)',
    'pi session request',
    'load user-model (gate inFlight=1)',
  ])
  assert.deepEqual(gate.stats(), { inFlight: 0, queued: 0, capacity: 1 })
})

test("a pi Code routine's model restore waits for a gate holder that started during its run", async () => {
  const { gate, d, db, events, holdGate, sessionStarted } = piGateHarness()
  const routine = db.createRoutine({ flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60000 }, modelKey: 'routine-model', workspacePath: tmpDir('execute-pi-restore-'), codingAgent: 'pi', permissionMode: 'auto' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const running = executeRoutine(d, routine, run)
  await sessionStarted
  const other = holdGate('chat routine', 150)
  const status = await running
  await other
  assert.equal(status, 'ok')
  const restore = events.indexOf('load user-model (gate inFlight=1)')
  assert.ok(restore > events.indexOf('chat routine releases gate'), `restore must wait for the other holder: ${JSON.stringify(events)}`)
  assert.deepEqual(gate.stats(), { inFlight: 0, queued: 0, capacity: 1 })
})

// A Deny runs nothing on the engine (both runners end the run without a request), yet it took the
// gate and loaded the routine's model first. While the user chatted it waited and timed out, and
// once the routine's model was gone it answered model_unavailable on every try: the run stayed
// stalled for good.
test("a Deny ends a stalled run without loading the routine's model, even when that model is gone", async () => {
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const stallStub = stubFetchStall()
  try { await executeRoutine(d, routine, run) } finally { stallStub.restore() }
  assert.equal(db.getRoutineRun(run.id)!.status, 'needs_approval')

  // The user has another model loaded now, and the routine's model is no longer in the library.
  ;(d as unknown as { manager: Manager }).manager = {
    status: () => ({ state: 'running', model: { key: 'other' } }),
    sessionStats: () => ({ activeRequests: 0 }),
  } as unknown as Manager
  ;(d.modelRouter as unknown as ModelRouter).loadExplicit = async (key: string) => {
    loadCalls.push(key)
    return { status: 503, message: `No model matching '${key}' found. Add one in TurboLLM.` } // ModelRouter's own answer
  }

  const res = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'deny')
  assert.deepEqual(res, { ok: true })
  const final = db.getRoutineRun(run.id)!
  assert.equal(final.status, 'errored')
  assert.match(final.error ?? '', /denied by user/)
  assert.ok(final.endedAt)
  assert.deepEqual(loadCalls, [], 'nothing is loaded for a Deny')
})

test('a Deny ends a stalled pi Code run at once while another caller holds the gate', async () => {
  const gate = new GenerationGate(() => 1)
  const { d, db, loadCalls } = fakeDeps({ loadedKey: 'other', gate })
  const routine = db.createRoutine({ flavor: 'code', prompt: 'p', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60000 }, modelKey: 'm', workspacePath: tmpDir('execute-pi-deny-'), codingAgent: 'pi', permissionMode: 'ask' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const conv = db.createConversation({ kind: 'code', modelKey: 'm' })
  stallRoutineRun(db, run.id, { convId: conv.id, assistantContent: '', precedingCalls: [], call: { id: 'c1', name: 'bash', args: {} }, sessionId: conv.id })
  const holder = await gate.acquire('fg') // the user's chat turn

  const denied = resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'deny')
  try {
    const res = await Promise.race([denied, new Promise((r) => setTimeout(() => r('still waiting for the gate'), 500))])
    assert.deepEqual(res, { ok: true })
    const final = db.getRoutineRun(run.id)!
    assert.equal(final.status, 'errored')
    assert.match(final.error ?? '', /denied by user/)
    assert.equal(final.pendingToolCall, '')
    assert.deepEqual(loadCalls, [])
    assert.deepEqual(gate.stats(), { inFlight: 1, queued: 0, capacity: 1 }, 'the Deny never queued for the gate')
  } finally {
    holder()
  }
  await denied
})

// A terminal routine's run parks at needs_approval with no pendingToolCall while its CLI runs (and,
// in ask mode, asks) in its own terminal. Approve or Deny on it wrote 'errored' and nothing else:
// the CLI went on running in the workspace, and the user's model, swapped out for the run, was
// never put back (the sweep only looks at parked runs). Real TerminalManager and
// createAgentTerminal; only the PTY is faked. The routine runs in auto mode, where its CLI never
// asks anything, so the run's error does not say it does.
test('Approve or Deny on a parked terminal routine run closes its CLI and restores the user model', { skip: !isTerminalBackendAvailable() && 'node-pty not installed' }, async (t) => {
  t.mock.method(PTYSession, 'spawn', () => {
    let exited = false
    return {
      onData: () => {}, onExit: () => {}, getPid: () => 0, write: () => {}, resize: () => {}, getScrollback: () => '',
      dispose: () => { exited = true }, isExited: () => exited,
    }
  })
  for (const decision of ['allow', 'deny'] as const) {
    const { d, db, loadCalls } = fakeDeps({ loadedKey: 'user-model' })
    const released: string[] = []
    ;(d as unknown as { routineScheduler: unknown }).routineScheduler = { releaseParked: (_routineId: string, runId: string) => { released.push(runId) } }
    const routine = db.createRoutine({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'routine-model', workspacePath: tmpDir('execute-terminal-decide-'), codingAgent: 'opencode_cli', permissionMode: 'auto' })
    const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
    assert.equal(await runCliInteractiveBranch(d, routine, run, (r, rr, deps) => runCliInteractiveRoutine(r, rr, { ...deps, isAvailable: async () => true })), 'needs_approval')
    const tm = getTerminalManager(d)
    const codeSessionId = db.getRoutineRun(run.id)!.codeSessionId!
    const terminalId = tm.findByCodeSessionId(codeSessionId)
    assert.ok(terminalId)
    try {
      const res = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, decision)
      await new Promise((r) => setImmediate(r)) // the restore is started, not awaited (finalizeInteractiveRun)
      assert.equal(res.ok, false)
      assert.equal((res as { code: string }).code, 'no_pending_call')
      const final = db.getRoutineRun(run.id)!
      assert.equal(final.status, 'errored', decision)
      assert.match(final.error ?? '', decision === 'allow' ? /^Closed by Approve: this run's opencode CLI runs in its own terminal, / : /^Closed by Deny: /)
      assert.ok(final.endedAt)
      assert.equal(tm.findByCodeSessionId(codeSessionId), null, `${decision}: the CLI's terminal is closed`)
      assert.deepEqual(loadCalls, ['routine-model', 'user-model'], `${decision}: the user's model is restored`)
      assert.deepEqual(released, [run.id], `${decision}: the routine is released`)
    } finally {
      tm.kill(terminalId)
    }
  }
})

// withPinnedModel can report 'skip-comfyui-busy' without ever running fn. resumeRoutineRun
// used to fall through to {ok:true}, leaving its claim at 'running' forever (and every retry 409).
test('resumeRoutineRun reverts its claim when ComfyUI blocks the model swap', async () => {
  const { d, db, reloadCalls } = fakeDeps({ loadedKey: 'm' })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const stallStub = stubFetchStall()
  try { await executeRoutine(d, routine, run) } finally { stallStub.restore() }
  assert.equal(db.getRoutineRun(run.id)!.status, 'needs_approval')

  // A different model is now loaded and ComfyUI is holding the swap.
  ;(d as unknown as { manager: Manager }).manager = {
    status: () => ({ state: 'running', model: { key: 'other' } }),
    sessionStats: () => ({ activeRequests: 0 }),
  } as unknown as Manager
  ;(d.modelRouter as unknown as ModelRouter).loadExplicit = async () =>
    ({ status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' })

  const res = await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow')
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'model_busy')
  assert.equal(db.getRoutineRun(run.id)!.status, 'needs_approval', 'the claim must be reverted so Approve can be retried')
  assert.deepEqual(reloadCalls, [['other', 'm']], "the render's release reloads the user's model, not the routine's")
})

// ── keep-N 2: a chat routine runs on its own model, in its pool slot ─────────────────────────────
// Against a real ConfigStore, Manager and ModelRouter and a stand-in llama-server. With keep-N 2 or more the routine's
// swap loads its model into a pool slot and the user's model stays in the primary, but every turn went to the primary
// with the primary's model: the routine's result was the user's model's answer, recorded 'ok'. A routine pinned to a
// model already in a pool slot did the same on every run (the swap finds it there and changes nothing).
async function keepN2ChatRoutine(t: Parameters<typeof realEngineSetUp>[0], reply: () => Record<string, unknown>) {
  const set = await realEngineSetUp(t)
  t.after(() => set.modelRouter.stopPoolSlotsOnEngine('fake', { force: true }))
  set.store.update((c) => { c.gateway.keepN = 2; c.customAgents = [AGENT] })
  assert.ok('target' in await set.modelRouter.loadExplicit(set.userModel.key))
  const db = new ConversationStore(IN_MEMORY_DATA_DIR)
  const d = { db, manager: set.manager, modelRouter: set.modelRouter, registry: set.registry, store: set.store } as unknown as Deps
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: set.routineModel.key, agentId: 'agent-1' })
  // Only the turns are answered here; the Manager's own /health polls reach the stand-in.
  const calls: Array<{ url: string; model: unknown }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.endsWith('/v1/chat/completions')) return original(input, init)
    calls.push({ url, model: (JSON.parse(init?.body as string) as { model: unknown }).model })
    return new Response(JSON.stringify(reply()), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  // Where the routine's model serves, read back from the router after the run (doLoad's slot fast path; runningOnly
  // loads nothing), not from its saved profile's port: a slot whose pinned port is taken as it spawns comes up on the
  // 8081+ walk instead.
  const routineTarget = async () => {
    const r = await set.modelRouter.loadExplicit(set.routineModel.key, undefined, { runningOnly: true })
    assert.ok('target' in r && r.engineKind, `the routine's model is not in a pool slot: ${JSON.stringify(r)}`)
    assert.notEqual(r.target, set.manager.target(), 'the pool slot is not the primary')
    return `${r.target}/v1/chat/completions`
  }
  return { ...set, d, db, routine, calls, routineTarget }
}

test("with keep-N 2 a chat routine's turns go to its own model in its pool slot, not the user's in the primary", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { d, db, manager, userModel, routineModel, routine, calls, routineTarget } = await keepN2ChatRoutine(t, () => ({ choices: [{ message: { content: 'done' } }] }))
  const userTarget = manager.target()

  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  assert.equal(await executeRoutine(d, routine, run), 'ok')
  assert.deepEqual(calls, [{ url: await routineTarget(), model: routineModel.key }], `the user's model is at ${userTarget}`)
  assert.equal(manager.status().model?.key, userModel.key, "the primary kept the user's model")
})

test('with keep-N 2 a chat routine whose model is already in a pool slot runs there, not in the primary', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { d, db, manager, modelRouter, userModel, routineModel, routine, calls, routineTarget } = await keepN2ChatRoutine(t, () => ({ choices: [{ message: { content: 'done' } }] }))
  // The swap finds the routine's model in its slot (doLoad's fast path) and changes nothing.
  assert.ok('target' in await modelRouter.loadExplicit(routineModel.key))
  assert.equal(manager.status().model?.key, userModel.key)

  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  assert.equal(await executeRoutine(d, routine, run), 'ok')
  assert.deepEqual(calls, [{ url: await routineTarget(), model: routineModel.key }], `the user's model is at ${manager.target()}`)
})

test("with keep-N 2 an Approve resumes a chat routine on its own model in its pool slot", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  let turn = 0
  const { d, db, routineModel, routine, calls, routineTarget } = await keepN2ChatRoutine(t, () => (turn++ === 0
    ? { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'not_allowed_tool', arguments: '{}' } }] } }] }
    : { choices: [{ message: { content: 'done' } }] }))
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  assert.equal(await executeRoutine(d, routine, run), 'needs_approval')

  assert.deepEqual(await resumeRoutineRun(d, db.getRoutineRun(run.id)!, 'allow'), { ok: true })
  assert.equal(db.getRoutineRun(run.id)!.status, 'ok')
  const slot = await routineTarget()
  assert.deepEqual(calls, [{ url: slot, model: routineModel.key }, { url: slot, model: routineModel.key }])
})
