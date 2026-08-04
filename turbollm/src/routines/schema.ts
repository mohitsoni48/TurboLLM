export type ScheduleRule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; daysOfWeek: number[]; hour: number; minute: number } // 0=Sunday..6=Saturday

export type RoutineFlavor = 'chat' | 'code'
export type RoutineStatus = 'pending_confirmation' | 'active' | 'paused'
export type CodingAgentChoice = 'pi' | 'claude_cli'

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
  permissionMode?: 'auto' | 'plan' | 'ask'
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
  /** The real conversation a CHAT-flavor fire created (chat-runner.ts's runChatRoutine) —
   *  set once, at creation, never on resume (a stalled run resumes the SAME conversation).
   *  Lets a run be opened and interacted with exactly like any other chat, not just read as a
   *  flattened `result` string. Undefined for code-flavor runs, and for chat-flavor runs that
   *  predate this field. */
  conversationId?: string
  /** The real Code session (agent_runs.id) a CODE-flavor fire created (code-runner.ts's
   *  runCodeRoutine) — same "set once at creation" rule as `conversationId`. A code-flavor
   *  run's session already appears in the normal Code sessions list on its own (both share
   *  conv.kind === 'code'); this is only so the routine's OWN run history can link straight to
   *  it without a lookup. Undefined for chat-flavor runs, and for code-flavor runs that predate
   *  this field. */
  codeSessionId?: string
}
