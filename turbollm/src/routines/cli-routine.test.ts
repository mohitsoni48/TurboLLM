import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { GenerationGate } from '../agents/gate'
import { sessionAuth } from '../code/session-auth'
import { CLI_ROUTINE_TIMEOUT_MS, type CliProcessResult } from './cli-process'
import { runCliCodeRoutine, type CliRoutineDeps } from './cli-routine'
import type { Routine } from './schema'

const OK_STDOUT = '{"type":"result","is_error":false,"result":"done"}'

function freshStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), 'cli-routine-test-')))
}

/** A confirmed (active) CLI-flavor Code Routine. `createRoutine` returns it as
 *  'pending_confirmation'; `confirmRoutine` is what flips it to 'active' and returns the row the
 *  scheduler would actually fire. */
function codeRoutine(store: ConversationStore, overrides: Partial<Parameters<ConversationStore['createRoutine']>[0]> = {}): Routine {
  const r = store.createRoutine({
    flavor: 'code',
    prompt: 'Summarize open PRs',
    scheduleDisplay: 'every 5m',
    scheduleRule: { kind: 'interval', everyMs: 300_000 },
    modelKey: 'pinned-model',
    workspacePath: '/repo',
    codingAgent: 'claude_cli',
    permissionMode: 'auto',
    ...overrides,
  })
  return store.confirmRoutine(r.id, new Date().toISOString()) ?? r
}

interface Recorder {
  calls: Array<{ args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } }>
  runProcess: CliRoutineDeps['runProcess']
}

/** A `runProcess` fake that records everything it was handed. */
function recordingProcess(result: Partial<CliProcessResult> = {}): Recorder {
  const calls: Recorder['calls'] = []
  return {
    calls,
    runProcess: async (args, opts) => {
      calls.push({ args, opts })
      return { exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '', ...result }
    },
  }
}

function baseDeps(overrides: Partial<CliRoutineDeps> = {}): CliRoutineDeps {
  return {
    store: overrides.store ?? freshStore(),
    gate: overrides.gate ?? new GenerationGate(),
    getLoadedModelKey: overrides.getLoadedModelKey ?? (() => 'pinned-model'),
    loadExplicit: overrides.loadExplicit ?? (async () => ({ target: 'http://127.0.0.1:8081' })),
    now: overrides.now ?? (() => new Date('2026-08-01T10:00:00.000Z')),
    port: overrides.port ?? 6996,
    isAvailable: overrides.isAvailable ?? (async () => true),
    permissionModeChoices: overrides.permissionModeChoices ?? (async () => ['auto', 'plan', 'manual']),
    runProcess: overrides.runProcess ?? (async () => ({ exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' })),
    ...(overrides.existingRun ? { existingRun: overrides.existingRun } : {}),
  }
}

/** Fails the test if it is ever called — proves a path never reached the subprocess. */
function neverSpawns(): CliRoutineDeps['runProcess'] {
  return async () => {
    assert.fail('runProcess must not be called on this path')
  }
}

// ── Happy path ────────────────────────────────────────────────────────────────────────────────

test('happy path: available CLI, matching model, successful run records status ok', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({ store }))

  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'ok')
  assert.equal(runs[0].result, 'done')
  assert.equal(runs[0].endedAt, '2026-08-01T10:00:00.000Z')
  assert.equal(runs[0].skipReason, undefined)
})

test('the run row it creates snapshots the routine config, so a later edit cannot rewrite history', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({ store }))

  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].routineId, routine.id)
  // Round-tripped on both sides: JSON.stringify drops the row's `agentId: undefined`.
  assert.deepEqual(JSON.parse(runs[0].configSnapshot), JSON.parse(JSON.stringify(routine)))
})

// ── Preconditions: CLI availability ───────────────────────────────────────────────────────────

test('CLI not available: skips with skipReason cli_unavailable, never spawns', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({ store, isAvailable: async () => false, runProcess: neverSpawns() }))

  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'skipped')
  assert.equal(runs[0].skipReason, 'cli_unavailable')
  assert.equal(runs[0].endedAt, '2026-08-01T10:00:00.000Z')
})

test('CLI not available is decided BEFORE any model swap is attempted', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store,
    isAvailable: async () => false,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
    runProcess: neverSpawns(),
  }))
  assert.deepEqual(loadCalls, [], 'no point swapping models for a CLI that cannot run')
})

// ── Model-conflict decision (spec 20 §5) ──────────────────────────────────────────────────────

test('different model loaded, engine busy: skips with skipReason model_busy, never spawns', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const gate = new GenerationGate()
  const release = await gate.acquire('fg') // hold the single slot: the engine is busy
  await runCliCodeRoutine(routine, baseDeps({
    store, gate, getLoadedModelKey: () => 'some-other-model', runProcess: neverSpawns(),
  }))
  release()

  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'skipped')
  assert.equal(runs[0].skipReason, 'model_busy')
})

test('nothing loaded at all + engine busy also skips as model_busy', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const gate = new GenerationGate()
  const release = await gate.acquire('fg')
  await runCliCodeRoutine(routine, baseDeps({ store, gate, getLoadedModelKey: () => null, runProcess: neverSpawns() }))
  release()

  assert.equal(store.listRoutineRuns(routine.id)[0].skipReason, 'model_busy')
})

test('different model loaded, engine idle: swaps via loadExplicit before spawning', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const events: string[] = []
  const deps = baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (key: string) => { events.push(`load:${key}`); return { target: 'http://127.0.0.1:8081' } },
    runProcess: async () => { events.push('spawn'); return { exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' } },
  })
  await runCliCodeRoutine(routine, deps)

  assert.deepEqual(events, ['load:pinned-model', 'spawn', 'load:some-other-model'])
  assert.equal(store.listRoutineRuns(routine.id)[0].status, 'ok')
})

test('pinned model already loaded: never calls loadExplicit at all', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store,
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
  }))
  assert.deepEqual(loadCalls, [])
})

test('a busy engine does NOT block a routine whose pinned model is already loaded', async () => {
  // The self-deadlock guard, stated as a behaviour: this orchestrator reads gate.stats() and never
  // awaits gate.acquire(). A blocking acquire('bg') here would hang forever behind the fg holder
  // below — and, in production, behind the gateway's own per-turn 'bg' acquisition for the very
  // subprocess this run is waiting on.
  const store = freshStore()
  const routine = codeRoutine(store)
  const gate = new GenerationGate()
  const release = await gate.acquire('fg')
  try {
    await runCliCodeRoutine(routine, baseDeps({ store, gate }))
  } finally {
    release()
  }
  assert.equal(store.listRoutineRuns(routine.id)[0].status, 'ok')
  assert.deepEqual(gate.stats(), { inFlight: 0, queued: 0, capacity: 1 }, 'nothing may be left queued on the gate')
})

test('a multi-slot engine with a free slot counts as idle and swaps rather than skipping', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const gate = new GenerationGate(() => 2)
  const release = await gate.acquire('fg') // 1 of 2 slots busy → still idle by this rule
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store, gate,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
  }))
  release()
  assert.deepEqual(loadCalls, ['pinned-model', 'some-other-model'])
})

test('a failed pinned-model load records errored, never spawns, and never restores', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { status: 503, message: "No model matching 'pinned-model' found." } },
    runProcess: neverSpawns(),
  }))

  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /Could not load pinned model 'pinned-model'/)
  assert.match(runs[0].error ?? '', /No model matching/)
  assert.deepEqual(loadCalls, ['pinned-model'], 'a swap that never happened must not schedule a restore')
})

// ── Model restore (spec 20 §5 + the documented SPEC-GAP) ──────────────────────────────────────

test('the previously-loaded model is restored after a swap-then-run', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
  }))
  assert.deepEqual(loadCalls, ['pinned-model', 'some-other-model'])
})

test('the model is restored even when the run itself fails', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
    runProcess: async () => ({ exitCode: 1, timedOut: false, stdout: '', stderr: 'boom' }),
  }))
  assert.deepEqual(loadCalls, ['pinned-model', 'some-other-model'])
  assert.equal(store.listRoutineRuns(routine.id)[0].status, 'errored')
})

test('SPEC-GAP: nothing was loaded before the swap, so nothing is restored', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const loadCalls: string[] = []
  await runCliCodeRoutine(routine, baseDeps({
    store,
    getLoadedModelKey: () => null, // cold daemon
    loadExplicit: async (k) => { loadCalls.push(k); return { target: 'http://127.0.0.1:8081' } },
  }))
  assert.deepEqual(loadCalls, ['pinned-model'], 'there is nothing to restore TO — the pinned model stays loaded')
  assert.equal(store.listRoutineRuns(routine.id)[0].status, 'ok')
})

test('a restore that throws is swallowed and never overwrites the run outcome', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  let call = 0
  await runCliCodeRoutine(routine, baseDeps({
    store,
    getLoadedModelKey: () => 'some-other-model',
    loadExplicit: async () => {
      call += 1
      if (call === 2) throw new Error('engine died during restore')
      return { target: 'http://127.0.0.1:8081' }
    },
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'ok', 'the real outcome must survive a failed restore')
  assert.equal(runs[0].result, 'done')
})

// ── Subprocess outcomes ───────────────────────────────────────────────────────────────────────

test('subprocess non-zero exit records status errored with stderr in the error field', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({ exitCode: 1, timedOut: false, stdout: '', stderr: 'Error: not authenticated\n' }),
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /not authenticated/)
})

test('a non-zero exit with no stderr still reports the exit code rather than an empty error', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({ exitCode: 7, timedOut: false, stdout: '', stderr: '   ' }),
  }))
  assert.match(store.listRoutineRuns(routine.id)[0].error ?? '', /exited with code 7/)
})

test('a spawn failure (exitCode null, ENOENT on stderr) is recorded as errored', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({ exitCode: null, timedOut: false, stdout: '', stderr: '\nspawn claude ENOENT' }),
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /ENOENT/)
})

test('subprocess timeout records status errored mentioning the timeout', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: '' }),
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /timed out/i)
})

test('a timeout is reported as a timeout even when the child also produced a clean-looking result', async () => {
  // timedOut is checked BEFORE exitCode/stdout: a killed child that already emitted a `result`
  // event did not finish its work, and recording it as 'ok' would hide the runaway.
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({ exitCode: 0, timedOut: true, stdout: OK_STDOUT, stderr: '' }),
  }))
  assert.match(store.listRoutineRuns(routine.id)[0].error ?? '', /timed out/i)
})

test('a runProcess that rejects still terminates the run instead of pinning it at running', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => { throw new Error('injected seam blew up') },
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /injected seam blew up/)
  assert.equal(runs[0].endedAt, '2026-08-01T10:00:00.000Z')
})

test('a permissionModeChoices probe that rejects is contained the same way', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    permissionModeChoices: async () => { throw new Error('help probe failed') },
    runProcess: neverSpawns(),
  }))
  assert.equal(store.listRoutineRuns(routine.id)[0].status, 'errored')
})

// ── Output parsing (spec 20 §7: a clean exit is not task success) ─────────────────────────────

test('is_error: true in the CLI result event records errored, despite exit code 0', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({
      exitCode: 0, timedOut: false, stderr: '',
      stdout: '{"type":"result","is_error":true,"result":"I could not reach the repository."}',
    }),
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /could not reach the repository/)
})

test('a clean exit with no parseable result event records errored with the raw tail', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({ exitCode: 0, timedOut: false, stdout: 'total gibberish, not JSON', stderr: '' }),
  }))
  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs[0].status, 'errored')
  assert.match(runs[0].error ?? '', /total gibberish/)
})

test('the LAST result event wins over earlier stream events', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async () => ({
      exitCode: 0, timedOut: false, stderr: '',
      stdout: [
        '{"type":"system","subtype":"init"}',
        '{"type":"assistant","message":{"content":"thinking"}}',
        '{"type":"result","is_error":false,"result":"final answer"}',
      ].join('\n'),
    }),
  }))
  assert.equal(store.listRoutineRuns(routine.id)[0].result, 'final answer')
})

// ── The invocation itself ─────────────────────────────────────────────────────────────────────

test('spawns claude with the exact non-interactive flags, and the prompt on stdin only', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const rec = recordingProcess()
  await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))

  assert.equal(rec.calls.length, 1)
  assert.deepEqual(rec.calls[0].args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'])
  assert.equal(rec.calls[0].opts.stdin, routine.prompt)
})

test('SECURITY: the prompt never appears anywhere in argv, however hostile it is', async () => {
  // The C1 regression guard at the orchestrator level: cli-process.ts can only keep the prompt off
  // a command line if its CALLER never puts it in `args` in the first place.
  const store = freshStore()
  const hostile = 'a" & echo pwned > C:\\INJECTED.txt & rem "; echo pwned; # %USERPROFILE%'
  const routine = codeRoutine(store, { prompt: hostile })
  const rec = recordingProcess()
  await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))

  const args = rec.calls[0].args
  assert.ok(!args.some((a) => a.includes('pwned')), `prompt leaked into argv: ${JSON.stringify(args)}`)
  assert.ok(!args.some((a) => a.includes(hostile)))
  assert.equal(rec.calls[0].opts.stdin, hostile, 'the prompt must still arrive byte-for-byte on stdin')
})

test('`-p` is a bare boolean flag — it is never given the prompt as its value', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const rec = recordingProcess()
  await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))
  assert.equal(rec.calls[0].args[0], '-p')
  assert.equal(rec.calls[0].args[1], '--output-format', '-p takes no value; the next token is the next flag')
})

test('permission mode is resolved against what the installed CLI advertises', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { permissionMode: 'ask' })
  const rec = recordingProcess()
  // An older CLI that knows 'default' but not 'manual' → agent-modes.ts's legacy fallback.
  await runCliCodeRoutine(routine, baseDeps({
    store, runProcess: rec.runProcess,
    permissionModeChoices: async () => ['acceptEdits', 'bypassPermissions', 'default', 'plan'],
  }))
  const args = rec.calls[0].args
  assert.deepEqual(args.slice(-2), ['--permission-mode', 'default'])
})

test('no permissionMode on the routine means no --permission-mode flag at all', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { permissionMode: undefined })
  const rec = recordingProcess()
  await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))
  assert.deepEqual(rec.calls[0].args, ['-p', '--output-format', 'stream-json', '--verbose'])
})

test('an unresolvable permission mode is omitted rather than passed through as a guess', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { permissionMode: 'plan' })
  const rec = recordingProcess()
  // A CLI that advertises choices but not 'plan' → resolveClaudePermissionMode returns null.
  await runCliCodeRoutine(routine, baseDeps({
    store, runProcess: rec.runProcess, permissionModeChoices: async () => ['acceptEdits'],
  }))
  assert.ok(!rec.calls[0].args.includes('--permission-mode'))
})

test('cwd is the routine workspace, and the timeout is the module constant', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { workspacePath: '/some/checkout' })
  const rec = recordingProcess()
  await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))
  assert.equal(rec.calls[0].opts.cwd, '/some/checkout')
  assert.equal(rec.calls[0].opts.timeoutMs, CLI_ROUTINE_TIMEOUT_MS)
})

test('a routine with no workspacePath falls back to the daemon cwd', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { workspacePath: undefined })
  const rec = recordingProcess()
  await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))
  assert.equal(rec.calls[0].opts.cwd, process.cwd())
})

// ── Environment + session-scoped auth ─────────────────────────────────────────────────────────

test('the subprocess env points at the daemon own port with a session-scoped token', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const rec = recordingProcess()
  let tokenDuringRun: string | undefined
  await runCliCodeRoutine(routine, baseDeps({
    store, port: 7777,
    runProcess: async (args, opts) => {
      tokenDuringRun = opts.env.ANTHROPIC_AUTH_TOKEN
      return rec.runProcess(args, opts)
    },
  }))

  const env = rec.calls[0].opts.env
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7777')
  assert.equal(env.ANTHROPIC_MODEL, 'pinned-model')
  assert.equal(env.ANTHROPIC_TIMEOUT, '300000')
  assert.equal(env.ANTHROPIC_MAX_RETRIES, '0')
  assert.ok(tokenDuringRun && tokenDuringRun.startsWith('tllm-cs-'), `unexpected token: ${tokenDuringRun}`)
})

test('the session token resolves to this run while it is live, and is revoked afterwards', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  let seen: { token: string; resolved: string | null } | null = null
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async (_args, opts) => {
      const token = opts.env.ANTHROPIC_AUTH_TOKEN ?? ''
      seen = { token, resolved: sessionAuth.resolve(token) }
      return { exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' }
    },
  }))

  const captured = seen as unknown as { token: string; resolved: string | null }
  assert.ok(captured, 'runProcess should have been called')
  const runId = store.listRoutineRuns(routine.id)[0].id
  assert.equal(captured.resolved, runId, 'the gateway must be able to attribute traffic to this run')
  assert.equal(sessionAuth.resolve(captured.token), null, 'auth must never outlive the one-shot subprocess')
})

test('the session token is revoked even when the run fails', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  let token = ''
  await runCliCodeRoutine(routine, baseDeps({
    store,
    runProcess: async (_args, opts) => {
      token = opts.env.ANTHROPIC_AUTH_TOKEN ?? ''
      throw new Error('kaboom')
    },
  }))
  assert.ok(token.startsWith('tllm-cs-'))
  assert.equal(sessionAuth.resolve(token), null)
})

test('the env inherits the daemon environment minus the parent-agent markers', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const rec = recordingProcess()
  const prevMarker = process.env.ANTHROPIC_API_KEY
  process.env.TURBOLLM_CLI_ROUTINE_TEST = 'inherited'
  process.env.ANTHROPIC_API_KEY = 'a-parent-agent-key-that-must-not-leak'
  try {
    await runCliCodeRoutine(routine, baseDeps({ store, runProcess: rec.runProcess }))
  } finally {
    delete process.env.TURBOLLM_CLI_ROUTINE_TEST
    if (prevMarker === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevMarker
  }
  const env = rec.calls[0].opts.env
  assert.equal(env.TURBOLLM_CLI_ROUTINE_TEST, 'inherited')
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'inheritedEnv() must strip the parent-agent markers')
})

// ── Run-row ownership (the Task 8 wire-in) ────────────────────────────────────────────────────

test('an existingRun is written into rather than duplicated', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  // Exactly what scheduler.ts's tick() does before calling runRoutine(routine, run).
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  await runCliCodeRoutine(routine, baseDeps({ store, existingRun: run }))

  const runs = store.listRoutineRuns(routine.id)
  assert.equal(runs.length, 1, 'a scheduler-created run must not be shadowed by a second row')
  assert.equal(runs[0].id, run.id)
  assert.equal(runs[0].status, 'ok')
})

test('an existingRun is used for the session token identity too', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let resolved: string | null = null
  await runCliCodeRoutine(routine, baseDeps({
    store, existingRun: run,
    runProcess: async (_args, opts) => {
      resolved = sessionAuth.resolve(opts.env.ANTHROPIC_AUTH_TOKEN ?? '')
      return { exitCode: 0, timedOut: false, stdout: OK_STDOUT, stderr: '' }
    },
  }))
  assert.equal(resolved, run.id)
})
