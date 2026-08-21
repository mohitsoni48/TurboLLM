// Turbo Link (ADR-376 phase 3, task 6): the small shared pieces every merged fleet list
// renders — the origin badge, the machine filter, the offline-machine notes, and the one
// button that knows how to be disabled for a reason.
//
// These are deliberately DUMB. Every decision they render was already made by a tested pure
// helper: `mergeFleet`/`fleetMachines` (which rows exist, which machines to explain),
// `actionState` (whether a control is live and what the tooltip says), and
// `describeRemoteFailure` (what a refusal means). Nothing in this file re-derives any of
// that — if a rule ends up here instead of in a helper, that is the finding the dispatch
// warned about.
import { AlertTriangle, Cloud, Loader2, Monitor, RotateCw } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { FleetMachine, FleetOrigin } from '../lib/fleet'
import type { MachineOption } from '../lib/fleet-sources'
import type { RemoteFailure } from '../lib/remote-failure'
import type { ActionState } from '../lib/capability-ui'
import { Button } from './ui/button'

/** Which machine a row came from. Reads as a word, not a bare icon: a lone cloud glyph in a
 *  table of models is exactly the kind of thing users learn to ignore, and the machine name
 *  is the entire point of a fleet list. */
export function OriginBadge({ origin }: { origin: FleetOrigin }) {
  const local = origin.kind === 'local'
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-[12px]"
      style={{ color: local ? 'var(--muted)' : 'var(--accent)' }}
      title={local ? 'On this machine' : `On ${origin.machine}, over Turbo Link`}
    >
      {local ? <Monitor size={12} className="shrink-0" /> : <Cloud size={12} className="shrink-0" />}
      <span className="truncate">{local ? 'This machine' : origin.machine}</span>
    </span>
  )
}

/** The machine filter. Every linked machine appears, including offline ones — a machine
 *  that dropped out of its own filter could not even be asked about. */
export function MachineFilter({
  options,
  value,
  onChange,
}: {
  options: MachineOption[]
  value: string
  onChange: (id: string) => void
}) {
  // With no links there is only "All"/"This machine", which is a filter with nothing to
  // filter — every install without Turbo Link sees exactly the screen it saw before.
  if (options.length <= 2) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by machine">
      {options.map((o) => {
        const active = o.id === value
        const offline = o.status !== undefined && o.status !== 'online'
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={active}
            title={offline ? `${o.label} is not reachable right now` : undefined}
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors"
            style={{
              borderColor: active ? 'var(--accent)' : 'var(--border)',
              background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--muted)',
            }}
          >
            {offline && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--warn)' }}
                aria-hidden
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Why a linked machine contributed no rows.
 *
 *  This is the other half of `mergeFleet`'s offline rule and the reason it is safe: the
 *  machine keeps a line on screen with an actionable sentence instead of simply vanishing,
 *  which would be indistinguishable from never having linked it. */
export function MachineNotes({ machines }: { machines: FleetMachine[] }) {
  const quiet = machines.filter((m) => m.note !== null)
  if (quiet.length === 0) return null
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      {quiet.map((m) => (
        <div
          key={m.linkId}
          className="flex items-start gap-2 rounded-[var(--radius)] border border-border bg-panel px-3 py-2 text-[12px]"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
          <span className="text-muted">{m.note}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * A control that is either live, or disabled carrying the reason why.
 *
 * The spec's rule in one component: never a silent no-op, never a 403 toast.
 *
 * The reason is exposed BOTH as a `title` (the pointer affordance) and as a
 * visually-hidden element referenced by `aria-describedby` — a greyed button whose only
 * explanation is a tooltip the user never hovers is barely better than no explanation, and
 * `title` alone is not reliably announced by screen readers.
 *
 * It is deliberately NOT an `aria-label`. An earlier draft of this component set one, which
 * REPLACED the button's accessible name ("Load") with the reason — so the control the user
 * hears announced no longer matched the control they can see, and every test that looked
 * the button up by its name stopped finding it. `aria-describedby` adds to the name instead
 * of overwriting it, which is what is wanted here.
 *
 * `state` comes from `actionState`. This component never decides anything itself.
 */
export function FleetAction({
  state,
  onClick,
  busy,
  children,
  size = 'sm',
  variant,
  title,
}: {
  state: ActionState
  onClick: () => void
  busy?: boolean
  children: ReactNode
  size?: 'sm' | 'default'
  variant?: 'outline' | 'default'
  title?: string
}) {
  const disabled = !state.enabled
  const reason = state.enabled ? undefined : state.reason
  const reasonId = useId()
  return (
    <>
      <Button
        size={size}
        {...(variant ? { variant } : {})}
        onClick={onClick}
        disabled={disabled || busy}
        title={reason ?? title}
        {...(reason ? { 'aria-describedby': reasonId } : {})}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : null}
        {children}
      </Button>
      {reason && <span id={reasonId} className="sr-only">{reason}</span>}
    </>
  )
}

/**
 * A remote action that was attempted and refused.
 *
 * Rendered INLINE on the row that caused it, never as a toast: the whole reason task 5b
 * preserved `host_busy` / `model_not_loaded` / a named capability as distinct codes is so
 * the user can see which of them applies to which row. A toast detaches the answer from the
 * question and stacks four identical-looking errors when four rows fail.
 */
export function FleetFailure({ failure, onRetry }: { failure: RemoteFailure; onRetry?: () => void }) {
  return (
    <div className="mt-1.5 flex items-start gap-2 text-[12px]" role="status">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--err)' }} />
      <span className="min-w-0 flex-1" style={{ color: 'var(--err)' }}>
        {failure.message}
      </span>
      {/* Offered only when waiting really is the remedy. A retry button on "you were never
          granted models:load" would invite the user to click it forever. */}
      {failure.retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex shrink-0 items-center gap-1 font-medium text-accent hover:underline"
        >
          <RotateCw size={12} /> Retry
        </button>
      )}
    </div>
  )
}
