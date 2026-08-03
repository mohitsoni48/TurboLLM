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

/** The `update_routine` parameters {@link applyUpdateArgs} can actually lay onto a `RoutineDraft`.
 *  Exactly UPDATE_ROUTINE_TOOL's schema minus `routineId` (the target, not a change), `confirm`
 *  (the apply flag) and `scheduleDisplay` — see {@link namesOnlyScheduleDisplay}. */
const DRAFT_CARRIED_UPDATE_FIELDS = [
  'prompt', 'scheduleRule', 'modelKey', 'workspacePath', 'codingAgent', 'permissionMode',
] as const

/** PURE. True when the model's update names `scheduleDisplay` and NOTHING ELSE the draft layer can
 *  carry.
 *
 *  `scheduleDisplay` is a real, model-callable field of UPDATE_ROUTINE_TOOL, but `RoutineDraft` has
 *  no slot for it (it is derived from `scheduleRule` by design, so the two can never drift) and
 *  `RoutineConfirmCard` re-derives the display from the rule. So a display-only update would
 *  reconstruct a draft identical to the stored routine and render a confirm gate reading
 *  "No fields changed." while Confirm silently PUT the DERIVED display over the model's proposal —
 *  the exact defect class Task 7 already fixed once for `agentId` ("the confirm gate would have
 *  understated exactly the change the user is being asked to authorize", RoutineConfirmCard.tsx).
 *  Falling back to the generic card instead keeps the raw PREVIEW string — which DOES contain the
 *  real proposed value — readable in its expandable output view. That is strictly more honest than
 *  a gate denying the change exists.
 *
 *  `scheduleDisplay` named ALONGSIDE other real changes still renders the card: the other fields'
 *  diff is genuine, and showing the derived display there matches what the Routines panel does. */
function namesOnlyScheduleDisplay(args: Record<string, unknown>): boolean {
  if (typeof args.scheduleDisplay !== 'string') return false
  return DRAFT_CARRIED_UPDATE_FIELDS.every((f) => args[f] === undefined)
}

/** PURE. True when the tool call at `index` is an `update_routine` PREVIEW whose change a LATER
 *  `update_routine` call IN THE SAME MESSAGE already applied (`confirm: true`, same `routineId`).
 *
 *  The two-phase update protocol means a NORMAL, SUCCESSFUL update leaves TWO records in a
 *  completed transcript: the preview, then the apply. {@link resolveConfirmTarget} correctly
 *  refuses the apply record — but the preview record is still sitting right beside it, still
 *  matches every condition, and would keep rendering an actionable "Confirm this change" whose
 *  Cancel prints "Routine change cancelled." after the write has ALREADY landed. Its Confirm is
 *  worse than useless too: after any later edit elsewhere it would re-apply the old proposal's
 *  fields on top of the newer values.
 *
 *  This needs SIBLING context, which the wrapper (one call, no list) does not have — hence a pure
 *  helper called from MessageBubble.tsx's `completedToolCalls` mapping, where the whole list is in
 *  hand, with the answer threaded down as {@link RoutineConfirmToolCard}'s `superseded` prop.
 *
 *  Args-only, deliberately: a later apply that ERRORED also suppresses the preview. That direction
 *  is the safe one (a stale gate is never rendered), and a model that already tried to apply has
 *  moved past the point where this preview is the outstanding thing to authorize. */
export function isSupersededUpdatePreview(
  calls: readonly { name: string; args?: Record<string, unknown> }[],
  index: number,
): boolean {
  const call = calls[index]
  if (!call || call.name !== 'update_routine') return false
  if (call.args?.confirm === true) return false // this IS an apply record, not a preview
  const id = typeof call.args?.routineId === 'string' ? call.args.routineId.trim() : ''
  if (!id) return false
  return calls.slice(index + 1).some(
    (later) =>
      later.name === 'update_routine' &&
      later.args?.confirm === true &&
      typeof later.args?.routineId === 'string' &&
      later.args.routineId.trim() === id,
  )
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
 *     `Error: …` result fails this check too, for free;
 *   • an update naming ONLY `scheduleDisplay` — see {@link namesOnlyScheduleDisplay}. */
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
    if (namesOnlyScheduleDisplay(call.args)) return null
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
 *  the two can never drift; when it is the ONLY field named, no gate is rendered at all, see
 *  {@link namesOnlyScheduleDisplay}) and `confirm` (the tool's own apply flag, not a routine field).
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
 *  visible as the record of what was authorized.
 *
 *  @param superseded Sibling-context veto from the caller — see {@link isSupersededUpdatePreview}.
 *    Applied before the target is resolved so a suppressed record issues no fetch either. */
export function RoutineConfirmToolCard({ call, fallback, superseded }: { call: RoutineToolCall; fallback: ReactNode; superseded?: boolean }) {
  const target = superseded ? null : resolveConfirmTarget(call)
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
    // THE ROUTINE'S OWN CURRENT STATE, not just the tool call's. RoutineConfirmCard's create mode
    // documents its precondition — "the routine passed in ALREADY EXISTS as a real
    // `pending_confirmation` row" — and its Cancel is a hard DELETE that honours it: the pending
    // row is real and must not be orphaned. But `DELETE /api/v1/routines/:id` has no status guard
    // at all and `routine_runs` cascades, so on an ALREADY-CONFIRMED routine that same button
    // silently destroys a live scheduled job plus its entire run history, with no undo and no
    // AlertDialog on this path. The tool result alone cannot tell us: it is written once and
    // persisted forever, while the routine moves on. Three no-user-error routes reach this —
    // (1) confirming from the still-streaming card, whose local `resolved` state dies when
    // StreamingBubble unmounts at end of turn and MessageBubble re-renders a FRESH card;
    // (2) confirming the same routine from the Routines panel while this card is still mounted,
    // whose mutation invalidation refetches the now-active routine straight into this card;
    // (3) any page reload or conversation revisit, forever after.
    // So gate on the fetched status. Falling back to the generic card is the minimal safe change
    // and stays honest: the raw "Created routine …" string remains readable there, and the
    // routine's real, current state is one click away in the Routines panel.
    if (routine.status !== 'pending_confirmation') return <>{fallback}</>
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
