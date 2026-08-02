import { useRef, useState } from 'react'
import { CheckCircle2, Pencil, X } from 'lucide-react'
import { Button } from '../ui/button'
import { toast } from '../ui/sonner'
import { ApiError } from '../../lib/api'
import { useRoutineMutations } from '../../lib/routine-queries'
import { RoutineFormFields } from './RoutineFormFields'
import { describeScheduleRule, isRoutineDraftComplete, routineToDraft, type RoutineDraft } from '../../lib/routine-form'
import type { Routine, RoutineInput } from '../../lib/routine-types'

type Props =
  | { mode: 'create'; routine: Routine; onConfirmed: (r: Routine) => void; onCancelled: () => void }
  | { mode: 'update'; original: Routine; draft: RoutineDraft; onConfirmed: (r: Routine) => void; onCancelled: () => void }

/** The fields an update's old→new diff compares. Narrowed to Routine's string-valued keys on
 *  purpose (rather than the plan's `keyof Routine`) so `String(previous[k])` can never silently
 *  render an object as "[object Object]" — `scheduleRule` is represented here by its derived
 *  `scheduleDisplay` string instead.
 *
 *  DEVIATION FROM THE PLAN: `agentId` is added. The plan's list omitted it, so changing which
 *  agent a chat routine runs under produced a confirm card reading "No fields changed." — the
 *  confirm gate would have understated exactly the change the user is being asked to authorize.
 *
 *  `flavor` is deliberately NOT here: routine-routes.ts's PUT cannot change it (see
 *  {@link draftToPatch}), so a flavor row would advertise a change the server will not apply. */
type DiffKey = 'prompt' | 'scheduleDisplay' | 'modelKey' | 'agentId' | 'workspacePath' | 'codingAgent' | 'permissionMode'

const FIELD_LABELS: { key: DiffKey; label: string }[] = [
  { key: 'prompt', label: 'Prompt' },
  { key: 'scheduleDisplay', label: 'Schedule' },
  { key: 'modelKey', label: 'Model' },
  { key: 'agentId', label: 'Agent' },
  { key: 'workspacePath', label: 'Workspace' },
  { key: 'codingAgent', label: 'Coding agent' },
  { key: 'permissionMode', label: 'Permission mode' },
]

/** The body sent to `PUT /api/v1/routines/:id`.
 *
 *  DEVIATION FROM THE PLAN: the plan spread the whole draft (`{ ...draft, scheduleDisplay }`),
 *  which includes `flavor`. Verified against the shipped route: PUT cannot change `flavor`
 *  (routine-routes.ts's `validateUpdate` re-checks flavor-dependent invariants against the
 *  routine's CURRENT flavor), and worse, its code gate reads
 *  `(routine.flavor === 'code' || b.flavor === 'code')` — so sending `flavor: 'code'` in the body
 *  can raise a 401 on a routine the caller is otherwise allowed to edit. Omitting it keeps the
 *  patch to fields the server will actually apply. */
function draftToPatch(d: RoutineDraft, scheduleDisplay: string): Partial<RoutineInput> {
  return {
    prompt: d.prompt,
    scheduleDisplay,
    scheduleRule: d.scheduleRule,
    modelKey: d.modelKey,
    agentId: d.agentId,
    workspacePath: d.workspacePath,
    codingAgent: d.codingAgent,
    permissionMode: d.permissionMode,
  }
}

/** Every write this card makes (confirm / update / delete) can answer 401 for a code-flavor
 *  routine from a non-host device — routine-api.ts's header comment names catching that status
 *  and toasting it as this surface's obligation, because a deliberate decision not to wire
 *  auth-signal.ts means no AuthGate ever appears: this toast is the ONLY auth feedback the user
 *  gets. Labelled explicitly rather than folded into the generic message so it reads as an
 *  authorization problem, not a transient failure the user should just retry. */
function describeRoutineError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return `Not authorized: ${e.message}`
    return e.message
  }
  return fallback
}

/** Old→new diff for an update_routine confirm card — spec 20 §3 item 4. Plain field list
 *  (short discrete values), not a text diff. */
function RoutineUpdateDiff({ previous, next }: { previous: Routine; next: Routine }) {
  const changed = FIELD_LABELS.filter((f) => previous[f.key] !== next[f.key])
  if (changed.length === 0) return <p className="text-[12px] text-faint">No fields changed.</p>
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-panel-2 p-2.5 text-[12px]">
      {changed.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5">
          <span className="font-medium text-muted">{f.label}</span>
          <span style={{ color: 'var(--err)' }}>− {previous[f.key] ?? '(none)'}</span>
          <span style={{ color: 'var(--ok)' }}>+ {next[f.key] ?? '(none)'}</span>
        </div>
      ))}
    </div>
  )
}

/** THE confirm gate spec 20 §3 requires for create_routine/update_routine, used both inline in
 *  the chat transcript (MessageBubble.tsx's ToolCallCard/InlineToolStep, Task 8) and the
 *  Routines panel's own creation/edit flow (RoutineEditPage.tsx, Tasks 9–10) — one component,
 *  so neither surface can silently bypass it.
 *
 *  `create` vs `update` differ because the backend does: for `create` the routine passed in
 *  ALREADY EXISTS as a real `pending_confirmation` row (routine-tools.ts's `execCreateRoutine`
 *  performs the POST itself), so Confirm is `PUT /:id/confirm` and Cancel must `DELETE` the row
 *  or it is orphaned in the database forever. For `update` nothing is persisted yet — Confirm is
 *  the `PUT /:id` itself, and Cancel makes NO request at all.
 *
 *  MOUNTING CONTRACT: this card seeds its editable draft from props ONCE (useState initialisers).
 *  A consumer that swaps which routine a mounted card is showing must give it a
 *  `key={routine.id}` so React remounts it; the mutation target is read straight from props on
 *  every call (see `routineId` below) so even a missed remount can never confirm or delete a
 *  different routine than the one on screen. */
export function RoutineConfirmCard(props: Props) {
  const [editing, setEditing] = useState(false)
  const [resolved, setResolved] = useState<'confirmed' | 'cancelled' | null>(null)
  const [draft, setDraft] = useState<RoutineDraft>(props.mode === 'create' ? routineToDraft(props.routine) : props.draft)
  /** Create mode only: the server's copy after an inline edit was saved. Null until then, so the
   *  summary falls back to the routine prop. Deliberately NOT the source of the mutation id. */
  const [saved, setSaved] = useState<Routine | null>(null)
  /** Synchronous re-entry guard. `mut.*.isPending` only flips after a React state update, so two
   *  clicks dispatched inside one tick would both pass an `isPending`-only check and fire two
   *  writes (two DELETEs, or a confirm racing a confirm). A ref changes in the same tick. */
  const inFlight = useRef(false)
  const mut = useRoutineMutations()

  const routineId = props.mode === 'create' ? props.routine.id : props.original.id
  const complete = isRoutineDraftComplete(draft)
  const scheduleDisplay = describeScheduleRule(draft.scheduleRule)
  const base = props.mode === 'create' ? (saved ?? props.routine) : props.original
  const effective: Routine =
    props.mode === 'create'
      ? base
      : // `flavor` pinned to the original: PUT cannot change it, so the summary must show what
        // will actually be true after Confirm, not what the draft asks for.
        { ...props.original, ...draft, flavor: props.original.flavor, scheduleDisplay }

  if (resolved === 'confirmed') {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-ink">
        <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} />
        {props.mode === 'create' ? 'Routine confirmed — active on schedule.' : 'Routine updated.'}
      </div>
    )
  }
  if (resolved === 'cancelled') {
    return <div className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-[13px] text-muted">Routine {props.mode === 'create' ? 'discarded' : 'change cancelled'}.</div>
  }

  const saveEdit = () => {
    if (!complete || inFlight.current) return
    if (props.mode === 'create') {
      // The row is still `pending_confirmation`; this PUT edits the draft row, it does NOT
      // confirm it. Confirm remains a separate, explicit user action.
      inFlight.current = true
      mut.update.mutate(
        { id: routineId, patch: draftToPatch(draft, scheduleDisplay) },
        {
          onSuccess: (updated) => { setSaved(updated); setDraft(routineToDraft(updated)); setEditing(false) },
          onError: (e) => toast.error(describeRoutineError(e, 'Could not save your edit.')),
          onSettled: () => { inFlight.current = false },
        },
      )
    } else {
      setEditing(false) // update-mode: draft already IS the pending change; nothing persists until Confirm
    }
  }

  /** Guards, in order: already settled; mid-edit (the action row is unmounted while `editing`,
   *  this makes that structural rather than merely visual); an incomplete draft (the actual
   *  permission-bypass gate — the `disabled` prop is the second line of defence, not the first);
   *  a write already in flight. */
  const confirm = () => {
    if (resolved || editing || !complete || inFlight.current) return
    inFlight.current = true
    if (props.mode === 'create') {
      mut.confirm.mutate(routineId, {
        onSuccess: (confirmed) => { setResolved('confirmed'); toast.success('Routine confirmed.'); props.onConfirmed(confirmed) },
        onError: (e) => toast.error(describeRoutineError(e, 'Could not confirm this routine.')),
        onSettled: () => { inFlight.current = false },
      })
    } else {
      mut.update.mutate(
        { id: routineId, patch: draftToPatch(draft, scheduleDisplay) },
        {
          onSuccess: (updated) => { setResolved('confirmed'); toast.success('Routine updated.'); props.onConfirmed(updated) },
          onError: (e) => toast.error(describeRoutineError(e, 'Could not save this change.')),
          onSettled: () => { inFlight.current = false },
        },
      )
    }
  }

  /** Create: the pending row is real, so discarding it means DELETE — hiding the card would leave
   *  an orphaned `pending_confirmation` routine behind. Update: nothing was ever written, so this
   *  makes no request of any kind. Not gated on `complete` — an incomplete draft must still be
   *  discardable. */
  const cancel = () => {
    if (resolved || editing || inFlight.current) return
    if (props.mode === 'create') {
      inFlight.current = true
      mut.remove.mutate(routineId, {
        // Surfaced rather than swallowed: a failed delete (a 401 in particular) means the pending
        // row is still there, and the user is the only one who can act on that.
        onError: (e) => toast.error(describeRoutineError(e, 'Could not discard this routine.')),
        onSettled: () => { inFlight.current = false },
      })
    }
    setResolved('cancelled')
    props.onCancelled()
  }

  return (
    <div className="overflow-hidden rounded-lg border p-3" style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}>
      <p className="mb-2 text-[13px] font-medium text-ink">{props.mode === 'create' ? 'Confirm this new routine' : 'Confirm this change'}</p>

      {editing ? (
        <div className="flex flex-col gap-3">
          <RoutineFormFields draft={draft} onChange={setDraft} disabled={mut.update.isPending} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={mut.update.isPending} onClick={() => { setDraft(props.mode === 'create' ? routineToDraft(saved ?? props.routine) : props.draft); setEditing(false) }}>
              Cancel edit
            </Button>
            <Button size="sm" onClick={saveEdit} disabled={!complete || mut.update.isPending}>Save changes</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-[13px]">
          <p><span className="text-muted">Schedule:</span> {effective.scheduleDisplay}</p>
          <p><span className="text-muted">Prompt:</span> {effective.prompt}</p>
          <p><span className="text-muted">Flavor:</span> {effective.flavor === 'chat' ? 'Chat' : 'Code'}</p>
          <p><span className="text-muted">Model:</span> {effective.modelKey}</p>
          {effective.flavor === 'chat' && <p><span className="text-muted">Agent:</span> {effective.agentId}</p>}
          {effective.flavor === 'code' && (
            <>
              <p><span className="text-muted">Workspace:</span> {effective.workspacePath}</p>
              <p><span className="text-muted">Coding agent:</span> {effective.codingAgent}</p>
              <p><span className="text-muted">Permission mode:</span> {effective.permissionMode}</p>
            </>
          )}
          {props.mode === 'update' && <RoutineUpdateDiff previous={props.original} next={effective} />}
        </div>
      )}

      {/* Unmounted — not merely hidden — while editing: there is no Confirm/Cancel control to
          click, keyboard-activate or dispatch an event at until the edit is closed. */}
      {!editing && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil size={13} /> Edit inline</Button>
          <Button size="sm" variant="outline" onClick={cancel} disabled={mut.remove.isPending}><X size={13} /> Cancel</Button>
          <Button size="sm" onClick={confirm} disabled={!complete || mut.confirm.isPending || mut.update.isPending}>
            <CheckCircle2 size={13} /> Confirm
          </Button>
        </div>
      )}
    </div>
  )
}
