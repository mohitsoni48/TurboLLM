import { useRef, useState } from 'react'
import { CheckCircle2, Pencil, X } from 'lucide-react'
import { Button } from '../ui/button'
import { toast } from '../ui/sonner'
import { describeRoutineError } from '../../lib/routine-api'
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
 *  patch to fields the server will actually apply. Because the field is unpatchable, the inline
 *  editor below also renders with `lockFlavor` — a toggle the server would ignore has no business
 *  on a confirm gate. */
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
 *  MOUNTING CONTRACT — PROPS ARE THE SOURCE OF TRUTH. Nothing this card shows, gates on, or
 *  writes is captured by a `useState` initialiser: the mutation target (`routineId`), the base
 *  draft (`baseDraft`), the completeness gate and the diff are all re-derived from props on
 *  every render. That is deliberate and it is the whole safety property — a `useState`
 *  initialiser runs at mount only, so a re-render with new props would leave the card
 *  displaying, gating and confirming the SUPERSEDED value. The live case is a consumer handing
 *  a still-mounted card a revised proposal for the SAME routine (Task 8's transcript can replace
 *  a tool-call record in place, so a corrected `update_routine` call reuses the routine id and
 *  changes only the draft); that now flows through to the diff, the gate and the PUT body.
 *
 *  Exactly two pieces of local state sit on top, and both record an explicit USER ACTION rather
 *  than a captured prop: `saved` (create mode — the server's reply to an inline-edit PUT) and
 *  `edited` (the inline editor's overlay). Neither is cleared by a prop change, which is the one
 *  thing `key={routine.id}` is still for: a consumer swapping which routine a mounted card shows
 *  should pass it so the previous routine's half-finished inline edit is discarded (same for a
 *  create↔update `mode` swap on one id). What `key` is NOT load-bearing for, and what holds
 *  without it: the routine this card confirms, and the content it confirms, both track props. */
export function RoutineConfirmCard(props: Props) {
  const [editing, setEditing] = useState(false)
  const [resolved, setResolved] = useState<'confirmed' | 'cancelled' | null>(null)
  /** Create mode only: the server's copy after an inline edit was saved. Null until then, so the
   *  summary falls back to the routine prop. Deliberately NOT the source of the mutation id. */
  const [saved, setSaved] = useState<Routine | null>(null)
  /** The inline editor's overlay, and the ONLY local copy of the draft. Null unless the user
   *  opened "Edit inline" and changed something, so the card otherwise re-derives its draft from
   *  props every render. "Cancel edit" clears it; a successful create-mode save clears it too
   *  (the server's reply becomes the new base via `saved`). Mirrors what `saved` already does for
   *  create mode's summary: a user-intent overlay layered on an always-fresh prop, never a
   *  snapshot of that prop. */
  const [edited, setEdited] = useState<RoutineDraft | null>(null)
  /** Synchronous re-entry guard. `mut.*.isPending` only flips after a React state update, so two
   *  clicks dispatched inside one tick would both pass an `isPending`-only check and fire two
   *  writes (two DELETEs, or a confirm racing a confirm). A ref changes in the same tick. */
  const inFlight = useRef(false)
  const mut = useRoutineMutations()

  const routineId = props.mode === 'create' ? props.routine.id : props.original.id
  const base = props.mode === 'create' ? (saved ?? props.routine) : props.original
  /** Recomputed from props on every render — see the MOUNTING CONTRACT above. In update mode the
   *  proposal IS `props.draft`; in create mode the pending row itself is the proposal. */
  const baseDraft: RoutineDraft = props.mode === 'create' ? routineToDraft(base) : props.draft
  const draft = edited ?? baseDraft
  const complete = isRoutineDraftComplete(draft)
  const scheduleDisplay = describeScheduleRule(draft.scheduleRule)
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
          // Drop the overlay rather than reseeding it: `saved` becomes the new base, so the
          // draft is once again derived, not captured.
          onSuccess: (updated) => { setSaved(updated); setEdited(null); setEditing(false) },
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
      // Deliberately NO per-call `onError` here. A failed delete must still be surfaced (the
      // pending row is still in the database, and a 401 is this feature's only auth signal), but
      // `props.onCancelled()` two lines down runs synchronously and a consumer that unmounts this
      // card in response destroys the observer before the DELETE settles — TanStack Query v5 then
      // skips per-`mutate` callbacks entirely. The toast therefore lives on the `remove` mutation
      // definition (routine-queries.ts), which fires regardless of this component's lifetime;
      // adding one back here would double-toast, since Query runs both levels. `onSettled` stays
      // per-call: it only clears this component's own ref, and skipping it on a dead card is
      // exactly right.
      mut.remove.mutate(routineId, { onSettled: () => { inFlight.current = false } })
    }
    setResolved('cancelled')
    props.onCancelled()
  }

  return (
    <div className="overflow-hidden rounded-lg border p-3" style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}>
      <p className="mb-2 text-[13px] font-medium text-ink">{props.mode === 'create' ? 'Confirm this new routine' : 'Confirm this change'}</p>

      {editing ? (
        <div className="flex flex-col gap-3">
          {/* `lockFlavor` in BOTH modes, deliberately. Every write this card makes to an existing
              row is a PUT, and PUT cannot change `flavor` (hence `draftToPatch` omitting it) —
              that is as true of create mode's inline-edit save against the still
              `pending_confirmation` row as it is of update mode's Confirm. Left live, the toggle
              would let the user flip Chat→Code, watch the diff advertise workspace / coding-agent
              / permission-mode changes, and get those fields persisted onto a routine the server
              keeps at its original flavor: a gate describing something other than what happens.
              Changing a routine's flavor means deleting it and creating a new one. */}
          <RoutineFormFields draft={draft} onChange={setEdited} disabled={mut.update.isPending} lockFlavor />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={mut.update.isPending} onClick={() => { setEdited(null); setEditing(false) }}>
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
