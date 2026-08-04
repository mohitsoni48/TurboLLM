import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { GenerationGate } from '../agents/gate'
import {
  CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS, runCliInteractiveRoutine, sweepInteractiveCliRuns,
  type CliInteractiveDeps, type CliInteractiveSweepDeps,
} from './cli-interactive-runner'
import type { CreateAgentTerminalResult } from '../terminal/terminal-routes'
import type { Routine, RoutineRun } from './schema'

function freshStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), 'cli-interactive-runner-test-')))
}

function interactiveRoutine(store: ConversationStore, overrides: Partial<Parameters<ConversationStore['createRoutine']>[0]> = {}): Routine {
  const r = store.createRoutine({
    flavor: 'code',
    prompt: 'Review open PRs and leave comments',
    scheduleDisplay: 'every 5m',
    scheduleRule: { kind: 'interval', everyMs: 300_000 },
    modelKey: 'pinned-model',
    workspacePath: '/repo',
    codingAgent: 'claude_cli',
    permissionMode: 'ask',
    ...overrides,
  })
  return store.confirmRoutine(r.id, new Date().toISOString()) ?? r
}

function schedulerRun(store: ConversationStore, routine: Routine): RoutineRun {
  // Exactly what scheduler.ts's tick() does before calling runRoutine(routine, run).
  return store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
}

interface TerminalRecorder {
  calls: Array<{ agentRunId: string; opts: { mode: string; firstMessage: string } }>
  createTerminal: CliInteractiveDeps['createTerminal']
}
function recordingTerminal(result: CreateAgentTerminalResult = { ok: true, terminalId: 'term-1' }): TerminalRecorder {
  const calls: TerminalRecorder['calls'] = []
  return {
    calls,
    createTerminal: async (agentRun, opts) => {
      calls.push({ agentRunId: agentRun.id, opts })
      return result
    },
  }
}

function baseDeps(overrides: Partial<CliInteractiveDeps> = {}): CliInteractiveDeps {
  return {
    store: overrides.store ?? freshStore(),
    gate: overrides.gate ?? new GenerationGate(),
    getLoadedModelKey: overrides.getLoadedModelKey ?? (() => 'pinned-model'),
    getEngineIdle: overrides.getEngineIdle ?? (() => true),
    loadExplicit: overrides.loadExplicit ?? (async () => ({ target: 'http://127.0.0.1:8081' })),
    now: overrides.now ?? (() => new Date('2026-08-01T10:00:00.000Z')),
    isAvailable: overrides.isAvailable ?? (async () => true),
    createTerminal: overrides.createTerminal ?? recordingTerminal().createTerminal,
    isTerminalActive: overrides.isTerminalActive ?? (() => true),
    isAgentExited: overrides.isAgentExited ?? (() => false),
    getExitCode: overrides.getExitCode ?? (() => undefined),
    killTerminal: overrides.killTerminal ?? (() => {}),
    releaseParked: overrides.releaseParked,
  }
}

function neverCreatesTerminal(): CliInteractiveDeps['createTerminal'] {
  return async () => { assert.fail('createTerminal must not be called on this path') }
}

// ── Happy path ───────────────────────────────────────────────────────────────────────────────

test('happy path: spawns a real Code session + terminal and parks the run at needs_approval', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const rec = recordingTerminal({ ok: true, terminalId: 'term-1' })
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({ store, createTerminal: rec.createTerminal }))

  assert.equal(status, 'needs_approval')
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.status, 'needs_approval')
  assert.equal(persisted.endedAt, undefined, 'a parked run has not ended')
  assert.ok(persisted.codeSessionId, 'the run must link to the real Code session it created')

  const agentRun = store.getAgentRun(persisted.codeSessionId!)!
  assert.equal(agentRun.codeAgent, 'claude')
  assert.equal(agentRun.repoRoot, '/repo')
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0].agentRunId, agentRun.id)
  assert.equal(rec.calls[0].opts.mode, 'ask')
  assert.equal(rec.calls[0].opts.firstMessage, routine.prompt)
})

test('the created conversation carries the routine prompt as its first message, for the run history', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  await runCliInteractiveRoutine(routine, run, baseDeps({ store }))

  const persisted = store.getRoutineRun(run.id)!
  const agentRun = store.getAgentRun(persisted.codeSessionId!)!
  const messages = store.getConversation(agentRun.convId, true)!.messages
  assert.equal(messages?.[0]?.role, 'user')
  assert.equal(messages?.[0]?.content, routine.prompt)
})

test('permissionMode defaults to ask when the routine somehow has none', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store, { permissionMode: undefined })
  const run = schedulerRun(store, routine)
  const rec = recordingTerminal()
  await runCliInteractiveRoutine(routine, run, baseDeps({ store, createTerminal: rec.createTerminal }))
  assert.equal(rec.calls[0].opts.mode, 'ask')
})

test('plan mode is passed through to the terminal unchanged', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store, { permissionMode: 'plan' })
  const run = schedulerRun(store, routine)
  const rec = recordingTerminal()
  await runCliInteractiveRoutine(routine, run, baseDeps({ store, createTerminal: rec.createTerminal }))
  assert.equal(rec.calls[0].opts.mode, 'plan')
})

// ── Preconditions ────────────────────────────────────────────────────────────────────────────

test('CLI not available: skips with skipReason cli_unavailable, never creates a terminal', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store, isAvailable: async () => false, createTerminal: neverCreatesTerminal(),
  }))
  assert.equal(status, 'skipped')
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.skipReason, 'cli_unavailable')
  assert.equal(persisted.endedAt, '2026-08-01T10:00:00.000Z')
})

// ── Model-conflict decision (spec 20 §5), same rule as the one-shot path ──────────────────────

test('different model loaded, engine busy: skips model_busy, never creates a terminal', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const gate = new GenerationGate()
  const release = await gate.acquire('fg')
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store, gate, getLoadedModelKey: () => 'some-other-model', createTerminal: neverCreatesTerminal(),
  }))
  release()
  assert.equal(status, 'skipped')
  assert.equal(store.getRoutineRun(run.id)!.skipReason, 'model_busy')
})

test('different model loaded, engine idle: swaps via loadExplicit before spawning the terminal', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const events: string[] = []
  const rec = recordingTerminal()
  await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (key) => { events.push(`load:${key}`); return { target: 'http://127.0.0.1:8081' } },
    createTerminal: async (agentRun, opts) => { events.push('spawn'); return rec.createTerminal(agentRun, opts) },
  }))
  assert.deepEqual(events, ['load:pinned-model', 'spawn'])
  assert.equal(store.getRoutineRun(run.id)!.status, 'needs_approval')
})

test('a failed pinned-model load records errored, never creates a terminal', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async () => ({ status: 503, message: "No model matching 'pinned-model' found." }),
    createTerminal: neverCreatesTerminal(),
  }))
  assert.equal(status, 'errored')
  assert.match(store.getRoutineRun(run.id)!.error ?? '', /Could not load pinned model/)
})

// ── Terminal creation failure ────────────────────────────────────────────────────────────────

test('a terminal-creation failure records errored and restores the swapped model', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const loadCalls: string[] = []
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
    createTerminal: async () => ({ ok: false, status: 500, code: 'create_failed', message: 'spawn ENOENT' }),
  }))
  assert.equal(status, 'errored')
  const persisted = store.getRoutineRun(run.id)!
  assert.match(persisted.error ?? '', /spawn ENOENT/)
  assert.ok(persisted.endedAt)
  assert.deepEqual(loadCalls, ['pinned-model', 'some-other-model'], 'the swap must still be undone on a failed spawn')
})

// ── sweepInteractiveCliRuns: the two completion signals + the wall-clock safety net ───────────

function sweepDeps(overrides: Partial<CliInteractiveSweepDeps> = {}): CliInteractiveSweepDeps {
  return {
    store: overrides.store ?? freshStore(),
    now: overrides.now ?? (() => new Date('2026-08-01T10:00:00.000Z')),
    loadExplicit: overrides.loadExplicit ?? (async () => ({ target: 'http://127.0.0.1:8081' })),
    isTerminalActive: overrides.isTerminalActive ?? (() => true),
    isAgentExited: overrides.isAgentExited ?? (() => false),
    getExitCode: overrides.getExitCode ?? (() => undefined),
    killTerminal: overrides.killTerminal ?? (() => {}),
    releaseParked: overrides.releaseParked,
  }
}

/** Puts a run into exactly the state `runCliInteractiveRoutine` leaves it in: parked, linked to a
 *  real codeSessionId, no pendingToolCall. */
function parkedRun(store: ConversationStore, routineOverrides: Partial<Parameters<ConversationStore['createRoutine']>[0]> = {}): RoutineRun {
  const routine = interactiveRoutine(store, routineOverrides)
  const run = schedulerRun(store, routine)
  const conv = store.createConversation({ kind: 'code', modelKey: routine.modelKey })
  const agentRun = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/repo', codeAgent: 'claude' })
  store.updateRoutineRun(run.id, { codeSessionId: agentRun.id, status: 'needs_approval' })
  return store.getRoutineRun(run.id)!
}

test('agent exited cleanly (exit 0): finalizes ok and releases the parked guard', () => {
  const store = freshStore()
  const run = parkedRun(store)
  const released: Array<[string, string]> = []
  sweepInteractiveCliRuns(sweepDeps({
    store,
    isAgentExited: () => true,
    getExitCode: () => 0,
    releaseParked: (routineId, runId) => { released.push([routineId, runId]) },
  }))
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.status, 'ok')
  assert.ok(persisted.endedAt)
  assert.deepEqual(released, [[run.routineId, run.id]])
})

test('agent exited with a non-zero code: finalizes errored mentioning the code', () => {
  const store = freshStore()
  const run = parkedRun(store)
  sweepInteractiveCliRuns(sweepDeps({ store, isAgentExited: () => true, getExitCode: () => 1 }))
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.status, 'errored')
  assert.match(persisted.error ?? '', /exited with code 1/)
})

test('terminal gone with no agent-exited report (idle-killed or daemon restart): finalizes errored', () => {
  const store = freshStore()
  const run = parkedRun(store)
  sweepInteractiveCliRuns(sweepDeps({ store, isTerminalActive: () => false, isAgentExited: () => false }))
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.status, 'errored')
  assert.match(persisted.error ?? '', /ended unexpectedly/)
})

test('still active, well within the wall-clock cap: left parked, untouched', () => {
  const store = freshStore()
  const run = parkedRun(store)
  sweepInteractiveCliRuns(sweepDeps({
    store,
    now: () => new Date(new Date(run.startedAt).getTime() + 1000),
  }))
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.status, 'needs_approval')
  assert.equal(persisted.endedAt, undefined)
})

test('still active but past the wall-clock cap: kills the terminal and finalizes errored', () => {
  const store = freshStore()
  const run = parkedRun(store)
  const killed: string[] = []
  sweepInteractiveCliRuns(sweepDeps({
    store,
    now: () => new Date(new Date(run.startedAt).getTime() + CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS + 1),
    killTerminal: (id) => killed.push(id),
  }))
  const persisted = store.getRoutineRun(run.id)!
  assert.equal(persisted.status, 'errored')
  assert.match(persisted.error ?? '', /No approval decision was made/)
  assert.deepEqual(killed, [persisted.codeSessionId])
})

test('exactly at the wall-clock cap is NOT yet a timeout (strictly greater-than)', () => {
  const store = freshStore()
  const run = parkedRun(store)
  sweepInteractiveCliRuns(sweepDeps({
    store,
    now: () => new Date(new Date(run.startedAt).getTime() + CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS),
  }))
  assert.equal(store.getRoutineRun(run.id)!.status, 'needs_approval')
})

test('a pi tool-approval stall (pendingToolCall set, chat/pi codingAgent) is left completely untouched', () => {
  const store = freshStore()
  const routine = store.createRoutine({
    flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1',
  })
  const confirmed = store.confirmRoutine(routine.id, new Date().toISOString())!
  const run = store.createRoutineRun({ routineId: confirmed.id, configSnapshot: JSON.stringify(confirmed) })
  store.updateRoutineRun(run.id, {
    status: 'needs_approval',
    pendingToolCall: JSON.stringify({ convId: 'c1', assistantContent: '', precedingCalls: [], call: { id: 'x', name: 'web_search', args: {} } }),
  })
  let sweepTouchedIt = false
  sweepInteractiveCliRuns(sweepDeps({
    store,
    isTerminalActive: () => { sweepTouchedIt = true; return true },
    isAgentExited: () => { sweepTouchedIt = true; return false },
  }))
  assert.equal(sweepTouchedIt, false, 'a pi stall has no codeSessionId path here at all')
  assert.equal(store.getRoutineRun(run.id)!.status, 'needs_approval', 'must not be finalized by this sweep')
})

test('a non-claude_cli code routine (pi) parked run is left untouched even with a codeSessionId', () => {
  const store = freshStore()
  const routine = store.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm',
    workspacePath: '/repo', codingAgent: 'pi',
  })
  const confirmed = store.confirmRoutine(routine.id, new Date().toISOString())!
  const run = store.createRoutineRun({ routineId: confirmed.id, configSnapshot: JSON.stringify(confirmed) })
  const conv = store.createConversation({ kind: 'code', modelKey: 'm' })
  const agentRun = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/repo', codeAgent: 'pi' })
  store.updateRoutineRun(run.id, {
    status: 'needs_approval', codeSessionId: agentRun.id,
    pendingToolCall: JSON.stringify({ convId: conv.id, assistantContent: '', precedingCalls: [], call: { id: 'x', name: 'run_shell', args: {} } }),
  })
  sweepInteractiveCliRuns(sweepDeps({ store, isTerminalActive: () => false, isAgentExited: () => false }))
  assert.equal(store.getRoutineRun(run.id)!.status, 'needs_approval', 'this module only ever acts on codingAgent claude_cli')
})

test('idempotent: sweeping an already-finalized run twice does not double-release or re-finalize', () => {
  const store = freshStore()
  const run = parkedRun(store)
  const released: Array<[string, string]> = []
  const deps = sweepDeps({ store, isAgentExited: () => true, getExitCode: () => 0, releaseParked: (r, i) => released.push([r, i]) })
  sweepInteractiveCliRuns(deps)
  sweepInteractiveCliRuns(deps)
  assert.equal(released.length, 1, 'the second sweep must see status is no longer needs_approval and skip')
  assert.equal(store.getRoutineRun(run.id)!.status, 'ok')
})

test('a swap-then-run whose interactive run later finalizes restores the previously-loaded model', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store)
  const run = schedulerRun(store, routine)
  const loadCalls: string[] = []
  await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
  }))
  assert.deepEqual(loadCalls, ['pinned-model'], 'no restore yet — the run is still parked, not finalized')

  sweepInteractiveCliRuns(sweepDeps({
    store,
    isAgentExited: () => true,
    getExitCode: () => 0,
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
  }))
  assert.deepEqual(loadCalls, ['pinned-model', 'some-other-model'], 'restore happens once the run actually finalizes')
})
