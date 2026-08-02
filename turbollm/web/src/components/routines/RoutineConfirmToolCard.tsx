// Inline chat-transcript confirm gate for the routine tools (spec 20 §3, plan Task 8).
//
// WHY THIS FILE EXISTS IN THIS SHAPE — READ BEFORE CHANGING IT. The plan's Task 8 was written
// before Phase 4 shipped and assumed the backend would attach a structured
// `routineConfirm?: RoutineConfirmPayload` field to a create_routine/update_routine tool result,
// which MessageBubble.tsx would simply read and render. VERIFIED AGAINST THE SHIPPED BACKEND
// (turbollm/src/routines/routine-tools.ts): no such field exists or is ever populated. Every
// executor there returns a PLAIN STRING and nothing else — that module's own header says so
// ("Every executor returns a plain string and never throws"). Building Task 8 as written would
// have produced a card that passes hand-constructed unit tests and NEVER renders in production.
//
// So the payload is derived here, client-side, from the three fields a tool call already carries
// (`name`, `args`, `result`):
//
//   create_routine — `execCreateRoutine` performs the real POST itself and returns
//     `Created routine "<id>" (<scheduleDisplay>) in status "pending_confirmation". …`. The routine
//     therefore already EXISTS as a pending_confirmation row, and its id lives ONLY in that string.
//     Parsed out with {@link CREATED_ROUTINE_RE}, then fetched with `useRoutine` for the full
//     object. A rejected create returns `Error: …` instead (code-flavor gate, validation), which
//     does not match — those fall through to the generic tool-call card.
//
//   update_routine — the id is available synchronously and reliably from `args.routineId` (the
//     tool schema marks it `required`). The PREVIEW result string is DELIBERATELY NOT PARSED: it is
//     JSON-stringified old/new values joined by a ` -> ` separator, so a prompt containing that
//     separator would corrupt the parse, and the values are lossy (a `scheduleRule` comes back as
//     raw JSON). The old→new diff is built instead from the REAL stored routine (`useRoutine`) plus
//     the model's own tool-call arguments, which is exactly the data the update would apply.
//
//   delete_routine — DELIBERATELY LEFT GENERIC. `execDeleteRoutine` has its own two-phase
//     preview/apply, so an inline delete-confirm card would be technically possible, but Task 8's
//     scope names create/update only, and the Routines panel (Tasks 9/10) already owns a dedicated
//     AlertDialog delete confirmation. Building a second, differently-shaped delete gate here would
//     be scope creep AND a second surface to keep in sync. Considered and declined, not overlooked;
//     `delete_routine` renders as the plain generic tool-call card. Revisit only if the panel's
//     dialog stops being the single delete gate.
//
//   list_routines / run_routine_now — nothing to confirm; generic card, no comment needed.
import { type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { RoutineConfirmCard } from './RoutineConfirmCard'
import { useRoutine } from '../../lib/routine-queries'
import { routineToDraft, type RoutineDraft } from '../../lib/routine-form'
import type { ScheduleRule } from '../../lib/routine-types'

/** The slice of `ToolCallRecord`/`LiveToolCall` this card reads. Structural, so both satisfy it
 *  without an adapter — and narrow, so it cannot quietly grow a dependency on a field only one of
 *  them has. */
export interface RoutineToolCall {
  name: string
  args: Record<string, unknown>
  /** The tool's OUTPUT string, present only once the call has actually completed. */
  result?: string
  status: 'pending' | 'done' | 'error' | 'awaiting_approval'
}

/** Exactly `execCreateRoutine`'s success prefix. Anchored at the start so an `Error: …` result (or
 *  any other tool's output) can never match. */
const CREATED_ROUTINE_RE = /^Created routine "([^"]+)"/
/** `execUpdateRoutine`'s two-phase preview prefix — see {@link resolveConfirmTarget}. */
const UPDATE_PREVIEW_PREFIX = 'PREVIEW (not applied)'

/** True for the two tools this card can gate. Used by MessageBubble.tsx as the render-branch
 *  condition; deliberately depends on the NAME ONLY, never on the result, so a call transitioning
 *  from running to done does not swap which component type sits at that position in the tree. */
export function isRoutineConfirmTool(name: string): boolean {
  return name === 'create_routine' || name === 'update_routine'
}

interface ConfirmTarget {
  mode: 'create' | 'update'
  routineId: string
}

/** PURE. What (if anything) this tool call should raise a confirm gate for.
 *
 *  Returns null — meaning "render the generic tool-call card" — for every case that is not a
 *  genuinely completed, genuinely successful create/update:
 *   • the call has not finished (`pending`/`awaiting_approval`) or failed (`error`): there is no
 *     result string yet, so there is nothing to confirm and nothing to fetch;
 *   • a create whose result does not carry a routine id (`Error: …` from the code-flavor gate or
 *     from validateCreate — no row was written, so there is nothing to confirm);
 *   • an update with no usable `args.routineId`;
 *   • an update whose result is NOT a preview. `execUpdateRoutine` writes nothing until it is
 *     called again with `confirm: true`, and only the preview phase has something outstanding for
 *     a human to authorize. Once the model has applied the change (`Updated routine "<id>".`) the
 *     write ALREADY HAPPENED — offering "Confirm this change" then would invite a redundant PUT,
 *     and its "Cancel" would tell the user nothing was persisted when in fact it was. An
 *     `Error: …` result fails this check too, for free. */
function resolveConfirmTarget(call: RoutineToolCall): ConfirmTarget | null {
  if (call.status !== 'done') return null
  const result = call.result
  if (!result) return null
  if (call.name === 'create_routine') {
    const id = CREATED_ROUTINE_RE.exec(result)?.[1]?.trim()
    return id ? { mode: 'create', routineId: id } : null
  }
  if (call.name === 'update_routine') {
    if (!result.startsWith(UPDATE_PREVIEW_PREFIX)) return null
    const id = typeof call.args.routineId === 'string' ? call.args.routineId.trim() : ''
    return id ? { mode: 'update', routineId: id } : null
  }
  return null
}

/** A `scheduleRule` straight off a model's tool call, validated into the real union. Anything
 *  malformed yields null and the stored routine's own rule is kept — a half-parsed rule would put
 *  a schedule on the confirm card that neither side ever agreed to. (Range checking is not
 *  repeated here: `isRoutineDraftComplete` already blocks Confirm on any rule the server would
 *  reject.) */
function parseScheduleRule(v: unknown): ScheduleRule | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.kind === 'interval' && typeof r.everyMs === 'number') return { kind: 'interval', everyMs: r.everyMs }
  if (typeof r.hour !== 'number' || typeof r.minute !== 'number') return null
  if (r.kind === 'daily') return { kind: 'daily', hour: r.hour, minute: r.minute }
  if (r.kind === 'weekly' && Array.isArray(r.daysOfWeek)) {
    return { kind: 'weekly', daysOfWeek: r.daysOfWeek.filter((d): d is number => typeof d === 'number'), hour: r.hour, minute: r.minute }
  }
  return null
}

/** PURE. The proposed draft = the stored routine, with whichever fields the model's `update_routine`
 *  call actually named laid over it. A tool call only carries the fields it is changing, so
 *  anything absent must keep its stored value or the diff would advertise blanking it.
 *
 *  The overlaid set is exactly UPDATE_ROUTINE_TOOL's parameters minus two, on purpose:
 *  `scheduleDisplay` (RoutineDraft has none — it is derived from `scheduleRule` at submit time, so
 *  the two can never drift) and `confirm` (the tool's own apply flag, not a routine field).
 *  `agentId` and `flavor` are not overlaid because the tool schema does not expose them.
 *  Each value is type-checked before use: these come from a model, and a `prompt: 42` would
 *  otherwise reach the card as a non-string. */
export function applyUpdateArgs(base: RoutineDraft, args: Record<string, unknown>): RoutineDraft {
  const next: RoutineDraft = { ...base }
  if (typeof args.prompt === 'string') next.prompt = args.prompt
  if (typeof args.modelKey === 'string') next.modelKey = args.modelKey
  if (typeof args.workspacePath === 'string') next.workspacePath = args.workspacePath
  if (args.codingAgent === 'pi' || args.codingAgent === 'claude_cli') next.codingAgent = args.codingAgent
  if (args.permissionMode === 'auto' || args.permissionMode === 'plan' || args.permissionMode === 'ask') {
    next.permissionMode = args.permissionMode
  }
  const rule = parseScheduleRule(args.scheduleRule)
  if (rule) next.scheduleRule = rule
  return next
}

function LoadingCard() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">
      <Loader2 size={12} className="animate-spin" />
      Loading routine…
    </div>
  )
}

/** Renders the shared {@link RoutineConfirmCard} for a completed create_routine/update_routine tool
 *  call, falling back to `fallback` (the caller's own generic tool-call card) whenever a gate would
 *  be wrong or impossible — see {@link resolveConfirmTarget} for every such case.
 *
 *  HOOKS SAFETY. This is a separate CHILD component precisely so it can own a hook of its own:
 *  `useRoutine` runs UNCONDITIONALLY on every render, before any branch, with an id that may be
 *  undefined (the query self-disables on a falsy id). So the hook count here is constant across
 *  the transition MessageBubble.tsx's note is about — a live tool call flipping from "running, no
 *  result" to "done, result just landed". The callers' own branch is on the tool NAME only
 *  ({@link isRoutineConfirmTool}), which never changes for a given call, so that branch does not
 *  swap component types under React either.
 *
 *  Both callbacks are no-ops by design: RoutineConfirmCard renders its own terminal
 *  confirmed/cancelled state, and a chat transcript is an append-only log — a settled gate stays
 *  visible as the record of what was authorized. */
export function RoutineConfirmToolCard({ call, fallback }: { call: RoutineToolCall; fallback: ReactNode }) {
  const target = resolveConfirmTarget(call)
  const routineQ = useRoutine(target?.routineId)

  if (!target) return <>{fallback}</>
  // `data` is retained by TanStack Query when a LATER refetch fails, so this only falls back when
  // the routine was never loaded at all — e.g. it was deleted between the tool call and this
  // render (a create the user discarded elsewhere), or the fetch 401'd on a code-flavor routine.
  const routine = routineQ.data
  if (!routine) return routineQ.isError ? <>{fallback}</> : <LoadingCard />

  // `key` per RoutineConfirmCard's mounting contract: props drive what it shows and writes, but a
  // half-finished inline edit is user intent and must not survive the card being pointed at a
  // different routine (or mode).
  if (target.mode === 'create') {
    return (
      <RoutineConfirmCard
        key={`create:${routine.id}`}
        mode="create"
        routine={routine}
        onConfirmed={() => {}}
        onCancelled={() => {}}
      />
    )
  }
  return (
    <RoutineConfirmCard
      key={`update:${routine.id}`}
      mode="update"
      original={routine}
      draft={applyUpdateArgs(routineToDraft(routine), call.args)}
      onConfirmed={() => {}}
      onCancelled={() => {}}
    />
  )
}
