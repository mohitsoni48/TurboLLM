import type { CodingAgentChoice, Routine, RoutineFlavor, RoutinePermissionMode, ScheduleRule } from './routine-types'

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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatTime(hour: number, minute: number): string {
  const h = ((hour + 11) % 12) + 1
  const suffix = hour < 12 ? 'AM' : 'PM'
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`
}

/** Only promotes to hours for a WHOLE number of them — the plan's `Math.round(minutes / 60)`
 *  would render a 90-minute interval as "2 hours", i.e. a schedule string that misstates the
 *  rule it was derived from (and which gets persisted verbatim as `scheduleDisplay`). */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
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

/** Confirm stays disabled until every flavor-required field resolves — spec 20 §3's "creation
 *  is never silent" rule, tested at the component level per spec 21 §3. The schedule checks
 *  mirror routine-routes.ts's `validateScheduleRule` so the gate never enables a submit the
 *  server would answer with a 400 (a non-positive `everyMs` is the dangerous one: that route's
 *  own comment notes it yields a routine whose next fire is permanently in the past). */
export function isRoutineDraftComplete(d: RoutineDraft): boolean {
  if (!d.prompt.trim() || !d.modelKey.trim()) return false
  if (d.scheduleRule.kind === 'interval' && !(d.scheduleRule.everyMs > 0)) return false
  if (d.scheduleRule.kind === 'weekly' && d.scheduleRule.daysOfWeek.length === 0) return false
  if (d.flavor === 'chat') return !!d.agentId?.trim()
  return !!d.workspacePath?.trim() && (d.codingAgent === 'pi' || d.codingAgent === 'claude_cli')
}
