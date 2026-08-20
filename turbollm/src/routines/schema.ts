export type ScheduleRule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; daysOfWeek: number[]; hour: number; minute: number } // 0=Sunday..6=Saturday

export type RoutineFlavor = 'chat' | 'code'
export type RoutineStatus = 'pending_confirmation' | 'active' | 'paused'
/** Which coding-agent implementation a code-flavor Routine runs on.
 *
 *  ⚠️ `'pi'` is the IN-APP pi-SDK engine that TurboLLM embeds server-side (code/code-session.ts) —
 *  NOT the external `pi` CLI. That predates the `_cli` suffix and cannot be renamed without a
 *  migration, so every TERMINAL harness carries the suffix instead: `claude_cli`, `opencode_cli`,
 *  `pi_cli`. Getting this backwards is a real trap — a routine set to `'pi'` must keep running
 *  in-process, and `'pi_cli'` is a genuinely different thing (a PTY running the `pi` binary against
 *  the gateway). `TERMINAL_CODE_AGENT` below is the only sanctioned way to tell them apart. */
export type CodingAgentChoice = 'pi' | 'claude_cli' | 'opencode_cli' | 'pi_cli'

/** Terminal harnesses → the `AgentRun.codeAgent` value their Code session is created with.
 *
 *  The two vocabularies are deliberately distinct (Routines say `claude_cli`, sessions say
 *  `claude`), so the mapping is stated once here rather than re-derived by string surgery at each
 *  call site. A `CodingAgentChoice` absent from this map is NOT a terminal harness — today only
 *  `'pi'`, the in-app engine, which has no CLI and no PTY. */
export const TERMINAL_CODE_AGENT = {
  claude_cli: 'claude',
  opencode_cli: 'opencode',
  pi_cli: 'pi',
} as const satisfies Partial<Record<CodingAgentChoice, string>>

export type TerminalCodingAgent = keyof typeof TERMINAL_CODE_AGENT

/** Whether this routine's coding agent runs as an external CLI in a PTY (as opposed to the in-app
 *  pi engine). Narrows, so callers get the mapping for free. */
export function isTerminalCodingAgent(a: CodingAgentChoice | undefined): a is TerminalCodingAgent {
  return a !== undefined && a in TERMINAL_CODE_AGENT
}

/** Every value the REST/tool layers accept for `codingAgent` — one list, so a new harness cannot be
 *  added to the type while a validator silently keeps rejecting it. */
export const CODING_AGENT_CHOICES: readonly CodingAgentChoice[] = ['pi', 'claude_cli', 'opencode_cli', 'pi_cli']

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
