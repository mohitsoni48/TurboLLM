import type { CodingAgentChoice, Routine, RoutineFlavor, RoutinePermissionMode, ScheduleRule } from './routine-types'
import { CODING_AGENT_CHOICES } from './routine-types'

/** The panel form's working state. Deliberately has no `scheduleDisplay`: that string is derived
 *  from `scheduleRule` by {@link describeScheduleRule} at submit time, so the two can never drift
 *  apart the way two independently-edited fields could. */
export interface RoutineDraft {
  flavor: RoutineFlavor
  prompt: string
  scheduleRule: ScheduleRule
  modelKey: string
  agentId?: string
  workspacePath?: string
  codingAgent?: CodingAgentChoice
  permissionMode?: RoutinePermissionMode
}

export function emptyRoutineDraft(): RoutineDraft {
  return { flavor: 'chat', prompt: '', scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: '' }
}

/** Full-fidelity draft from a persisted Routine — used to seed the edit form and as the
 *  "next state" half of an update's old→new diff. */
export function routineToDraft(r: Routine): RoutineDraft {
  return {
    flavor: r.flavor, prompt: r.prompt, scheduleRule: r.scheduleRule, modelKey: r.modelKey,
    agentId: r.agentId, workspacePath: r.workspacePath, codingAgent: r.codingAgent, permissionMode: r.permissionMode,
  }
}

/** What a code routine with NO stored `permissionMode` actually runs as. `create_routine` (chat or
 *  Code tool) and REST may store none, and the daemon resolves that per coding agent
 *  (src/routines/execute.ts's dispatch): the in-app pi engine runs it as 'auto' (code-runner.ts);
 *  claude_cli takes the one-shot `claude -p` path with no `--permission-mode` (cli-routine.ts), so
 *  Claude's own defaults apply and anything it would ask about is refused; the other terminal
 *  agents run the live-terminal path's 'ask' (cli-interactive-runner.ts). Every surface that shows
 *  or edits a routine's mode uses this for the unset case, so what is displayed is what runs —
 *  and nothing stores it: an unset mode stays unset until the user actually picks one. */
export function unsetPermissionModeLabel(codingAgent: CodingAgentChoice | undefined): string {
  if (codingAgent === 'pi') return 'Auto — runs tools without asking'
  if (codingAgent === 'claude_cli') return "One-shot claude -p with Claude's default permissions — anything it would ask about is refused"
  if (codingAgent === 'opencode_cli' || codingAgent === 'pi_cli') return 'Ask before each tool call'
  return 'Depends on the coding agent'
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatTime(hour: number, minute: number): string {
  const h = ((hour + 11) % 12) + 1
  const suffix = hour < 12 ? 'AM' : 'PM'
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`
}

/** Each unit only promotes to the next for a WHOLE number of them — the plan's
 *  `Math.round(minutes / 60)` would render a 90-minute interval as "2 hours", i.e. a schedule
 *  string that misstates the rule it was derived from (and which gets persisted verbatim as
 *  `scheduleDisplay`). Starting at seconds closes the same bug from below: the panel's picker
 *  clamps to whole minutes, but `create_routine` lets a model send any `everyMs`, and rounding
 *  30_000 up to "1 minute" (or 20_000 down to "0 minutes") would re-persist that lie on the
 *  next edit. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60 || seconds % 60 !== 0) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = seconds / 60
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = minutes / 60
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/** Human-readable schedule string derived CLIENT-SIDE from the structured rule the panel's own
 *  picker built — see this task's design note in the plan for why no NL parsing happens here. */
export function describeScheduleRule(rule: ScheduleRule): string {
  if (rule.kind === 'interval') return `Runs every ${formatDuration(rule.everyMs)}`
  const time = formatTime(rule.hour, rule.minute)
  if (rule.kind === 'daily') return `Runs daily at ${time}`
  if (rule.daysOfWeek.length === 0) return `Runs weekly at ${time} (pick at least one day)`
  const days = [...rule.daysOfWeek].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(', ')
  return `Runs ${days} at ${time}`
}

/** The daemon's ROUTINE_MAX_INTERVAL_MS (src/routines/schedule.ts), a year: `validateScheduleRule`
 *  refuses a longer `everyMs` with a 400. Past it next_fire_at could not be written, or was
 *  written with a six-digit year that the scheduler read as due on every tick. The panel's
 *  minutes field clamps to it and {@link isRoutineDraftComplete} checks it. */
export const ROUTINE_MAX_INTERVAL_MS = 365 * 24 * 60 * 60_000

/** Confirm stays disabled until every flavor-required field resolves — spec 20 §3's "creation
 *  is never silent" rule, tested at the component level per spec 21 §3. The schedule checks
 *  mirror routine-routes.ts's `validateScheduleRule` check-for-check (finite positive `everyMs`
 *  of at most {@link ROUTINE_MAX_INTERVAL_MS}; integer `hour` 0-23 and `minute` 0-59; a
 *  non-empty `daysOfWeek` of integers 0-6) so the gate never enables a submit the server would
 *  answer with a 400. A non-positive `everyMs` is the dangerous one: that route's own comment
 *  notes it yields a routine whose next fire is permanently in the past. The type signature
 *  alone does not cover these — `routineToDraft` seeds the draft from whatever the server holds,
 *  which includes routines a model authored via `create_routine` with an arbitrary `everyMs`. */
export function isRoutineDraftComplete(d: RoutineDraft): boolean {
  if (!d.prompt.trim() || !d.modelKey.trim()) return false
  const rule = d.scheduleRule
  if (rule.kind === 'interval') {
    if (!Number.isFinite(rule.everyMs) || rule.everyMs <= 0 || rule.everyMs > ROUTINE_MAX_INTERVAL_MS) return false
  } else {
    if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) return false
    if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) return false
    if (rule.kind === 'weekly') {
      if (rule.daysOfWeek.length === 0) return false
      if (!rule.daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return false
    }
  }
  if (d.flavor === 'chat') return !!d.agentId?.trim()
  return !!d.workspacePath?.trim() && !!d.codingAgent && CODING_AGENT_CHOICES.includes(d.codingAgent)
}
