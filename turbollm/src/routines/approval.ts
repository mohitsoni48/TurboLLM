// turbollm/src/routines/approval.ts
//
// Durable mid-run tool-approval stall (spec 20 §6, spec 21 §1's "Approval-stall persistence").
// A stalled run's resume point is stored as JSON on the Phase-1 RoutineRun.pendingToolCall
// column (turbollm/src/chat/db.ts's updateRoutineRun) — no new table needed.
import type { ConversationStore } from '../chat/db'
import type { RoutineRun } from './schema'

/** One blocked tool call plus everything needed to resume the round it belongs to.
 *  `precedingCalls` are OTHER calls the model requested in the SAME round that were already
 *  executed (allowed) before this one was found to be outside the routine's tool allow-list —
 *  resuming must replay their results into the wire conversation before continuing the model's
 *  own tool_calls/tool-result pairing. Chat-flavor (chat-runner.ts) populates `precedingCalls`
 *  and `assistantContent` for real; in-app-pi (code-runner.ts) always leaves them empty/'' and
 *  sets `sessionId` instead — see that file's own comment for why the two flavors resume
 *  differently. */
export interface PendingRoutineToolCall {
  /** Which conversation this call belongs to — the resume point, since RoutineRun itself
   *  doesn't carry a live convId field (Phase 1 schema). */
  convId: string
  assistantContent: string
  precedingCalls: { id: string; name: string; args: Record<string, unknown>; result: string }[]
  call: { id: string; name: string; args: Record<string, unknown> }
  /** Code-flavor only: the CodeRunManager session id (== agent_runs.id) the pending pi tool
   *  call belonged to. Absent for chat-flavor runs. */
  sessionId?: string
}

export function serializePendingToolCall(p: PendingRoutineToolCall): string {
  return JSON.stringify(p)
}

export function parsePendingToolCall(raw: string | undefined): PendingRoutineToolCall | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PendingRoutineToolCall>
    if (!v || typeof v.convId !== 'string' || !v.call || typeof v.call.name !== 'string') return null
    return v as PendingRoutineToolCall
  } catch {
    return null
  }
}

/** Stall a run: mark it needs_approval and persist the resume point. Durable the instant this
 *  returns — a daemon restart afterward still shows the run as needs_approval with its
 *  pendingToolCall intact (a plain SQLite UPDATE via Phase 1's updateRoutineRun). */
export function stallRoutineRun(store: ConversationStore, runId: string, pending: PendingRoutineToolCall): RoutineRun | null {
  return store.updateRoutineRun(runId, { status: 'needs_approval', pendingToolCall: serializePendingToolCall(pending) })
}
