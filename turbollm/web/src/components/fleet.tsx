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
import { AlertTriangle, ChevronDown, Cloud, Download, Loader2, Monitor, RotateCw } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { FleetMachine, FleetOrigin } from '../lib/fleet'
import type { MachineOption } from '../lib/fleet-sources'
import type { RemoteFailure } from '../lib/remote-failure'
import { actionState, type ActionState } from '../lib/capability-ui'
import type { LinkSummary } from '../lib/link-api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
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

/**
 * "Download to…" — pick which machine in the fleet should fetch a file.
 *
 * This is `startRemoteDownload`'s consumer, and the reason requirement 2 says
 * "start/cancel driven by `actionState`" rather than just "cancel". A download is the one
 * fleet action where the target is a genuine choice rather than a property of the row you
 * clicked: the file exists on Hugging Face, not on any machine yet, so *which* machine
 * fetches it is the question. Every other fleet control acts on a row that already belongs
 * to a machine.
 *
 * With no links this collapses to the plain button it replaces — an install without Turbo
 * Link sees no menu, no target, and no change at all.
 *
 * Each machine's entry is gated by `actionState('downloads:write', …)`, so a link without
 * the grant is a disabled entry carrying the reason, never a hidden one: hiding it would
 * make the machine look incapable rather than un-permitted, which is a different problem
 * with a different fix.
 */
export function DownloadTargetMenu({
  links,
  busy,
  disabled,
  label,
  onPick,
}: {
  links: LinkSummary[]
  busy?: boolean
  disabled?: boolean
  label: string
  /** `null` = this machine. */
  onPick: (linkId: string | null) => void
}) {
  const menuId = useId()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="download-target-trigger"
        disabled={disabled || busy}
        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius)] px-3 py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
        style={{ background: 'var(--accent)', color: 'var(--accent-ink, #fff)' }}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {label}
        <ChevronDown size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
          Download to
        </div>
        <DropdownMenuItem onSelect={() => onPick(null)}>
          <Monitor size={14} /> This machine
        </DropdownMenuItem>
        {links.map((l) => {
          const state = actionState('downloads:write', { kind: 'remote', linkId: l.id, machine: l.name }, l)
          // Same `title` + `aria-describedby` pairing as `FleetAction`, for the same reason:
          // a `title` alone is not reliably announced, so a disabled entry would be greyed
          // out with its explanation reachable only by hovering. `describedby` ADDS to the
          // item's accessible name rather than replacing it, so the machine's name — the
          // thing the user is looking for in the menu — still announces first.
          const reasonId = `${menuId}-${l.id}-reason`
          return (
            <DropdownMenuItem
              key={l.id}
              disabled={!state.enabled}
              title={state.enabled ? undefined : state.reason}
              {...(state.enabled ? {} : { 'aria-describedby': reasonId })}
              onSelect={() => state.enabled && onPick(l.id)}
            >
              <Cloud size={14} /> {l.name}
              {!state.enabled && <span id={reasonId} className="sr-only">{state.reason}</span>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
