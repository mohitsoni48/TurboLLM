// Types for the Routine feature's REST surface (turbollm/src/routines/routine-routes.ts).
// Mirrors turbollm/src/routines/schema.ts field-for-field (Phase 1, already shipped) — this
// is the one place the frontend imports these shapes from, same convention as code-types.ts.

export type ScheduleRule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; daysOfWeek: number[]; hour: number; minute: number } // 0=Sunday..6=Saturday

export type RoutineFlavor = 'chat' | 'code'
export type RoutineStatus = 'pending_confirmation' | 'active' | 'paused'
export type CodingAgentChoice = 'pi' | 'claude_cli'
/** The backend spells this union inline on both `Routine.permissionMode` (schema.ts) and
 *  `RoutineBody.permissionMode` (routine-routes.ts) rather than naming it; named here because
 *  the form/draft layer (routine-form.ts) needs to refer to it. Structurally identical. */
export type RoutinePermissionMode = 'auto' | 'plan' | 'ask'

export interface Routine {
  id: string
  flavor: RoutineFlavor
  status: RoutineStatus
  prompt: string
  scheduleDisplay: string
  scheduleRule: ScheduleRule
  nextFireAt: string | null
  modelKey: string
  agentId?: string
  workspacePath?: string
  codingAgent?: CodingAgentChoice
  permissionMode?: RoutinePermissionMode
  createdAt: string
  updatedAt: string
}

export type RoutineRunStatus = 'running' | 'ok' | 'skipped' | 'errored' | 'needs_approval'

export interface RoutineRun {
  id: string
  routineId: string
  status: RoutineRunStatus
  skipReason?: string
  configSnapshot: string
  pendingToolCall?: string
  result?: string
  error?: string
  startedAt: string
  endedAt?: string
}

/** Body for POST /api/v1/routines and PUT /api/v1/routines/:id — the subset of Routine's
 *  fields the client controls; the server fills id/status/nextFireAt/timestamps. Matches
 *  `RoutineBody` in routine-routes.ts, minus its all-optional-for-validation shape: the
 *  create route's `validateCreate` requires flavor/prompt/scheduleDisplay/scheduleRule/modelKey
 *  unconditionally, so they're required here and PUT takes a `Partial<RoutineInput>`. */
export interface RoutineInput {
  flavor: RoutineFlavor
  prompt: string
  scheduleDisplay: string
  scheduleRule: ScheduleRule
  modelKey: string
  agentId?: string
  workspacePath?: string
  codingAgent?: CodingAgentChoice
  permissionMode?: RoutinePermissionMode
}

/** Frontend-only view model for rendering a `create_routine`/`update_routine` tool call as an
 *  interactive confirm card in the chat transcript.
 *
 *  DRIFT NOTE (verified against the now-shipped Phase 4, `turbollm/src/routines/routine-tools.ts`):
 *  the plan assumed Phase 4 would emit a structured payload alongside the tool result. It does
 *  not — every executor there returns a PLAIN STRING and nothing else:
 *   - `execCreateRoutine` performs the real create and returns
 *     `Created routine "<id>" (<scheduleDisplay>) in status "pending_confirmation". …`, so for
 *     'create' the routine genuinely IS already persisted as pending_confirmation and the card's
 *     job is the PUT /:id/confirm step.
 *   - `execUpdateRoutine` is a two-phase confirm of its own: called without `confirm: true` it
 *     returns a `PREVIEW (not applied) — …` string listing `field: old -> new` lines and writes
 *     nothing; the model must call again with `confirm: true` to apply.
 *  So there is no backend producer of this shape today. It stays the frontend's contract, and
 *  whoever wires MessageBubble.tsx (Task 6/7) must BUILD it client-side — parse the routine id out
 *  of the tool result and fetch the routine — rather than expecting the daemon to send it. */
export interface RoutineConfirmPayload {
  mode: 'create' | 'update'
  routine: Routine
  previous?: Routine
}
