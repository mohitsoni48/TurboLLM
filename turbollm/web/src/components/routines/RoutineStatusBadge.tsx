import { cn } from '../../lib/utils'
import type { RoutineDisplayStatus } from '../../lib/routine-status'

const LABEL: Record<RoutineDisplayStatus, string> = {
  pending_confirmation: 'Awaiting confirmation',
  active: 'Active',
  paused: 'Paused',
  needs_approval: 'Needs approval',
  error: 'Error',
}

const DOT_COLOR: Record<RoutineDisplayStatus, string> = {
  pending_confirmation: 'var(--muted)',
  active: 'var(--ok)',
  paused: 'var(--muted)',
  needs_approval: 'var(--warn)',
  error: 'var(--err)',
}

/** Pill chip for a routine's derived display status — same dot+label visual language as
 *  StateChip.tsx (engine state), with this feature's own status set. */
export function RoutineStatusBadge({ status, className }: { status: RoutineDisplayStatus; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2 py-0.5 text-[12px] leading-none text-muted', className)}>
      <span className={cn('h-2 w-2 rounded-full', status === 'needs_approval' && 'tllm-pulse')} style={{ background: DOT_COLOR[status] }} />
      {LABEL[status]}
    </span>
  )
}
