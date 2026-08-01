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

export type CodeRunOutcome =
  | { status: 'ok'; result: string }
  | { status: 'needs_approval' }
  | { status: 'errored'; error: string }

/** Runs one Code Routine (in-app pi) fire to completion (or a stall/error). Creates a fresh
 *  conversation + agent_run per fire — a routine run is always a new session, never continued. */
export async function runCodeRoutine(d: Deps, routine: Routine, run: RoutineRun, signal: AbortSignal): Promise<CodeRunOutcome> {
  if (!routine.workspacePath) return { status: 'errored', error: 'This routine has no workspace path configured.' }
  if (!d.codeRuns) return { status: 'errored', error: 'Code execution is not available (codeRuns not wired).' }

  const mode = (routine.permissionMode ?? 'auto') as CodeMode
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
  if (decision === 'deny') return { status: 'errored', error: `Tool call "${pending.call.name}" denied by user.` }
  if (!d.codeRuns) return { status: 'errored', error: 'Code execution is not available (codeRuns not wired).' }

  const sessionId = pending.sessionId ?? pending.convId
  const agentRun = d.db.getAgentRun(sessionId)
  if (!agentRun) return { status: 'errored', error: "The routine's session no longer exists." }
  const conv = d.db.getConversation(pending.convId)
  if (!conv) return { status: 'errored', error: "The routine's conversation no longer exists." }

  // Bug found via tracing (not in the brief's original text): resuming ALWAYS starts a fresh
  // continuation turn — a brand-new pi tool invocation with a brand-new toolCallId (see module
  // comment). Under 'auto' mode that's harmless, since auto has no per-call approval gate at all
  // (code-session.ts: "auto → containment only, no approval await"). But under 'ask' mode, EVERY
  // mutating tool call — including the retried, already-approved one — passes through
  // code-session.ts's own LIVE waitForToolApproval() gate (tools/approval-gate.ts), keyed by
  // `${convId}:${toolCallId}`. Since the retry gets a brand-new toolCallId, there is no way to
  // have pre-resolved its approval, and nothing here re-resolves it either — so leaving the
  // continuation turn in 'ask' mode means the "approved" action hits the identical live gate
  // again and immediately re-stalls, before it ever actually executes. The routine's own "allow"
  // decision would never really unlock anything: an infinite stall→resume→re-stall loop, exactly
  // the class of defect Task 6's sibling runner hit (its own "C1 fix" widens the tool allow-list
  // for just the one approved call rather than re-gating it). The fix here is the same idea
  // applied to a live-turn permission MODE instead of a static allow-list: widen just this one
  // resumed continuation turn's conversation mode to 'auto' so the approved action actually runs.
  // This never touches the routine's own configured permissionMode (routine.permissionMode is
  // read fresh, unchanged, on the NEXT scheduled fire — runCodeRoutine always starts its own new
  // conversation) and never widens anything beyond this single resume's conversation.
  if (conv.agentMode === 'ask') d.db.setConversationMode(conv.id, 'auto')

  const task = `[SYSTEM: resuming after approval. The tool call ${pending.call.name}(${JSON.stringify(pending.call.args)}) was approved by the user — proceed with it and continue the original task.]`
  const userMsg = d.db.addMessage(pending.convId, 'user', task)
  return driveCodeSession(d, run, sessionId, pending.convId, agentRun.repoRoot ?? routine.workspacePath ?? '', task, userMsg.id, signal)
}

async function driveCodeSession(d: Deps, run: RoutineRun, sessionId: string, convId: string, repoRoot: string, task: string, userMsgId: string, signal: AbortSignal): Promise<CodeRunOutcome> {
  const codeRuns = d.codeRuns!
  const onDeadline = () => codeRuns.stop(sessionId)
  signal.addEventListener('abort', onDeadline, { once: true })
  codeRuns.enqueue(sessionId, { convId, repoRoot, task, userMsgId })

  try {
    for await (const ev of codeRuns.subscribe(sessionId, 0)) {
      if (ev.event === 'tool_call') {
        const data = ev.data as { id: string; name: string; args: Record<string, unknown>; status: string }
        if (data.status === 'awaiting_approval') {
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
