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
}
