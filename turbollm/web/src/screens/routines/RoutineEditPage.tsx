import { useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, PanelLeft, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { InlineError } from '../../components/common'
import { toast } from '../../components/ui/sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { RoutineApprovalCard } from '../../components/routines/RoutineApprovalCard'
import { RoutineConfirmCard } from '../../components/routines/RoutineConfirmCard'
import { RoutineFormFields } from '../../components/routines/RoutineFormFields'
import { RoutineStatusBadge } from '../../components/routines/RoutineStatusBadge'
import { describeRoutineError } from '../../lib/routine-api'
import { describeScheduleRule, emptyRoutineDraft, isRoutineDraftComplete, routineToDraft, type RoutineDraft } from '../../lib/routine-form'
import { useRoutine, useRoutineMutations, useRoutineRuns } from '../../lib/routine-queries'
import { deriveRoutineDisplayStatus } from '../../lib/routine-status'
import type { Routine, RoutineRun, ScheduleRule } from '../../lib/routine-types'
import { cn } from '../../lib/utils'
import { useIsDesktop } from '../../lib/useIsDesktop'
import { ConversationSidebar } from '../chat/ConversationSidebar'
import { readSavedSidebarWidth, SIDEBAR_MIN_W, sidebarMaxW, SidebarResizeHandle } from '../chat/SidebarResizeHandle'

function runSummaryLine(run: RoutineRun): string {
  const when = new Date(run.startedAt).toLocaleString()
  if (run.status === 'ok') return `Ran successfully · ${when}`
  if (run.status === 'running') return `Running · started ${when}`
  if (run.status === 'needs_approval') return `Needs approval · ${when}`
  if (run.status === 'skipped') return `Skipped${run.skipReason ? ` (${run.skipReason})` : ''} · ${when}`
  return `Errored${run.error ? `: ${run.error}` : ''} · ${when}`
}

/** DEVIATION FROM THE PLAN: the plan compared drafts with `JSON.stringify(a) !== JSON.stringify(b)`,
 *  which is key-ORDER sensitive. `routineToDraft` and the form's own `{ ...draft, field }` updates
 *  happen to agree today, but a server payload whose `scheduleRule` serialises its keys in a
 *  different order would make an untouched form read as "changed" and pop a confirm gate listing
 *  nothing. Compared field-by-field instead, which is also what the diff inside the gate does. */
function sameRule(a: ScheduleRule, b: ScheduleRule): boolean {
  if (a.kind === 'interval') return b.kind === 'interval' && a.everyMs === b.everyMs
  if (a.kind === 'daily') return b.kind === 'daily' && a.hour === b.hour && a.minute === b.minute
  if (b.kind !== 'weekly' || a.hour !== b.hour || a.minute !== b.minute) return false
  const x = [...a.daysOfWeek].sort((p, q) => p - q)
  const y = [...b.daysOfWeek].sort((p, q) => p - q)
  return x.length === y.length && x.every((d, i) => d === y[i])
}

function draftsEqual(a: RoutineDraft, b: RoutineDraft): boolean {
  return a.flavor === b.flavor && a.prompt === b.prompt && a.modelKey === b.modelKey
    && a.agentId === b.agentId && a.workspacePath === b.workspacePath
    && a.codingAgent === b.codingAgent && a.permissionMode === b.permissionMode
    && sameRule(a.scheduleRule, b.scheduleRule)
}

/** DEVIATION FROM THE PLAN: the plan rendered this page as a bare `<div className="px-4 py-6">`,
 *  the SkillEditPage/AgentEditPage convention. Those pages live at top-level routes; this one is
 *  a `/workspace/code/*` route, and Shell.tsx owns only the nav rail and `<main>` — every Code-mode
 *  screen renders its own sidebar column. Without it, opening a routine from the list unmounts the
 *  Code sidebar entirely (session list, Chat|Code pill, the Routines link itself), which is the
 *  exact defect the list screen's own review already caught and fixed once. Same structure as
 *  RoutinesPanel.tsx's, which is in turn the same one ChatScreen/CodeHomeScreen/CodeSessionScreen
 *  each carry — per-screen duplication is this codebase's established pattern here, not an
 *  oversight. */
function CodeModeShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(Math.max(readSavedSidebarWidth(), SIDEBAR_MIN_W), sidebarMaxW()))
  const sidebarRef = useRef<HTMLDivElement>(null)

  return (
    <div className="flex h-full overflow-hidden">
      {!isDesktop && mobileSidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileSidebarOpen(false)} aria-hidden />
      )}
      <div
        ref={sidebarRef}
        className={cn(
          'tllm-chat-sidebar',
          isDesktop
            ? sidebarOpen ? 'shrink-0' : 'w-10 shrink-0'
            : cn(
                'fixed inset-y-0 left-0 z-40 w-[84vw] max-w-[300px] shadow-[var(--shadow-2)]',
                mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
              ),
        )}
        style={isDesktop && sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        <ConversationSidebar
          activeId={null}
          onSelect={(id) => { navigate(`/workspace/chat/${id}`); if (!isDesktop) setMobileSidebarOpen(false) }}
          onNew={() => { navigate('/workspace/code'); if (!isDesktop) setMobileSidebarOpen(false) }}
          collapsed={isDesktop ? !sidebarOpen : false}
          onToggle={isDesktop ? () => setSidebarOpen((o) => !o) : () => setMobileSidebarOpen(false)}
        />
      </div>
      {isDesktop && sidebarOpen && <SidebarResizeHandle sidebarRef={sidebarRef} onCommit={setSidebarWidth} />}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 md:gap-3 md:px-8">
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 md:hidden" onClick={() => setMobileSidebarOpen(true)} title="History" aria-label="Open sidebar">
            <PanelLeft size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
      </div>
    </div>
  )
}

/** Create / detail / edit / delete for one routine — one page for all four, mirroring
 *  screens/agents/AgentEditPage.tsx's own `isNew`-branches-everything shape.
 *
 *  NOTHING ABOUT THE ROUTINE IS HELD IN LOCAL STATE. The routine every control here reads,
 *  gates on and mutates is `routineQ.data` — re-read from the live query on every render — and
 *  the run list likewise. That is the whole safety property of this page, and it is the specific
 *  thing two earlier components in this feature each got wrong once: a `useState`-captured copy
 *  makes every button a statement about the past, and the buttons here are pause, resume,
 *  run-now and an unguarded cascading DELETE.
 *
 *  The three pieces of local state that DO exist each record a user ACTION rather than a copy of
 *  server state — `draft` (the new-routine form), `existingDraft` (a proposed edit, deliberately
 *  diffed against the LIVE routine, not against the routine as it was when Edit was clicked) and
 *  `deleteConfirmOpen` (a boolean; the dialog reads the routine itself fresh). `created` is the
 *  one snapshot, and it is superseded by the live query the moment that query resolves — see the
 *  create branch. */
export function RoutineEditPage() {
  const { routineId } = useParams<{ routineId: string }>()
  const navigate = useNavigate()
  const isNew = !routineId || routineId === 'new'
  const goBack = () => navigate('/workspace/code/routines')

  const [draft, setDraft] = useState<RoutineDraft>(emptyRoutineDraft())
  const [created, setCreated] = useState<Routine | null>(null)
  const [existingDraft, setExistingDraft] = useState<RoutineDraft | null>(null)
  const [editingExisting, setEditingExisting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  /** Synchronous re-entry guard for the create POST — `isPending` only flips after a React state
   *  update, so two clicks in one tick would create two `pending_confirmation` rows, one of them
   *  orphaned with no card left pointing at it. */
  const createInFlight = useRef(false)

  // In create mode the detail query is off until the POST returns, then it points at the row we
  // just made — so the confirm gate below can check that row's CURRENT status instead of trusting
  // the POST's reply forever.
  const routineQ = useRoutine(isNew ? created?.id : routineId)
  const runsQ = useRoutineRuns(isNew ? undefined : routineId)
  const mut = useRoutineMutations()

  /** Every mutating call on this page can answer 401 for a code-flavor routine from an
   *  unauthorized caller, and routine-api.ts's header comment makes toasting it this surface's
   *  obligation — no AuthGate is ever raised for it, so this toast is the only auth feedback that
   *  exists. `describeRoutineError` is the shared helper that labels it as an authorization
   *  problem rather than a retryable blip.
   *
   *  The refetch is the second half: pause/resume/run-now all answer 409 when the routine is not
   *  in the state this page believed it was (routine-routes.ts guards each one), which is exactly
   *  the symptom of a view that has fallen behind another tab or device. Re-reading the routine
   *  on failure makes the buttons correct themselves instead of staying wrong. */
  const failed = (fallback: string) => (e: unknown) => {
    toast.error(describeRoutineError(e, fallback))
    void routineQ.refetch()
  }

  if (isNew) {
    if (created) {
      // The POST's reply is a snapshot; the live query supersedes it as soon as it resolves.
      const live = routineQ.data?.id === created.id ? routineQ.data : null
      const current = live ?? created
      // FAIL-CLOSED on the row's ACTUAL status. The create-mode card's Cancel is a hard DELETE
      // with cascade to the run history, and DELETE has no status guard of any kind — so if the
      // routine stopped being `pending_confirmation` while this page sat open (confirmed from
      // another tab, from the chat transcript's own confirm card, or from the panel), a
      // still-rendered "Confirm this new routine" card would offer "Cancel" as a way to silently
      // destroy a live, scheduled job. Same fix, same reasoning, as the chat transcript gate.
      if (current.status !== 'pending_confirmation') {
        return (
          <CodeModeShell>
            <div className="flex w-full max-w-2xl flex-col items-start gap-3 px-4 py-6 md:px-8">
              <p className="text-[13px] text-muted">This routine is no longer awaiting confirmation.</p>
              <Button size="sm" onClick={() => navigate(`/workspace/code/routines/${current.id}`)}>Open routine</Button>
            </div>
          </CodeModeShell>
        )
      }
      return (
        <CodeModeShell>
          <div className="flex w-full max-w-2xl flex-col gap-4 px-4 py-6 md:px-8">
            <RoutineConfirmCard
              key={current.id}
              mode="create"
              routine={current}
              onConfirmed={(r) => navigate(`/workspace/code/routines/${r.id}`)}
              onCancelled={goBack}
            />
          </div>
        </CodeModeShell>
      )
    }

    const complete = isRoutineDraftComplete(draft)
    return (
      <CodeModeShell>
        <div className="flex w-full max-w-2xl flex-col gap-5 px-4 py-6 md:px-8">
          <div className="flex items-center gap-2">
            <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to routines" aria-label="Back to routines"><ChevronLeft size={18} /></button>
            <span className="text-[15px] font-medium text-ink">New routine</span>
          </div>
          <RoutineFormFields draft={draft} onChange={setDraft} disabled={mut.create.isPending} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={goBack}>Cancel</Button>
            <Button
              size="sm"
              disabled={!complete || mut.create.isPending}
              onClick={() => {
                // `disabled` is the second line of defence, not the first — same shape as the
                // confirm card's own gate.
                if (!complete || createInFlight.current) return
                createInFlight.current = true
                mut.create.mutate(
                  { ...draft, scheduleDisplay: describeScheduleRule(draft.scheduleRule) },
                  {
                    onSuccess: (r) => setCreated(r),
                    onError: (e) => toast.error(describeRoutineError(e, 'Could not create this routine.')),
                    onSettled: () => { createInFlight.current = false },
                  },
                )
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      </CodeModeShell>
    )
  }

  if (routineQ.isLoading || runsQ.isLoading) {
    return <CodeModeShell><div className="px-4 py-6 md:px-8"><Skeleton className="h-64 w-full max-w-2xl rounded-lg" /></div></CodeModeShell>
  }
  if (routineQ.isError || !routineQ.data) {
    return (
      <CodeModeShell>
        <div className="flex flex-col gap-3 px-4 py-6 md:px-8">
          <InlineError message="Could not load this routine." onRetry={() => void routineQ.refetch()} />
          <Button size="sm" variant="outline" onClick={goBack} className="self-start">Back to routines</Button>
        </div>
      </CodeModeShell>
    )
  }

  const routine = routineQ.data
  const runs = runsQ.data ?? []
  const status = deriveRoutineDisplayStatus(routine, runs[0] ?? null)
  const persistedDraft = routineToDraft(routine)

  if (editingExisting && existingDraft) {
    return (
      <CodeModeShell>
        <div className="flex w-full max-w-2xl flex-col gap-4 px-4 py-6 md:px-8">
          {/* `lockFlavor`, for the same reason the confirm card sets it: `PUT /:id` cannot change
              flavor (routine-routes.ts's validateUpdate re-checks flavor invariants against the
              routine's CURRENT flavor, and the confirm card's patch omits the field entirely), so
              a live toggle here would swap which fields the form collects, feed those fields into
              a diff the user authorizes, and have the server keep the original flavor anyway. */}
          <RoutineFormFields draft={existingDraft} onChange={setExistingDraft} lockFlavor />
          <div className="flex gap-1.5">
            {/* DEVIATION: the plan's "Back" only closed the editor, leaving the proposed edit
                behind — so the confirm gate popped up anyway on a screen the user had just backed
                out of. Discarding is what backing out of an edit means. */}
            <Button size="sm" variant="outline" onClick={() => { setExistingDraft(null); setEditingExisting(false) }}>Discard</Button>
            <Button size="sm" onClick={() => setEditingExisting(false)}>Review change</Button>
          </div>
        </div>
      </CodeModeShell>
    )
  }

  const runningNow = runs.some((r) => r.status === 'running')
  const awaitingApproval = runs.some((r) => r.status === 'needs_approval')

  return (
    <CodeModeShell>
      <div className="flex w-full max-w-2xl flex-col gap-5 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to routines" aria-label="Back to routines"><ChevronLeft size={18} /></button>
          <span className="min-w-0 max-w-full truncate text-[15px] font-medium text-ink">{routine.prompt}</span>
          <RoutineStatusBadge status={status} />
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => { setExistingDraft(persistedDraft); setEditingExisting(true) }}>Edit</Button>
            {/* Gated on the LIVE routine's status, re-read every render — never on a captured
                copy. A view that has fallen behind can still show the wrong button for a moment
                (the detail query polls rather than streaming), but the server is the real gate:
                /pause 409s unless the routine is active and /resume 409s unless it is paused, and
                `failed()` refetches so the row corrects itself instead of staying wrong. */}
            {routine.status === 'active' ? (
              <Button size="sm" variant="outline" disabled={mut.pause.isPending} onClick={() => mut.pause.mutate(routine.id, { onError: failed('Could not pause this routine.') })}>
                <Pause size={13} /> Pause
              </Button>
            ) : routine.status === 'paused' ? (
              <Button size="sm" variant="outline" disabled={mut.resume.isPending} onClick={() => mut.resume.mutate(routine.id, { onError: failed('Could not resume this routine.') })}>
                <Play size={13} /> Resume
              </Button>
            ) : null}
            {routine.status !== 'pending_confirmation' && (
              // /run-now accepts active AND paused routines (routine-routes.ts only refuses
              // 'not_confirmed'), so the plan's `status === 'active'` condition would have hidden
              // a manual trigger the backend genuinely supports on a paused routine.
              <Button size="sm" variant="outline" disabled={mut.runNow.isPending || runningNow} onClick={() => mut.runNow.mutate(routine.id, { onError: failed('Could not start a run.') })}>
                <RotateCw size={13} /> Run now
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setDeleteConfirmOpen(true)}>
              <Trash2 size={13} /> Delete
            </Button>
          </div>
        </div>

        {/* The confirm gate for an inline edit. `original` is the LIVE routine (not the copy taken
            when Edit was clicked), so the old→new diff the user authorizes describes what this PUT
            will actually change about the routine as it stands right now. */}
        {existingDraft && !draftsEqual(existingDraft, persistedDraft) && (
          <RoutineConfirmCard
            key={routine.id}
            mode="update"
            original={routine}
            draft={existingDraft}
            onConfirmed={() => setExistingDraft(null)}
            onCancelled={() => setExistingDraft(null)}
          />
        )}

        <div className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Run history</h2>
          {runs.length === 0 ? (
            <p className="text-[13px] text-faint">No runs yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {runs.map((run) =>
                run.status === 'needs_approval'
                  ? <RoutineApprovalCard key={run.id} routineId={routine.id} run={run} />
                  : <div key={run.id} className="rounded-md border border-border bg-panel px-3 py-2 text-[13px] break-words text-ink">{runSummaryLine(run)}</div>,
              )}
            </div>
          )}
        </div>

        {/* Delete confirmation — the shadcn AlertDialog 00-conventions.md §4 requires for a
            destructive action, following ConversationSidebar.tsx's delete-conversation usage
            (AgentEditPage's inline two-button row is a known deviation, not the pattern).
            Deliberately NOT driven by a captured `pendingDelete` object the way that file's is:
            there is only one routine on this page, so the dialog reads `routine` — the live query
            — on every render. Its warnings therefore track what is true NOW, including a run that
            starts while the dialog is already open, and the DELETE it fires can only ever target
            the routine currently on screen. */}
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this routine?</AlertDialogTitle>
              <AlertDialogDescription>
                <span className="font-medium text-ink">{routine.prompt}</span> and its full run history will be
                permanently deleted. This can&rsquo;t be undone.
                {runningNow && <> A run is in progress right now — deleting the routine discards it.</>}
                {!runningNow && awaitingApproval && <> A run is waiting on your approval — it will be discarded, not denied.</>}
                {routine.status === 'active' && <> This routine is active and scheduled to run again.</>}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={mut.remove.isPending}
                onClick={() => {
                  // No per-call onError: `remove`'s failure toast lives on the mutation definition
                  // (routine-queries.ts), and TanStack Query runs BOTH levels — adding one here
                  // would double-toast. That placement is also what keeps a failed DELETE audible
                  // after this page navigates away on success.
                  mut.remove.mutate(routine.id, {
                    onSuccess: () => { toast.success('Routine deleted.'); goBack() },
                  })
                }}
              >
                {/* DEVIATION: the plan labelled this "Delete", identical to the button that OPENS
                    the dialog — so the confirming click and the merely-requesting click were
                    indistinguishable by accessible name, both to a screen-reader user re-reading
                    the page and to any test trying to prove the dialog is a real gate. */}
                Delete routine
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </CodeModeShell>
  )
}
