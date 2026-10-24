import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore, IN_MEMORY_DATA_DIR } from '../chat/db'
import { GenerationGate } from '../agents/gate'
import {
  CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS, runCliInteractiveRoutine, sweepInteractiveCliRuns, terminalLookupsBySession,
  type CliInteractiveDeps, type CliInteractiveSweepDeps,
} from './cli-interactive-runner'
import { buildTerminalLaunchCommand, type CreateAgentTerminalResult } from '../terminal/terminal-routes'
import { quotePtyShellArg } from '../util/shell-command'
import type { Routine, RoutineRun } from './schema'
import { realEngineSetUp } from '../test-support/stand-in-engine'

function freshStore(): ConversationStore {
  return new ConversationStore(IN_MEMORY_DATA_DIR)
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
    reloadAfterRender: overrides.reloadAfterRender ?? (() => {}),
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

// With keep-N 1 the routine's model loads into the primary, so Manager.load stops the user's model before the
// routine's own fails to start. Nothing restored it: every run of that routine left the engine empty.
test('a pinned model that fails to load after the user model was stopped reloads the user model', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, userModel, brokenModel } = await realEngineSetUp(t)
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  const store = freshStore()
  const routine = interactiveRoutine(store, { modelKey: brokenModel.key })
  const run = schedulerRun(store, routine)

  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => manager.status().model?.key ?? null,
    loadExplicit: (k) => modelRouter.loadExplicit(k),
    createTerminal: neverCreatesTerminal(),
  }))

  assert.equal(status, 'errored')
  const st = manager.status()
  assert.equal(st.state, 'running', `the user's model is loaded again, got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
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

// ── A prompt the launch command line cannot carry ────────────────────────────────────────────
// The routine's task reaches the CLI only as its seeded opening prompt. An opencode or pi routine
// whose prompt quoted a name or ran past 4000 characters opened an idle CLI that nobody typed
// into, and the run held the routine's swapped-in model until the 30-minute sweep.

test('an opencode routine whose prompt has double quotes and 5,000 characters launches with that prompt', {
  skip: process.platform === 'win32' && 'a Windows launch command cannot carry either (terminal-routes.ts)',
}, async () => {
  const store = freshStore()
  const prompt = `Rename "foo" to "bar" in C:\\repo\\ and explain why. ${'x'.repeat(5000)}`
  const routine = interactiveRoutine(store, { codingAgent: 'opencode_cli', permissionMode: 'auto', prompt })
  const run = schedulerRun(store, routine)
  // The launch command createAgentTerminal builds for it.
  let launchCommand = ''
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    createTerminal: async (agentRun, opts) => {
      launchCommand = buildTerminalLaunchCommand(agentRun.codeAgent!, 6996, 'tok', agentRun.id, false, '--auto', opts.mode, opts.firstMessage)
      return { ok: true, terminalId: 'term-1' }
    },
  }))
  assert.equal(status, 'needs_approval')
  assert.ok(launchCommand.startsWith('turbollm launch opencode --port 6996'), launchCommand.slice(0, 80))
  assert.ok(launchCommand.endsWith(` --prompt ${quotePtyShellArg(prompt)}`), 'the whole prompt is on the command line')
})

test('a prompt the launch command cannot carry ends the run before any model swap', async () => {
  const store = freshStore()
  const routine = interactiveRoutine(store, { codingAgent: 'pi_cli', permissionMode: 'auto', prompt: 'x'.repeat(70 * 1024) })
  const run = schedulerRun(store, routine)
  const loadCalls: string[] = []
  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
    createTerminal: neverCreatesTerminal(),
  }))
  assert.equal(status, 'errored')
  const persisted = store.getRoutineRun(run.id)!
  assert.match(persisted.error ?? '', /prompt cannot be handed to the pi CLI because it is over/)
  assert.ok(persisted.endedAt)
  assert.equal(persisted.codeSessionId, undefined, 'no Code session is created for it')
  assert.deepEqual(loadCalls, [], "the user's model is never swapped out")
})

// ── sweepInteractiveCliRuns: the two completion signals + the wall-clock safety net ───────────

function sweepDeps(overrides: Partial<CliInteractiveSweepDeps> = {}): CliInteractiveSweepDeps {
  return {
    store: overrides.store ?? freshStore(),
    now: overrides.now ?? (() => new Date('2026-08-01T10:00:00.000Z')),
    loadExplicit: overrides.loadExplicit ?? (async () => ({ target: 'http://127.0.0.1:8081' })),
    reloadAfterRender: overrides.reloadAfterRender ?? (() => {}),
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

// ── terminalLookupsBySession: the sweep's real TerminalManager wiring (cli.ts) ─────────────────

/** A TerminalManager stand-in keyed the way the real one is: by its OWN terminal id, with the
 *  Code session id only as an attribute (findByCodeSessionId maps one to the other). */
function fakeTerminals(sessions: Record<string, { codeSessionId: string; agentExited?: boolean; exitCode?: number }>) {
  const live = new Map(Object.entries(sessions))
  const killed: string[] = []
  return {
    killed,
    findByCodeSessionId: (codeSessionId: string) => [...live].find(([, s]) => s.codeSessionId === codeSessionId)?.[0] ?? null,
    isActive: (id: string) => live.has(id),
    isAgentExited: (id: string) => live.get(id)?.agentExited === true,
    getExitCode: (id: string) => live.get(id)?.exitCode,
    kill: (id: string) => { if (live.delete(id)) killed.push(id) },
  }
}

// With keep-N 2 or more the routine's swap loads its model into a new pool slot and records it as the model last
// loaded, while the user's model stays in the primary. The restore once the run finalized then found the user's model
// running and recorded nothing: the next daemon start, an Engines Start that names no model and the CLI launcher
// brought the routine's model back. The swap's result is kept with the parked run, so the restore can put back what
// the swap's record replaced.
test('with keep-N 2 the restore puts back the model last loaded before the swap', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store: config, manager, modelRouter, userModel, routineModel } = await realEngineSetUp(t)
  t.after(() => modelRouter.stopPoolSlotsOnEngine('fake', { force: true }))
  config.update((c) => { c.gateway.keepN = 2 })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  const store = freshStore()
  const routine = interactiveRoutine(store, { modelKey: routineModel.key })
  const run = schedulerRun(store, routine)
  const loads: Promise<unknown>[] = []
  const loadExplicit: CliInteractiveDeps['loadExplicit'] = (k, overrides, opts) => {
    const p = modelRouter.loadExplicit(k, overrides, opts)
    loads.push(p)
    return p
  }

  assert.equal(await runCliInteractiveRoutine(routine, run, baseDeps({
    store, getLoadedModelKey: () => manager.status().model?.key ?? null, loadExplicit,
  })), 'needs_approval')
  assert.equal(config.snapshot().lastLoaded.modelKey, routineModel.key, "the swap loaded the routine's model into a pool slot")
  sweepInteractiveCliRuns(sweepDeps({ store, loadExplicit, isAgentExited: () => true, getExitCode: () => 0 }))
  await loads[loads.length - 1] // the restore, which the finalize does not wait for

  assert.equal(store.getRoutineRun(run.id)!.status, 'ok')
  assert.equal(manager.status().model?.key, userModel.key, "the primary kept the user's model")
  assert.deepEqual(config.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' }, "the next start resumes the user's model")
})

// A ComfyUI render that begins while the run is parked unloads the routine's model and keeps it for its release() to
// reload. The restore once the run finalized then met the render, was refused and only warned about: when the render
// ended, the guard brought the routine's model back, and the user's model stayed unloaded.
test("a restore refused by a ComfyUI render makes the render's release reload the user's model", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, guard, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  const store = freshStore()
  const routine = interactiveRoutine(store, { modelKey: routineModel.key })
  const run = schedulerRun(store, routine)
  const loads: Promise<unknown>[] = []
  const loadExplicit = (k: string) => { const p = modelRouter.loadExplicit(k); loads.push(p); return p }
  const reloadAfterRender = (k: string, routineKey: string) => modelRouter.reloadAfterRender(k, routineKey)

  assert.equal(await runCliInteractiveRoutine(routine, run, baseDeps({
    store, getLoadedModelKey: () => manager.status().model?.key ?? null, loadExplicit, reloadAfterRender,
  })), 'needs_approval')
  assert.equal(manager.status().model?.key, routineModel.key, 'the CLI runs on the routine model')
  await guard!.acquire() // a render starts while the run is parked
  sweepInteractiveCliRuns(sweepDeps({ store, loadExplicit, reloadAfterRender, isAgentExited: () => true, getExitCode: () => 0 }))
  await loads[loads.length - 1] // the restore, which the finalize does not wait for
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(store.getRoutineRun(run.id)!.status, 'ok')
  assert.equal(guard!.modelKeyLoadedOnRelease(), userModel.key, "the render's release reloads the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
})

// The same render, landing during the swap after Manager.load stopped the user's model (here during the reverse gate's
// /free call): the routine's load is refused, and the run errored with no restore. The render's release then loaded
// the routine's model for a CLI that never ran, and the user's stayed unloaded.
test("a render that begins after the swap stopped the user model makes its release reload the user's model", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, guard, comfyFree, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  comfyFree.hook = () => guard!.acquire()
  const store = freshStore()
  const routine = interactiveRoutine(store, { modelKey: routineModel.key })
  const run = schedulerRun(store, routine)

  const status = await runCliInteractiveRoutine(routine, run, baseDeps({
    store,
    getLoadedModelKey: () => manager.status().model?.key ?? null,
    loadExplicit: (k) => modelRouter.loadExplicit(k),
    reloadAfterRender: (k, routineKey) => modelRouter.reloadAfterRender(k, routineKey),
    createTerminal: neverCreatesTerminal(),
  }))

  assert.equal(status, 'errored')
  assert.equal(guard!.modelKeyLoadedOnRelease(), userModel.key, "the render's release reloads the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
})

test('terminalLookupsBySession: a parked run whose CLI is still running stays parked (session id mapped to terminal id)', () => {
  const store = freshStore()
  const run = parkedRun(store)
  const tm = fakeTerminals({ 'term-1': { codeSessionId: run.codeSessionId! } })
  sweepInteractiveCliRuns(sweepDeps({ store, ...terminalLookupsBySession(() => tm), now: () => new Date(new Date(run.startedAt).getTime() + 1000) }))
  assert.equal(store.getRoutineRun(run.id)!.status, 'needs_approval')
})

test('terminalLookupsBySession: the wall-clock timeout really kills the run\'s terminal', () => {
  const store = freshStore()
  const run = parkedRun(store)
  const tm = fakeTerminals({ 'term-1': { codeSessionId: run.codeSessionId! }, 'term-2': { codeSessionId: 'someone-else' } })
  sweepInteractiveCliRuns(sweepDeps({ store, ...terminalLookupsBySession(() => tm), now: () => new Date(new Date(run.startedAt).getTime() + CLI_INTERACTIVE_ROUTINE_TIMEOUT_MS + 1) }))
  assert.equal(store.getRoutineRun(run.id)!.status, 'errored')
  assert.deepEqual(tm.killed, ['term-1'])
})

test('terminalLookupsBySession: agent exit is read off the mapped terminal; no terminal at all reads as gone', () => {
  const store = freshStore()
  const done = parkedRun(store)
  const gone = parkedRun(store)
  const tm = fakeTerminals({ 'term-1': { codeSessionId: done.codeSessionId!, agentExited: true, exitCode: 0 } })
  sweepInteractiveCliRuns(sweepDeps({ store, ...terminalLookupsBySession(() => tm) }))
  assert.equal(store.getRoutineRun(done.id)!.status, 'ok')
  assert.equal(store.getRoutineRun(gone.id)!.status, 'errored')
  assert.match(store.getRoutineRun(gone.id)!.error ?? '', /ended unexpectedly/)
})
