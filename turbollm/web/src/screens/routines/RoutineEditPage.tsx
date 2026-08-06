import { useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, PanelLeft, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { Markdown } from '../chat/MessageBubble'
import { ChatScreen } from '../ChatScreen'
import { CodeSessionScreen } from '../code/CodeSessionScreen'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { InlineError } from '../../components/common'
import { toast } from '../../components/ui/sonner'
import { track } from '../../lib/api'
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
 *  a `/workspace/routines/*` route, and Shell.tsx owns only the nav rail and `<main>` — every
 *  Workspace-mode screen renders its own sidebar column. Without it, opening a routine from the
 *  list unmounts the sidebar entirely (the routines list, the Chat|Code|Routines mode switch),
 *  which is the exact defect the list screen's own review already caught and fixed once for Code
 *  mode. Same structure as RoutinesPanel.tsx's, which is in turn the same one
 *  ChatScreen/CodeHomeScreen/CodeSessionScreen each carry — per-screen duplication is this
 *  codebase's established pattern here, not an oversight. */
function RoutinesModeShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(Math.max(readSavedSidebarWidth(), SIDEBAR_MIN_W), sidebarMaxW()))
  const sidebarRef = useRef<HTMLDivElement>(null)

  return (
    <div className="flex h-full overflow-hidden">
      {!isDesktop && mobileSidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => { track('routines', 'toggle_sidebar_collapsed'); setMobileSidebarOpen(false) }} aria-hidden />
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
          onNew={() => { navigate('/workspace/routines/new'); if (!isDesktop) setMobileSidebarOpen(false) }}
          collapsed={isDesktop ? !sidebarOpen : false}
          onToggle={isDesktop ? () => setSidebarOpen((o) => !o) : () => setMobileSidebarOpen(false)}
        />
      </div>
      {isDesktop && sidebarOpen && <SidebarResizeHandle sidebarRef={sidebarRef} onCommit={setSidebarWidth} />}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 md:gap-3 md:px-8">
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 md:hidden" onClick={() => { track('routines', 'toggle_sidebar_collapsed'); setMobileSidebarOpen(true) }} title="History" aria-label="Open sidebar">
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
 *  create branch.
 *
 *  Mounted by `RoutineEditPage` below under a `key` derived from the routed id — see that
 *  wrapper's comment for why nothing in here may be allowed to outlive a routine. */
function RoutineEditPageInner() {
  const { routineId } = useParams<{ routineId: string }>()
  const navigate = useNavigate()
  const isNew = !routineId || routineId === 'new'
  // Also passed below as RoutineConfirmCard's `onCancelled` prop — when that file gets its own
  // instrumentation batch, its Cancel button must NOT get a second track() call, this one already
  // fires back_to_routines for it.
  const goBack = () => { track('routines', 'back_to_routines'); navigate('/workspace/routines') }

  const [draft, setDraft] = useState<RoutineDraft>(emptyRoutineDraft())
  const [created, setCreated] = useState<Routine | null>(null)
  const [existingDraft, setExistingDraft] = useState<RoutineDraft | null>(null)
  const [editingExisting, setEditingExisting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  // Which run's real conversation/session is embedded in the middle pane. Reset for free on
  // every routine switch — RoutineEditPage below remounts this whole component via `key`.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
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
          <RoutinesModeShell>
            <div className="flex w-full max-w-2xl flex-col items-start gap-3 px-4 py-6 md:px-8">
              <p className="text-[13px] text-muted">This routine is no longer awaiting confirmation.</p>
              <Button size="sm" onClick={() => { track('routines', 'open_routine'); navigate(`/workspace/routines/${current.id}`) }}>Open routine</Button>
            </div>
          </RoutinesModeShell>
        )
      }
      return (
        <RoutinesModeShell>
          <div className="flex w-full max-w-2xl flex-col gap-4 px-4 py-6 md:px-8">
            <RoutineConfirmCard
              key={current.id}
              mode="create"
              routine={current}
              onConfirmed={(r) => navigate(`/workspace/routines/${r.id}`)}
              onCancelled={goBack}
            />
          </div>
        </RoutinesModeShell>
      )
    }

    const complete = isRoutineDraftComplete(draft)
    return (
      <RoutinesModeShell>
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
                track('routines', 'create_routine')
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
      </RoutinesModeShell>
    )
  }

  if (routineQ.isLoading || runsQ.isLoading) {
    return <RoutinesModeShell><div className="px-4 py-6 md:px-8"><Skeleton className="h-64 w-full max-w-2xl rounded-lg" /></div></RoutinesModeShell>
  }
  if (routineQ.isError || !routineQ.data) {
    return (
      <RoutinesModeShell>
        <div className="flex flex-col gap-3 px-4 py-6 md:px-8">
          <InlineError message="Could not load this routine." onRetry={() => void routineQ.refetch()} screen="routines" />
          <Button size="sm" variant="outline" onClick={goBack} className="self-start">Back to routines</Button>
        </div>
      </RoutinesModeShell>
    )
  }

  const routine = routineQ.data
  const runs = runsQ.data ?? []
  const status = deriveRoutineDisplayStatus(routine, runs[0] ?? null)
  const persistedDraft = routineToDraft(routine)

  // A routine reached via ITS OWN url (the sidebar list, a bookmark, a direct link) rather than
  // the ephemeral /new form or the original chat message that created it — those are the only two
  // places that otherwise ever show this gate. Without this, a routine created by an agent (chat's
  // create_routine tool) had no way to be confirmed at all from here: this branch fell straight
  // through to the generic view below, which shows an "Awaiting confirmation" badge and only an
  // "Edit" button — and Edit opens the UPDATE-diff flow (Discard/Review change), which calls
  // PUT /:id, not PUT /:id/confirm, so it can never actually arm a still-pending routine. Same
  // card, same three actions (Confirm/Cancel/Edit inline) the other two entry points already show.
  if (routine.status === 'pending_confirmation') {
    return (
      <RoutinesModeShell>
        <div className="flex w-full max-w-2xl flex-col gap-4 px-4 py-6 md:px-8">
          <RoutineConfirmCard
            key={routine.id}
            mode="create"
            routine={routine}
            onConfirmed={() => void routineQ.refetch()}
            onCancelled={goBack}
          />
        </div>
      </RoutinesModeShell>
    )
  }

  if (editingExisting && existingDraft) {
    return (
      <RoutinesModeShell>
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
            <Button size="sm" variant="outline" onClick={() => { track('routines', 'discard_routine_edit'); setExistingDraft(null); setEditingExisting(false) }}>Discard</Button>
            <Button size="sm" onClick={() => { track('routines', 'review_routine_edit'); setEditingExisting(false) }}>Review change</Button>
          </div>
        </div>
      </RoutinesModeShell>
    )
  }

  const runningNow = runs.some((r) => r.status === 'running')
  const awaitingApproval = runs.some((r) => r.status === 'needs_approval')
  // Most recent run wins by default (runs is already DESC by started_at) — mirrors any other
  // "list | detail" surface in the app, where the newest item is what you land on.
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null

  return (
    <RoutinesModeShell>
      <div className="flex h-full min-h-0">
        {/* Middle: the selected run's REAL conversation or Code session, embedded — the same
            screen you'd land on opening it from Chat/Code's own sidebar, not a read-only summary
            of it. `key`ed on the id so switching runs (or flavor) remounts cleanly instead of an
            embedded ChatScreen/CodeSessionScreen instance trying to reuse state across two
            completely different underlying sessions. */}
        <div className="min-w-0 flex-1 overflow-hidden border-r border-border">
          {selectedRun?.conversationId ? (
            <ChatScreen key={selectedRun.conversationId} embedded convIdOverride={selectedRun.conversationId} />
          ) : selectedRun?.codeSessionId ? (
            <CodeSessionScreen key={selectedRun.codeSessionId} embedded sessionIdOverride={selectedRun.codeSessionId} />
          ) : selectedRun && (selectedRun.result || selectedRun.error) ? (
            // A run from before conversationId/codeSessionId existed — nothing real to open,
            // fall back to whatever text got flattened into the row at the time.
            <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
              <div className="prose-tllm mx-auto max-w-2xl">
                {selectedRun.result ? <Markdown>{selectedRun.result}</Markdown> : <p className="text-[13px] text-error">{selectedRun.error}</p>}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-faint">
              {runs.length === 0 ? 'No runs yet — Run now fires this routine once immediately.' : 'Select a run to view it.'}
            </div>
          )}
        </div>

        {/* Right: routine status/actions + the Runs list. Selecting a run updates the middle
            pane in place — no navigation, no losing your place in the routine. */}
        <div className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto px-4 py-4">
          <div className="flex items-center gap-2">
            <button type="button" onClick={goBack} className="text-faint hover:text-ink" title="Back to routines" aria-label="Back to routines"><ChevronLeft size={18} /></button>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink" title={routine.prompt}>{routine.prompt}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RoutineStatusBadge status={status} />
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => { track('routines', 'edit_routine'); setExistingDraft(persistedDraft); setEditingExisting(true) }}>Edit</Button>
              {/* Gated on the LIVE routine's status, re-read every render — never on a captured
                  copy. A view that has fallen behind can still show the wrong button for a moment
                  (the detail query polls rather than streaming), but the server is the real gate:
                  /pause 409s unless the routine is active and /resume 409s unless it is paused,
                  and `failed()` refetches so the row corrects itself instead of staying wrong. */}
              {routine.status === 'active' ? (
                <Button size="sm" variant="outline" disabled={mut.pause.isPending} onClick={() => { track('routines', 'pause_routine'); mut.pause.mutate(routine.id, { onError: failed('Could not pause this routine.') }) }} title="Pause" aria-label="Pause">
                  <Pause size={13} />
                </Button>
              ) : routine.status === 'paused' ? (
                <Button size="sm" variant="outline" disabled={mut.resume.isPending} onClick={() => { track('routines', 'resume_routine'); mut.resume.mutate(routine.id, { onError: failed('Could not resume this routine.') }) }} title="Resume" aria-label="Resume">
                  <Play size={13} />
                </Button>
              ) : null}
              {/* /run-now accepts active AND paused routines (routine-routes.ts only refuses
                  'not_confirmed') — 'pending_confirmation' can't reach here at all any more, the
                  branch above returns its own confirm gate before this point.

                  `awaitingApproval` is part of the disabled condition because /run-now's 409
                  `already_running` is driven by RoutineScheduler.inFlight, and a run parked at
                  `needs_approval` STAYS in inFlight: tick() and runNow() both early-return out
                  of the `.finally` that would delete it, and reconcileParkedRuns() re-adds
                  parked routines at daemon start. Only approve/deny (via releaseParked) clears
                  it. So a parked run is NOT `running` in the run list but /run-now still
                  refuses it, and an enabled button here could only ever produce a failure toast. */}
              <Button size="sm" variant="outline" disabled={mut.runNow.isPending || runningNow || awaitingApproval} onClick={() => { track('routines', 'run_routine_now'); mut.runNow.mutate(routine.id, { onError: failed('Could not start a run.') }) }} title="Run now" aria-label="Run now">
                <RotateCw size={13} />
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteConfirmOpen(true)} title="Delete" aria-label="Delete">
                <Trash2 size={13} />
              </Button>
            </div>
          </div>

          {/* The confirm gate for an inline edit. `original` is the LIVE routine (not the copy
              taken when Edit was clicked), so the old→new diff the user authorizes describes what
              this PUT will actually change about the routine as it stands right now. */}
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
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Runs</h2>
            {runs.length === 0 ? (
              <p className="text-[13px] text-faint">No runs yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {runs.map((run) => {
                  // Its own approve/deny UI, never a plain selectable row — approving/denying IS
                  // the interaction this run offers, on top of (not instead of) being selectable.
                  //
                  // Gated on `pendingToolCall`, not just the status: 'needs_approval' has TWO
                  // shapes (cli-interactive-runner.ts's header comment). A pi tool-approval stall
                  // (chat-runner.ts/code-runner.ts's stallRoutineRun) always sets pendingToolCall
                  // and has a real allow/deny decision this card can apply via the REST API. An
                  // interactive claude_cli run (`ask`/`plan`) never sets it — there is nothing
                  // structured to approve via a button, since the human answers the CLI's own
                  // prompt directly in the embedded terminal below. Showing this card for that
                  // case would offer Approve/Deny buttons that call resumeRoutineRun with no
                  // pending tool call to resume, which fails with "could not be read" and
                  // wrongly errors out a run that is actually still fine.
                  if (run.status === 'needs_approval' && run.pendingToolCall) {
                    return (
                      <div key={run.id} className="flex flex-col gap-1">
                        <RoutineApprovalCard routineId={routine.id} run={run} />
                        {(run.conversationId || run.codeSessionId) && (
                          <button
                            type="button"
                            className={cn(
                              'rounded-md border px-3 py-1.5 text-left text-[12px]',
                              selectedRun?.id === run.id ? 'border-accent bg-accent/12 text-accent' : 'border-border bg-panel text-muted hover:bg-panel-2',
                            )}
                            onClick={() => { track('routines', 'select_routine_run'); setSelectedRunId(run.id) }}
                          >
                            View the stalled conversation →
                          </button>
                        )}
                      </div>
                    )
                  }
                  const isSelected = selectedRun?.id === run.id
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className={cn(
                        'rounded-md border px-3 py-2 text-left text-[13px] break-words',
                        isSelected ? 'border-accent bg-accent/12 text-accent' : 'border-border bg-panel text-ink hover:bg-panel-2',
                      )}
                      onClick={() => { track('routines', 'select_routine_run'); setSelectedRunId(run.id) }}
                      aria-current={isSelected ? 'true' : undefined}
                    >
                      {runSummaryLine(run)}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
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
                track('routines', 'delete_routine')
                mut.remove.mutate(routine.id, {
                  // Not goBack(): that also tracks back_to_routines, which would conflate a
                  // manual "back" click with this redirect-after-delete.
                  onSuccess: () => { toast.success('Routine deleted.'); navigate('/workspace/routines') },
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
    </RoutinesModeShell>
  )
}

/** The page proper is `RoutineEditPageInner`; this wrapper exists only to give it a `key`.
 *
 *  `/workspace/routines/new` and `/workspace/routines/:routineId` are the SAME element
 *  in App.tsx, and the detail route is one pattern for every routine — so React Router reconciles
 *  the SAME component instance when the routed id changes from one routine to another (a browser
 *  Back/Forward between two routine URLs, an edited URL, the create page's own "Open routine"
 *  navigation, any future in-app cross-link). Nothing about that transition unmounts the page, so
 *  without this key every piece of local state survives it — and every piece of local state on
 *  this page encodes USER INTENT BOUND TO ONE ROUTINE: `deleteConfirmOpen` (a delete the user
 *  authorized for routine A, whose confirm button would then fire an unguarded cascading DELETE
 *  against routine B), `existingDraft`/`editingExisting` (A's authored field values, which
 *  `draftToPatch` would PUT wholesale over B's prompt, schedule, model, agent and workspace),
 *  plus `draft` and `created`. Every one of those correctly re-reads the LIVE routine when it
 *  renders, so the retarget is *accurately described* on screen — which is precisely what makes
 *  it dangerous rather than obviously broken: a confirmation is consent for a specific object,
 *  and re-pointing it at a different one inverts what the user agreed to.
 *
 *  Keying on the routed id makes that structurally impossible instead of a rule to remember:
 *  React unmounts and remounts on any identity change (including `new` ↔ a specific id), so state
 *  added to this page later is discarded too, without anyone having to extend a reset effect. */
export function RoutineEditPage() {
  const { routineId } = useParams<{ routineId: string }>()
  return <RoutineEditPageInner key={routineId ?? 'new'} />
}
