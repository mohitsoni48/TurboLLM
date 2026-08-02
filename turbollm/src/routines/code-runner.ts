// turbollm/src/routines/code-runner.ts
//
// In-app-pi Code Routine execution (spec 20 §5: "a routine run IS a Code session, just one the
// scheduler starts instead of an HTTP request"). Reuses CodeRunManager/runCodeSession verbatim
// via the shared instance (Deps.codeRuns, Task 5) — no new pi invocation path.
//
// Runaway/loop protection (LOOP_BREAK_AFTER/LOOP_ABORT_AFTER) is already enforced inside
// runCodeSession's own tool_call hook (code-session.ts:1237-1256) — nothing to add here. The
// wall-clock deadline is enforced by aborting the run via CodeRunManager.stop() when the
// deadline fires (enqueue() exposes no signal of its own).
//
// See this task's own design note (in the plan this file was implemented from) for why an
// approval stall here ALWAYS resumes via a fresh continuation turn, never a literal mid-pi-call
// resume — in short: leaving the live pi turn suspended for an unbounded approval wait would
// hold the shared model/GenerationGate hostage, which spec 20 §5/AC13 forbid.
import type { Deps } from '../deps'
import type { Routine, RoutineRun } from './schema'
import type { CodeMode } from '../code/persona'
import { toolsForMode } from '../code/persona'
import { stallRoutineRun, type PendingRoutineToolCall } from './approval'
import { resolveToolApproval } from '../tools/approval-gate'

export type CodeRunOutcome =
  | { status: 'ok'; result: string }
  | { status: 'needs_approval' }
  | { status: 'errored'; error: string }

/** Runs one Code Routine (in-app pi) fire to completion (or a stall/error). Creates a fresh
 *  conversation + agent_run per fire — a routine run is always a new session, never continued. */
export async function runCodeRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal): Promise<CodeRunOutcome> {
  if (!routine.workspacePath) return { status: 'errored', error: 'This routine has no workspace path configured.' }
  if (!d.codeRuns) return { status: 'errored', error: 'Code execution is not available (codeRuns not wired).' }

  // M3: Routine['permissionMode'] and CodeMode are the exact same literal union
  // ('auto'|'plan'|'ask') — an explicit annotation lets the compiler verify that instead of an
  // unchecked `as CodeMode` silently masking a future divergence between the two types.
  const mode: CodeMode = routine.permissionMode ?? 'auto'
  const conv = d.db.createConversation({ kind: 'code', modelKey: routine.modelKey })
  d.db.setConversationMode(conv.id, mode)
  const agentRun = d.db.createAgentRun({ convId: conv.id, title: routine.prompt.slice(0, 60), allowedTools: toolsForMode(mode) ?? [], repoRoot: routine.workspacePath, codeAgent: 'pi' })
  const userMsg = d.db.addMessage(conv.id, 'user', routine.prompt)

  return driveCodeSession(d, run, agentRun.id, conv.id, routine.workspacePath, routine.prompt, userMsg.id, signal)
}

/** Resume a stalled Code Routine — ALWAYS via a fresh continuation turn on the same
 *  conversation, regardless of whether the daemon restarted since the stall (see this file's
 *  module comment for why). pi replays full DB history every turn, so this reconstructs
 *  equivalent context rather than literally resuming the in-flight call. */
export async function resumeCodeRoutine(
  d: Deps, routine: Routine, run: RoutineRun, pending: PendingRoutineToolCall, decision: 'allow' | 'deny', signal: AbortSignal,
): Promise<CodeRunOutcome> {
  if (decision === 'deny') {
    // M2: clear the stall's resume point — leaving a stale pendingToolCall on an otherwise-
    // terminal (denied) run lets a later reader mistake "already denied" for "still awaiting a
    // decision". Status/error/endedAt are left to the caller (routine-routes.ts / the scheduler),
    // matching this file's existing convention of never persisting terminal RoutineRun status
    // itself (the 'ok' path below doesn't either) — this only clears the field this file itself
    // owns writing (stallRoutineRun's own pendingToolCall column).
    d.db.updateRoutineRun(run.id, { pendingToolCall: '' })
    return { status: 'errored', error: `Tool call "${pending.call.name}" denied by user.` }
  }
  if (!d.codeRuns) return { status: 'errored', error: 'Code execution is not available (codeRuns not wired).' }

  const sessionId = pending.sessionId ?? pending.convId
  const agentRun = d.db.getAgentRun(sessionId)
  if (!agentRun) return { status: 'errored', error: "The routine's session no longer exists." }
  const conv = d.db.getConversation(pending.convId)
  if (!conv) return { status: 'errored', error: "The routine's conversation no longer exists." }
  // M1: an empty repoRoot would silently become the containment root (isContainedFromRoot('', ''))
  // rather than failing loudly — error out instead of falling back to ''.
  const repoRoot = agentRun.repoRoot ?? routine.workspacePath
  if (!repoRoot) return { status: 'errored', error: "The routine's session has no workspace path." }

  // C1 fix (superseding an earlier, REJECTED fix that widened conv.agentMode to 'auto' for the
  // whole resumed turn — reviewer found that unsafe: it granted the model unlimited unapproved
  // access for the entire continuation turn, permanently, since nothing ever restored the mode
  // afterward, and the session is visible/reusable via the live Code UI). The correct fix is a
  // ONE-SHOT approval bypass keyed to the SPECIFIC approved call, leaving conv.agentMode
  // untouched: resuming always starts a fresh continuation turn — a brand-new pi tool invocation
  // with a brand-new toolCallId (see module comment) — so under 'ask' mode the retried call would
  // otherwise hit code-session.ts's own live waitForToolApproval() gate (tools/approval-gate.ts)
  // again, with a key nothing has pre-resolved, and re-stall before ever executing. Instead,
  // driveCodeSession below watches for the awaiting_approval event whose name+args match this
  // EXACT approved call and resolves just that one key via resolveToolApproval — once, fail-
  // closed for anything else (a different tool, different args, or a repeat of the same call
  // later in the turn all still take the normal durable-stall path). See this same idea in Task
  // 6's sibling "C1 fix" (chat-runner.ts's resumeChatRoutine widening the allow-list for just the
  // one approved call) — this is that pattern applied to a live per-call gate instead of a static
  // allow-list.
  const approvedCall = { name: pending.call.name, args: pending.call.args }

  const task = `[SYSTEM: resuming after approval. The tool call ${pending.call.name}(${JSON.stringify(pending.call.args)}) was approved by the user — proceed with it and continue the original task.]`
  const userMsg = d.db.addMessage(pending.convId, 'user', task)
  return driveCodeSession(d, run, sessionId, pending.convId, repoRoot, task, userMsg.id, signal, approvedCall)
}

/** Bounded retry for resolveToolApproval: the subscriber can observe the awaiting_approval event
 *  a microtask or two BEFORE code-session.ts's own `await waitForToolApproval(key, signal)` call
 *  has actually registered `key` in the gate's pending map — code-session.ts emits the sink event
 *  FIRST (`await sink(...)`, an extra await/microtask hop even though the sink itself is
 *  synchronous) and only calls waitForToolApproval on the NEXT line, so a live subscriber that
 *  reacts to the sink's emit can genuinely race ahead of the registration. A bare one-shot
 *  `resolveToolApproval` call would then find nothing pending and return false, silently losing
 *  the approval. Retrying across a few real ticks (not just microtasks — the exact number of
 *  microtask hops between the two calls isn't a contract this file should depend on) reliably
 *  wins that race without meaningfully delaying a real routine run. */
async function resolveApprovalWithRetry(convId: string, toolCallId: string, decision: 'allow' | 'deny', attempts = 20): Promise<boolean> {
  const key = `${convId}:${toolCallId}`
  for (let i = 0; i < attempts; i++) {
    if (resolveToolApproval(key, decision)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return false
}

function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function driveCodeSession(
  d: Deps, run: RoutineRun, sessionId: string, convId: string, repoRoot: string, task: string, userMsgId: string, signal: AbortSignal,
  approvedCall?: { name: string; args: Record<string, unknown> },
): Promise<CodeRunOutcome> {
  const codeRuns = d.codeRuns!
  const onDeadline = () => codeRuns.stop(sessionId)
  signal.addEventListener('abort', onDeadline, { once: true })
  codeRuns.enqueue(sessionId, { convId, repoRoot, task, userMsgId })

  // I1 fix: enqueue() may have QUEUED this turn behind a still-unwinding previous one (a stop()
  // aborts pi's AbortController, but the actual pi/provider call can take real time — measured
  // ~1.5s in a realistic scenario — to actually settle; CodeRunManager.pump()'s finally, which
  // clears s.active and starts the next queued turn, only runs once that settles). Blindly
  // reading the first event(s) from subscribe() in that case replays events that still belong to
  // the turn we just stopped (including its own eventual terminal 'done'/aborted frame) — which
  // this function would misread as ITS OWN outcome, discarding the freshly-queued (and not yet
  // even started) approved work. Every event is therefore ignored until this turn's OWN 'meta'
  // start frame is observed (CodeRunManager pushes exactly one, keyed by userMessageId, at the
  // moment a turn actually begins) — true whether enqueue() started immediately or queued.
  let sawOwnStart = false
  let usedApprovalBypass = false

  try {
    for await (const ev of codeRuns.subscribe(sessionId, 0)) {
      if (!sawOwnStart) {
        if (ev.event === 'meta' && (ev.data as { userMessageId?: string }).userMessageId === userMsgId) sawOwnStart = true
        continue
      }
      if (ev.event === 'tool_call') {
        const data = ev.data as { id: string; name: string; args: Record<string, unknown>; status: string }
        if (data.status === 'awaiting_approval') {
          if (approvedCall && !usedApprovalBypass && data.name === approvedCall.name && sameArgs(data.args, approvedCall.args)) {
            usedApprovalBypass = true // one-shot: a later repeat of the same call is NOT auto-approved
            if (await resolveApprovalWithRetry(convId, data.id, 'allow')) continue
            // Lost the race even after retrying — fail closed, same as an unmatched call below.
          }
          stallRoutineRun(d.db, run.id, { convId, sessionId, assistantContent: '', precedingCalls: [], call: { id: data.id, name: data.name, args: data.args } })
          codeRuns.stop(sessionId) // never hold the shared model/gate hostage for an unbounded human wait
          return { status: 'needs_approval' }
        }
      } else if (ev.event === 'done') {
        const data = ev.data as { aborted?: boolean }
        if (data.aborted) return { status: 'errored', error: 'Routine run timed out or was cancelled.' }
        const last = d.db.getConversation(convId, true)?.messages?.at(-1)
        return { status: 'ok', result: last?.content ?? '' }
      } else if (ev.event === 'error') {
        return { status: 'errored', error: (ev.data as { message?: string }).message ?? 'Code run failed.' }
      }
    }
    return { status: 'errored', error: 'Code run ended with no result.' }
  } finally {
    signal.removeEventListener('abort', onDeadline)
  }
}
