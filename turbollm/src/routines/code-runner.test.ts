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
import type { CodeMode } from '../code/persona'

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

// ── Regression: 'ask'-mode resume must actually unblock the approved call ─────────────────
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
// executes — the routine's "allow" decision never actually unlocks anything, an infinite
// stall-resume-restall loop. This mirrors Task 6's own "C1 fix" (chat-runner.ts resumeChatRoutine
// widening agentAllowedTools for just the one approved call) for the in-app-pi flavor: the fix
// widens the ONE resumed continuation turn's conversation mode to 'auto' (never touching the
// routine's own configured permissionMode, and never affecting the NEXT scheduled fire, which
// always starts its own fresh conversation via runCodeRoutine and reads routine.permissionMode
// fresh again).
test('resumeCodeRoutine on allow actually unblocks an ask-mode-gated call instead of re-stalling it', async () => {
  const store = freshStore()
  const routine = codeRoutine(store, { permissionMode: 'ask' })
  const run = store.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })

  const capturedModes: CodeMode[] = []
  let call = 0
  const runner: CodeSessionRunner = (async (params) => {
    capturedModes.push(params.mode)
    call++
    if (call === 1) {
      // First turn: the model attempts a mutating call; 'ask' mode gates it (mirrors
      // code-session.ts's real awaiting_approval emission for MUTATING_TOOLS under 'ask').
      await params.sink({ event: 'tool_call', data: { id: 'c1', name: 'bash', args: { command: 'ls' }, status: 'awaiting_approval' } })
      await new Promise<void>((resolve) => params.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { finalText: '', contextUsed: 0, contextMax: 0, aborted: true }
    }
    // Second turn (the resume's fresh continuation turn): if mode were still 'ask' here, a real
    // pi agent retrying the SAME bash call would hit the identical live gate again with a new
    // toolCallId and re-stall — nothing in this test simulates that re-stall explicitly because
    // the point being verified is upstream of it: the continuation turn must not even be started
    // in 'ask' mode in the first place.
    return { finalText: 'done', contextUsed: 0, contextMax: 0, aborted: false }
  }) as CodeSessionRunner

  const d = depsWith(store, runner)
  const outcome1 = await runCodeRoutine(d, routine, run, new AbortController().signal)
  assert.deepEqual(outcome1, { status: 'needs_approval' })
  assert.equal(capturedModes[0], 'ask')

  const reloaded = store.getRoutineRun(run.id)
  const pending = parsePendingToolCall(reloaded?.pendingToolCall)
  assert.ok(pending, 'expected a persisted pending tool call')

  const outcome2 = await resumeCodeRoutine(d, routine, run, pending!, 'allow', new AbortController().signal)
  assert.equal(outcome2.status, 'ok')
  // The bug: without the fix, capturedModes[1] would still read 'ask' (conv.agentMode was never
  // widened), even though nothing re-resolves the live per-call approval gate for the brand-new
  // toolCallId the retried call would get in a real pi run.
  assert.equal(capturedModes[1], 'auto')
})
