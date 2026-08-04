import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { CodeRunManager } from '../code/code-run-manager'
import { runCodeRoutine, resumeCodeRoutine } from './code-runner'
import type { Routine } from './schema'
import { parsePendingToolCall, type PendingRoutineToolCall } from './approval'
import type { Deps } from '../deps'
import type { CodeSessionRunner } from '../code/code-run-manager'
import { waitForToolApproval } from '../tools/approval-gate'

function freshStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), 'code-runner-test-')))
}

function codeRoutine(store: ConversationStore, overrides: Partial<Parameters<ConversationStore['createRoutine']>[0]> = {}): Routine {
  const r = store.createRoutine({
    flavor: 'code', prompt: 'List TODO comments', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
    modelKey: 'm', workspacePath: '/repo', codingAgent: 'pi', permissionMode: 'auto',
    ...overrides,
  })
  return r
}

/** A fake runCodeSession: emits whatever `events` says (via the sink) then resolves — or, if
 *  `hang` is set, waits for the AbortSignal to fire before resolving (simulating a live turn
 *  stalled on approval or a wall-clock timeout kill). */
function fakeRunner(events: Array<{ event: string; data: unknown }>, opts: { hang?: boolean } = {}): CodeSessionRunner {
  return (async (params) => {
    for (const ev of events) await params.sink(ev)
    if (opts.hang) {
      await new Promise<void>((resolve) => params.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { finalText: '', contextUsed: 0, contextMax: 0, aborted: true }
    }
    return { finalText: 'done', contextUsed: 0, contextMax: 0, aborted: false }
  }) as CodeSessionRunner
}

function depsWith(store: ConversationStore, runner: CodeSessionRunner): Deps {
  // `store` (the config store, unrelated to `db`) is stubbed the same way
  // code-run-manager.reconnect.test.ts's own makeDeps() does — CodeRunManager.pump()'s success
  // path fires a fire-and-forget autoTitleFromConversation() call that reads
  // d.store.snapshot().daemon.autoGenerateTitles; without this stub that call throws
  // asynchronously AFTER the awaited outcome resolves, surfacing as a flaky unhandledRejection
  // attributed to whichever test happens to be running at the time (found while running these
  // tests — not a code-runner.ts defect, a pre-existing CodeRunManager behavior this fixture
  // must account for).
  const d = {
    db: store,
    manager: { status: () => ({ state: 'running', model: { key: 'm' } }) },
    store: { snapshot: () => ({ daemon: { autoGenerateTitles: false } }) },
  } as unknown as Deps
  d.codeRuns = new CodeRunManager(d, { runner })
  return d
}

test('a run that finishes cleanly records status ok with the final assistant text', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const d = depsWith(store, fakeRunner([{ event: 'delta', data: { delta: 'done' } }]))

  const outcome = await runCodeRoutine(d, routine, run, new AbortController().signal)
  assert.equal(outcome.status, 'ok')
})

// Closes the gap where a run's real Code session existed in the DB (visible on its own in the
// normal Code sessions list, since it shares conv.kind === 'code') but the routine's own run
// history had no way to link straight to it.
test('runCodeRoutine persists the run.codeSessionId it created, and it resolves to a real session', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  assert.equal(run.codeSessionId, undefined, 'not set yet at run creation')
  const d = depsWith(store, fakeRunner([{ event: 'delta', data: { delta: 'done' } }]))

  await runCodeRoutine(d, routine, run, new AbortController().signal)
  const reloaded = store.getRoutineRun(run.id)
  assert.ok(reloaded?.codeSessionId, 'expected a codeSessionId to be persisted on the run')
  const agentRun = store.getAgentRun(reloaded!.codeSessionId!)
  assert.ok(agentRun)
  assert.equal(store.getConversation(agentRun!.convId)?.kind, 'code')
})

test('an awaiting_approval tool_call durably stalls the run and aborts the live turn', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const d = depsWith(store, fakeRunner(
    [{ event: 'tool_call', data: { id: 'c1', name: 'bash', args: { command: 'rm -rf /' }, status: 'awaiting_approval' } }],
    { hang: true },
  ))

  const outcome = await runCodeRoutine(d, routine, run, new AbortController().signal)
  assert.deepEqual(outcome, { status: 'needs_approval' })
  const reloaded = store.getRoutineRun(run.id)
  assert.equal(reloaded?.status, 'needs_approval')
  assert.match(reloaded?.pendingToolCall ?? '', /bash/)
})

test('resumeCodeRoutine on deny errors out without starting a fresh turn', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  let enqueued = false
  const d = depsWith(store, fakeRunner([]))
  const original = d.codeRuns!.enqueue.bind(d.codeRuns)
  d.codeRuns!.enqueue = ((...args: Parameters<typeof original>) => { enqueued = true; return original(...args) }) as typeof original
  const pending: PendingRoutineToolCall = { convId: 'x', sessionId: 'y', assistantContent: '', precedingCalls: [], call: { id: 'c1', name: 'bash', args: {} } }

  const outcome = await resumeCodeRoutine(d, routine, run, pending, 'deny', new AbortController().signal)
  assert.equal(outcome.status, 'errored')
  assert.match((outcome as { error: string }).error, /denied/)
  assert.equal(enqueued, false)
})

test('resumeCodeRoutine on allow starts a fresh continuation turn on the same conversation', async () => {
  const store = freshStore()
  const routine = codeRoutine(store)
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const conv = store.createConversation({ kind: 'code' })
  const agentRun = store.createAgentRun({ convId: conv.id, title: 't', allowedTools: [], repoRoot: '/repo', codeAgent: 'pi' })
  const d = depsWith(store, fakeRunner([]))
  const pending: PendingRoutineToolCall = { convId: conv.id, sessionId: agentRun.id, assistantContent: '', precedingCalls: [], call: { id: 'c1', name: 'bash', args: { command: 'ls' } } }

  const outcome = await resumeCodeRoutine(d, routine, run, pending, 'allow', new AbortController().signal)
  assert.equal(outcome.status, 'ok')
  const messages = store.getMessages(conv.id)
  assert.ok(messages.some((m) => m.role === 'user' && m.content.includes('bash')))
})

// ── Regression: 'ask'-mode resume must unblock ONLY the approved call (C1) ────────────────
//
// Found via tracing, NOT in the brief's original spec: the module's own design note says
// resuming ALWAYS starts a fresh continuation turn (a brand-new pi tool-call invocation with a
// brand-new toolCallId), never a literal resume of the blocked call. For a routine running in
// 'auto' mode that's harmless — auto has no per-call approval gate at all (code-session.ts:
// "auto → containment only, no approval await"). But for a routine running in 'ask' mode, EVERY
// mutating tool call — including the retried, already-approved one — passes through
// code-session.ts's own live waitForToolApproval() gate (tools/approval-gate.ts), keyed by
// `${convId}:${toolCallId}`. Since the retried call gets a BRAND NEW toolCallId, there is no way
// to have pre-resolved its approval; leaving the continuation turn in 'ask' mode means the
// "approved" action hits the identical gate again and re-stalls immediately, before it ever
// executes — the routine's "allow" decision never actually unlocks anything.
//
// An EARLIER fix here widened conv.agentMode to 'auto' for the whole resumed turn — code review
// (driving this file live with realistic fake runners) found that unsafe: bash has zero
// containment in ANY mode, so widening the WHOLE turn meant an approved `bash "git status"`
// could be followed, in the SAME ungated turn, by an unapproved `bash "rm -rf /important-dir"` —
// and the mode was never restored afterward (a plain DB write, no finally/revert), so the
// routine's own configured 'ask' policy stayed silently defeated forever, even for a human later
// opening the same session in the live Code UI. The corrected fix (below) is a ONE-SHOT approval
// bypass keyed to the SPECIFIC approved call — conv.agentMode is never touched. This test proves
// the property that actually matters: the approved call executes for real, but a SECOND,
// different mutating call the user was never asked about still durably re-stalls instead of
// running, and the conversation's mode is provably unchanged throughout.
test('resumeCodeRoutine on allow unblocks only the approved call — a different unapproved mutating call still durably stalls (C1)', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { permissionMode: 'ask' })
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const approvedArgs = { command: 'git status' }
  const unapprovedArgs = { command: 'rm -rf /important-dir' }
  const executed: string[] = []

  // A fake runner that behaves like code-session.ts's own real ask-mode gate for a mutating
  // tool: emit awaiting_approval, then actually await the REAL waitForToolApproval() (not a
  // canned/scripted decision) — so this test exercises the real gate + resolveApprovalWithRetry
  // race, not just a hand-picked event sequence.
  let turnIndex = 0
  let callSeq = 0
  const plans: Array<Array<{ name: string; args: Record<string, unknown> }>> = [
    [{ name: 'bash', args: approvedArgs }],                                          // turn 1 (original run): stalls here
    [{ name: 'bash', args: approvedArgs }, { name: 'bash', args: unapprovedArgs }],   // turn 2 (resume): retried+approved, then a NEW unapproved call
  ]
  const runner: CodeSessionRunner = (async (params) => {
    const plan = plans[turnIndex++] ?? []
    for (const step of plan) {
      const id = `c${++callSeq}`
      if (params.mode === 'ask') {
        await params.sink({ event: 'tool_call', data: { id, name: step.name, args: step.args, status: 'awaiting_approval' } })
        const decision = await waitForToolApproval(`${params.convId}:${id}`, params.signal)
        if (decision === 'deny') {
          await params.sink({ event: 'tool_call', data: { id, name: step.name, args: step.args, status: 'error', result: 'denied by user' } })
          return { finalText: '', contextUsed: 0, contextMax: 0, aborted: true }
        }
      }
      executed.push(`${step.name}(${JSON.stringify(step.args)})`)
      await params.sink({ event: 'tool_call', data: { id, name: step.name, args: step.args, status: 'done', result: 'ok' } })
    }
    return { finalText: 'done', contextUsed: 0, contextMax: 0, aborted: false }
  }) as CodeSessionRunner

  const d = depsWith(store, runner)
  const outcome1 = await runCodeRoutine(d, routine, run, new AbortController().signal)
  assert.deepEqual(outcome1, { status: 'needs_approval' })

  const pending = parsePendingToolCall(store.getRoutineRun(run.id)?.pendingToolCall)
  assert.ok(pending, 'expected a persisted pending tool call')
  const modeBeforeResume = store.getConversation(pending!.convId)?.agentMode
  assert.equal(modeBeforeResume, 'ask')

  const outcome2 = await resumeCodeRoutine(d, routine, run, pending!, 'allow', new AbortController().signal)

  // (a) the approved call's result actually reached execution for real.
  assert.ok(executed.includes(`bash(${JSON.stringify(approvedArgs)})`), 'the approved call should have actually executed')
  // (b) the second, unapproved call did NOT execute, and instead caused a fresh durable stall.
  assert.ok(!executed.includes(`bash(${JSON.stringify(unapprovedArgs)})`), 'the unapproved call must never execute')
  assert.equal(outcome2.status, 'needs_approval')
  const reloaded2 = store.getRoutineRun(run.id)
  assert.match(reloaded2?.pendingToolCall ?? '', /rm -rf/)
  // (c) conv.agentMode is unchanged from before the resume — the routine's 'ask' policy still
  // applies to everything else, both for the rest of this run and for a human reopening the
  // session live afterward.
  assert.equal(store.getConversation(pending!.convId)?.agentMode, 'ask')
})

// ── Regression: a resume issued while the stalled turn is still unwinding must not read its
// stale events (I1) ──────────────────────────────────────────────────────────────────────────
//
// Found via tracing: driveCodeSession's stall path calls CodeRunManager.stop(), which only
// ABORTS the live turn's AbortController — the underlying pi/provider call can take real time to
// actually settle (CodeRunManager.pump()'s finally, which clears the session's active turn and
// starts the next QUEUED one, only runs once that settles). A resume issued before that unwind
// finishes has its own turn merely QUEUED by enqueue() (see its {queued} return), and the very
// next subscribe() call replays whatever is still buffered from the turn that was just
// stopped — including that turn's own eventual terminal 'done'/aborted frame — which, before the
// fix, this function would misread as ITS OWN outcome and return prematurely, silently
// discarding the freshly-queued (and not-yet-even-started) approved work.
test('resumeCodeRoutine does not mistake a still-unwinding previous stall for its own outcome (I1)', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { permissionMode: 'ask' })
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const executed: string[] = []
  let turn = 0
  const runner: CodeSessionRunner = (async (params) => {
    turn++
    if (turn === 1) {
      await params.sink({ event: 'tool_call', data: { id: 'c1', name: 'bash', args: { command: 'git status' }, status: 'awaiting_approval' } })
      const decision = await waitForToolApproval(`${params.convId}:c1`, params.signal)
      // Simulate the real, non-trivial time an aborted pi/provider call can take to actually
      // unwind (a realistic scenario measured ~1.5s) — deliberately slower than the synchronous
      // dispatch of resumeCodeRoutine() below, so the resume's enqueue() is GUARANTEED to still
      // observe this turn active (queued: true), forcing the exact race this test targets.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { finalText: '', contextUsed: 0, contextMax: 0, aborted: decision === 'deny' }
    }
    // turn 2: the resumed continuation turn — must actually run and be observed, not discarded.
    executed.push('turn2-ran')
    await params.sink({ event: 'tool_call', data: { id: 'c2', name: 'bash', args: { command: 'git status' }, status: 'done', result: 'ok' } })
    return { finalText: 'done', contextUsed: 0, contextMax: 0, aborted: false }
  }) as CodeSessionRunner

  const d = depsWith(store, runner)
  const outcome1 = await runCodeRoutine(d, routine, run, new AbortController().signal)
  assert.deepEqual(outcome1, { status: 'needs_approval' })

  const pending = parsePendingToolCall(store.getRoutineRun(run.id)?.pendingToolCall)
  assert.ok(pending, 'expected a persisted pending tool call')

  // Issued immediately — turn 1's 50ms unwind delay has NOT elapsed yet.
  const outcome2 = await resumeCodeRoutine(d, routine, run, pending!, 'allow', new AbortController().signal)
  assert.equal(outcome2.status, 'ok')
  assert.ok(executed.includes('turn2-ran'), 'the resumed turn must actually have run, not been discarded')
})
