import { useNavigate } from 'react-router-dom'
import { AlarmClock, Plus } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState, InlineError, ScreenHeader } from '../../components/common'
import { RoutineStatusBadge } from '../../components/routines/RoutineStatusBadge'
import { deriveRoutineDisplayStatus } from '../../lib/routine-status'
import { useRoutinesWithLatestRun, type RoutineWithLatestRun } from '../../lib/routine-queries'

function lastRunSummary(item: RoutineWithLatestRun): string {
  const run = item.latestRun
  if (!run) return item.routine.status === 'pending_confirmation' ? 'Never run — awaiting confirmation' : 'Never run yet'
  const when = new Date(run.startedAt).toLocaleString()
  if (run.status === 'ok') return `Ran successfully · ${when}`
  if (run.status === 'running') return `Running now · started ${when}`
  if (run.status === 'needs_approval') return `Stalled, needs approval · ${when}`
  if (run.status === 'skipped') return `Skipped${run.skipReason ? ` (${run.skipReason})` : ''} · ${when}`
  return `Errored${run.error ? `: ${run.error}` : ''} · ${when}`
}

function RoutineRow({ item, onOpen }: { item: RoutineWithLatestRun; onOpen: () => void }) {
  const { routine } = item
  const status = deriveRoutineDisplayStatus(routine, item.latestRun)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-panel px-4 py-3 text-left transition-colors hover:border-accent hover:bg-panel-2"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{routine.prompt}</span>
        <RoutineStatusBadge status={status} />
      </div>
      <p className="text-[12px] text-muted">
        {routine.flavor === 'chat' ? 'Chat routine' : 'Code routine'} · {routine.scheduleDisplay}
        {routine.status === 'active' && routine.nextFireAt ? ` · next: ${new Date(routine.nextFireAt).toLocaleString()}` : ''}
      </p>
      <p className="text-[12px] text-faint">{lastRunSummary(item)}</p>
    </button>
  )
}

/** Routines list (spec 20 §2.1) — Workspace → Code's `/workspace/code/routines` tab. Handles all
 *  four screen states (00-conventions.md §4): skeleton while fetching, inline retryable error,
 *  illustrated empty state with a CTA, and the populated list.
 *
 *  Read-only by design: every routine mutation (confirm/pause/resume/run-now/delete) lives on the
 *  detail page, so nothing here can raise routine-api.ts's code-flavor 401 — the row is a plain
 *  navigation target. */
export function RoutinesPanel() {
  const navigate = useNavigate()
  const { items, isLoading, isError, refetch } = useRoutinesWithLatestRun()

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5 px-4 py-6 md:px-8">
      <ScreenHeader
        title="Routines"
        description="Tasks that run automatically on a schedule, with no one driving them."
        actions={<Button size="sm" onClick={() => navigate('/workspace/code/routines/new')}><Plus size={14} /> New routine</Button>}
      />

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : isError ? (
        <InlineError message="Could not load routines." onRetry={refetch} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<AlarmClock size={28} />}
          message="No routines yet. Create one to run a task automatically on a schedule — chat or code, no one needs to be watching."
          action={<Button size="sm" onClick={() => navigate('/workspace/code/routines/new')}><Plus size={14} /> New routine</Button>}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <RoutineRow key={item.routine.id} item={item} onOpen={() => navigate(`/workspace/code/routines/${item.routine.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}
