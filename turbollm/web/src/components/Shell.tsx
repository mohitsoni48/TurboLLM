import { type ReactNode, useEffect } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, Boxes, Code2, Cpu, PanelsTopLeft, Puzzle, Settings2 } from 'lucide-react'
import { cn } from '../lib/utils'
import type { Status } from '../lib/types'
import { useRoutinesWithLatestRun } from '../lib/routine-queries'
import { StateChip } from './StateChip'
import { BoltMark } from './Logo'
import { EngineProvisionBanner } from './EngineProvisionBanner'
import { EngineLoadErrorBanner } from './EngineLoadErrorBanner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './ui/tooltip'

const NAV = [
  { to: '/workspace', label: 'Workspace', icon: PanelsTopLeft },
  { to: '/models',    label: 'Models',    icon: Boxes },
  { to: '/engines',   label: 'Engines',   icon: Cpu },
  { to: '/customize', label: 'Customize', icon: Puzzle },
  { to: '/usage',     label: 'Usage',     icon: BarChart3 },
  { to: '/developer', label: 'Developer', icon: Code2 },
  { to: '/settings',  label: 'Settings',  icon: Settings2 },
] as const

export function Shell({
  status,
  online,
  version,
  children,
}: {
  status: Status | undefined
  online: boolean
  version: string
  children: ReactNode
}) {
  return (
    <div className="app-shell flex h-full">
      <NavRail status={status} online={online} version={version} className="hidden md:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <EngineProvisionBanner status={status} />
        <EngineLoadErrorBanner status={status} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        <MobileNav />
      </div>
    </div>
  )
}

function NavRail({
  status,
  online,
  version,
  className,
}: {
  status: Status | undefined
  online: boolean
  version: string
  className?: string
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const engineState = status?.engine.state ?? 'stopped'
  const activeDownloads = status?.downloads.active ?? 0

  // Routines parked at needs_approval (spec 20 §2.1). Read live on every render — nothing is
  // latched — and `useRoutinesWithLatestRun` polls on its own (15s on both the routines list and
  // each routine's runs), so this clears itself once an approval is answered from anywhere,
  // including another tab.
  //
  // Counted off the RAW `latestRun.status`, deliberately NOT through `deriveRoutineDisplayStatus`.
  // That helper answers a different question — "what does the status PILL read" — and its rule
  // that a non-active routine's own status wins would drop a PAUSED routine whose run is parked.
  // A parked run on a paused routine is genuinely actionable, and every other surface already
  // treats it that way off the same raw read:
  //   - RoutinesPanel's row summary (`lastRunSummary`) renders "Stalled, needs approval · <when>"
  //     regardless of routine.status, so the row the badge points at really is there.
  //   - RoutineEditPage computes `awaitingApproval` from the raw run status with no routine.status
  //     gate, and renders a working RoutineApprovalCard — approve/deny function on a paused one.
  //   - The notification poller (notify-routine.ts) diffs raw run status too, so it fires
  //     "Routine needs approval" for exactly these runs; deriving here would leave the user an OS
  //     notification with no nav-level affordance behind it.
  // Pausing this state is reachable in production (`/pause` only requires status 'active'), and a
  // parked run stays in the scheduler's inFlight set — blocking /run-now until approve/deny, not
  // clearing on Resume — so it is the state that most needs the nudge, not least.
  //
  // SPEC-GAP (00-conventions.md §8): spec 20 §2.1 also wants a transient "just failed/completed"
  // pulse. That needs either a backend seen/unseen flag or client-side timestamp diffing that the
  // shipped types don't support, so this badge is the unambiguous needs-approval count only.
  const { items: routineItems } = useRoutinesWithLatestRun()
  const routinesNeedingAttention = routineItems.filter(
    (it) => it.latestRun?.status === 'needs_approval',
  ).length

  // Keyboard shortcuts: Ctrl+1–5 (or Cmd+1–5 on Mac) navigate to the
  // corresponding NAV item. Ignored when focus is in an editable element.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      // Only handle the digit keys 1–9. Non-digit keys (e.g. Ctrl+C, Ctrl+V)
      // make parseInt return NaN; without this guard NaN slips past the range
      // check below, calls preventDefault() (silently killing native copy/paste
      // everywhere in the app) and then throws on NAV[NaN].
      if (!/^[1-9]$/.test(e.key)) return
      const idx = parseInt(e.key, 10) - 1
      if (idx < 0 || idx >= NAV.length) return
      // Don't hijack number input in text fields / chat composer.
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? ''
      const editable = (document.activeElement as HTMLElement | null)?.isContentEditable
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return
      e.preventDefault()
      navigate(NAV[idx].to)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <nav
      className={cn(
        // Icon-only at md–lg (w-16). At xl+ expand to show labels (w-48).
        'flex w-16 shrink-0 flex-col items-center bg-panel-2 py-3',
        'xl:w-48 xl:items-start xl:px-3',
        className,
      )}
    >
      {/* Logo */}
      <div className="mb-4 flex w-full items-center justify-center gap-2 xl:justify-start xl:pl-1">
        <div
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-on-accent"
          style={{ background: 'var(--accent)' }}
          aria-hidden
        >
          <BoltMark className="h-4 w-4" />
        </div>
        <span className="hidden text-[15px] font-semibold tracking-tight xl:inline" aria-hidden>
          <span className="text-ink">Turbo</span>
          <span className="text-accent">LLM</span>
        </span>
      </div>

      {/* Nav items — icon-only below xl; icon + label at xl+.
          NOTE: TooltipTrigger asChild wraps the link in a Radix Slot, which merges
          `className` as a STRING — a NavLink function-className would be stringified
          and never run. So compute active state here and pass a plain string.
          At xl+ the label is visible so the tooltip is hidden via pointer-events-none. */}
      <ul className="flex flex-1 flex-col items-center gap-1 xl:w-full xl:items-stretch">
        {NAV.map(({ to, label, icon: Icon }) => {
          const isActive = pathname === to || pathname.startsWith(`${to}/`)
          // Count badge, one shared mechanism (ADR-039's downloads indicator, extended):
          // Models counts active downloads, Workspace counts routines waiting on an approval.
          // No badge when zero (or, defensively, negative — the `> 0` floor is what keeps a bad
          // count out of the truthy `badge ?` label branches below).
          const count =
            to === '/models' ? activeDownloads
            : to === '/workspace' ? routinesNeedingAttention
            : 0
          const badge = count > 0 ? count : 0
          // Kept next to the count so the two can't drift apart when another entry is badged.
          const badgeNoun = to === '/models' ? 'downloading' : 'needing attention'
          return (
            <li key={to}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={to}
                    aria-label={badge ? `${label} (${badge} ${badgeNoun})` : label}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'relative flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] transition-colors',
                      // At xl+ stretch to full rail width, left-align icon+label
                      'xl:w-full xl:justify-start xl:gap-3 xl:px-3',
                      isActive
                        ? 'bg-accent/12 text-accent'
                        : 'text-muted hover:bg-panel hover:text-ink',
                    )}
                  >
                    <span className="relative shrink-0">
                      <Icon size={20} />
                      {/* Collapsed rail: dot badge anchored to the icon */}
                      {badge > 0 && (
                        <span
                          className="tllm-pulse absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold leading-none text-on-accent xl:hidden"
                          style={{ background: 'var(--ok)' }}
                        >
                          {badge}
                        </span>
                      )}
                    </span>
                    <span className="hidden xl:inline text-sm font-medium">{label}</span>
                    {/* Expanded rail: count badge trailing the label */}
                    {badge > 0 && (
                      <span
                        className="tllm-pulse ml-auto hidden h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold leading-none text-on-accent xl:grid"
                        style={{ background: 'var(--ok)' }}
                      >
                        {badge}
                      </span>
                    )}
                  </Link>
                </TooltipTrigger>
                {/* Hide tooltip at xl+ since label is already visible */}
                <TooltipContent side="right" className="xl:hidden">
                  {badge ? `${label} · ${badge} ${badgeNoun}` : label}
                </TooltipContent>
              </Tooltip>
            </li>
          )
        })}
      </ul>

      {/* Engine state chip (ADR-039): bottom of the rail, just above the version.
          Click → Engines screen. Collapsed rail shows just the dot; at xl+ the
          full dot+label pill. */}
      <div className="mt-2 flex w-full flex-col items-center gap-1.5 xl:items-start xl:pl-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => navigate('/engines')}
              aria-label={`Engine: ${engineState} — open Engines`}
              className="flex items-center justify-center rounded-full transition-colors xl:justify-start"
            >
              {/* Collapsed rail: dot only */}
              <StateChip state={engineState} dotOnly className="xl:hidden" />
              {/* Expanded rail: dot + label pill */}
              <StateChip state={engineState} className="hidden xl:inline-flex" />
            </button>
          </TooltipTrigger>
          {/* Tooltip carries the connection + version detail; hidden at xl+ where the label shows. */}
          <TooltipContent side="right" className="xl:hidden">
            {(online ? 'Daemon connected' : 'Daemon offline') + ` · ${version}`}
          </TooltipContent>
        </Tooltip>
        {/* Version string beneath the chip (xl+ only — no room when collapsed). */}
        <span className="hidden text-[11px] text-faint xl:inline">{version}</span>
      </div>
    </nav>
  )
}

function MobileNav() {
  return (
    <nav className="flex shrink-0 border-t border-border bg-panel-2 md:hidden">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }: { isActive: boolean }) =>
            cn(
              'flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] transition-colors',
              isActive ? 'text-accent' : 'text-muted',
            )
          }
        >
          <Icon size={20} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
