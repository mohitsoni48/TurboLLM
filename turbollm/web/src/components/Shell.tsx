import { type ReactNode, useEffect, useLayoutEffect } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, Boxes, Code2, Cpu, PanelsTopLeft, Puzzle, Settings2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { type ScrollMode, useScrollMode } from '../lib/scroll-mode'
import type { Status } from '../lib/types'
import { useRoutinesWithLatestRun } from '../lib/routine-queries'
import { useSettings } from '../lib/queries'
import { track } from '../lib/api'
import { rememberWorkspacePath, resolveNavTarget } from '../lib/workspace-nav'
import { StateChip } from './StateChip'
import { BoltMark } from './Logo'
import { HardwareBar } from './HardwareBar'
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
  scroll,
  children,
}: {
  status: Status | undefined
  online: boolean
  version: string
  /**
   * Force a scroll mode instead of resolving it from the mounted view's own
   * `useDocumentScroll()` opt-in. Only tests pass this — App.tsx does not, so the
   * screens stay the single source of truth for whether their content scrolls.
   */
  scroll?: ScrollMode
  children: ReactNode
}) {
  // The wizard is a full-screen, linear flow (spec 25 §4) — every nav link is an
  // escape hatch the founder never asked for here, and "Skip onboarding" /
  // "I don't need onboarding" already cover leaving on purpose. Found live: the
  // rail rendered right alongside the wizard, letting a click wander off to
  // Models/Settings/etc. mid-flow with no wizard-side awareness of the detour.
  const { pathname } = useLocation()
  const onOnboarding = pathname === '/onboarding'

  // Issue #178: the long list-style screens (Models library, Engines, Developer, Customize, Usage,
  // Settings) opt into scrolling the DOCUMENT via `useDocumentScroll()`; Chat / Workspace / Code /
  // Discover stay in the bounded shell, where a pane must stay pinned while an inner list scrolls.
  // See lib/scroll-mode.ts for why this is per-view rather than per-route.
  // Hook called unconditionally (rules of hooks) — the `scroll` override is applied to its result.
  const requestedScroll = useScrollMode()
  const documentScroll = (scroll ?? requestedScroll) === 'document'

  // Release the `height: 100% / overflow: hidden` lock in index.css. Layout effect so the class and
  // the markup below always agree within a single paint — a passive effect would let one frame of
  // an unlocked <html> render behind a freshly-mounted bounded screen's `h-full` panes.
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('tllm-doc-scroll', documentScroll)
    return () => root.classList.remove('tllm-doc-scroll')
  }, [documentScroll])

  // With the document scrolling, the scroll offset now survives a route change (it used to live on
  // a per-screen element that unmounted with it), so a nav from halfway down Models would drop you
  // halfway down Engines. Reset on every path change while in document mode; the bounded shell
  // needs nothing here, and a tab flip inside one screen doesn't change `pathname`, so switching
  // Models' Library/Discover tabs doesn't yank the page either.
  // Guarded on a non-zero offset rather than called unconditionally: no point asking for a scroll
  // that is already where it would land, and it keeps jsdom (which has no scrollTo) out of it.
  useEffect(() => {
    if (documentScroll && window.scrollY !== 0) window.scrollTo(0, 0)
  }, [pathname, documentScroll])

  return (
    <div className={cn('app-shell flex', documentScroll ? 'min-h-dvh' : 'h-full')}>
      {!onOnboarding && <NavRail status={status} online={online} version={version} className="hidden md:flex" />}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* QA_BUGS.md BUG-03/BUG-07: on a phone this column is the topmost content under the
            status bar (NavRail is `hidden md:flex` below md, and even at md+ it doesn't cover
            this column). Android's WebView resolves `env(safe-area-inset-*)` to 0px on many
            builds, so the native side injects the real inset as the `--tllm-safe-top` CSS
            custom property instead (see DaemonWebViewScreen's injectSafeAreaInsets) — this
            padding is a no-op everywhere the variable isn't set (desktop, non-Android). One
            padding here, on the shared ancestor of every banner and screen header, beats
            chasing the inset onto each header/banner separately as new ones get added. */}
        <div style={{ paddingTop: 'var(--tllm-safe-top)' }}>
          <EngineProvisionBanner status={status} />
          <EngineLoadErrorBanner status={status} />
        </div>
        {/* Bounded mode: `main` is the scroller. Document mode: it must NOT be, or the window
            still has nothing to scroll — and `min-h-0` comes off with it so `main` keeps a
            content-height floor inside the now auto-height column. */}
        <main className={cn('flex-1', !documentScroll && 'min-h-0 overflow-auto')}>{children}</main>
        {/* ADR-383: the global hardware status bar, above MobileNav. It self-gates on the
            store's hwBar toggle (rendering nothing when off) and polls only while mounted, so
            mounting it here is one line and costs the daemon nothing when it is switched off. */}
        {!onOnboarding && <HardwareBar />}
        {!onOnboarding && <MobileNav />}
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

  // Record the current /workspace/* sub-route (Chat conversation, Code session, or Routines) so
  // the Workspace nav item can return here later instead of always landing on a new chat — see
  // workspace-nav.ts's own header comment for the founder-reported bug this fixes.
  useEffect(() => {
    rememberWorkspacePath(pathname)
  }, [pathname])

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
  // Routines is experimental, off by default (Settings → Experimental) — while off, this badge
  // must stop polling entirely, not just render as 0: `useRoutinesWithLatestRun` mounts
  // unconditionally here regardless of route, and a hidden feature has no business fetching in
  // the background.
  const routinesEnabled = useSettings().query.data?.experimental?.routines ?? false
  const { items: routineItems } = useRoutinesWithLatestRun(routinesEnabled)
  const routinesNeedingAttention = routinesEnabled
    ? routineItems.filter((it) => it.latestRun?.status === 'needs_approval').length
    : 0

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
      navigate(resolveNavTarget(NAV[idx].to))
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
        // Issue #178: in document-scroll mode `.app-shell` is as tall as the page, so a stretched
        // rail would run off the bottom with it. Pinned to one viewport instead. In bounded mode
        // this is a no-op: `h-dvh` equals the shell height it already stretched to, and `sticky`
        // has no scrolling ancestor to stick against.
        'sticky top-0 h-dvh',
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
                    to={resolveNavTarget(to)}
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
              onClick={() => { track('engines', 'open_engines_from_nav_chip'); navigate('/engines') }}
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
  // Computed manually off the STATIC `to` (same as NavRail above), not left to NavLink's own
  // `isActive` — that matches against the `to` PROP, which for Workspace is now a moving target
  // (resolveNavTarget's remembered sub-route). A NavLink-computed isActive would go stale the
  // moment the user is on a DIFFERENT Workspace sub-route than whichever one happens to be
  // remembered right now, reading "not active" while genuinely inside Workspace.
  const { pathname } = useLocation()
  // QA_BUGS.md BUG-04: on Android the gesture-navigation home indicator overlaps the bottom
  // tab bar. Pad the bottom by the safe-area inset so the tab labels sit above the pill.
  return (
    // Issue #178, load-bearing: this used to be `position: static`, which is fine only while the
    // page can't scroll. In document-scroll mode a static bar sits at the END of a 3000px page —
    // i.e. nowhere near the screen. `sticky bottom-0` keeps it on the viewport edge, `z-30` keeps
    // page content from painting over it. Both are inert in the bounded shell, where the column
    // has no scrolling ancestor and the bar is already the last row of a 100vh flex column.
    // `h-14` pins the height that index.css's `--tllm-mobile-nav-h` is written against (it was
    // already 56px from its content; now it says so) — keep the two in step.
    // QA_BUGS.md BUG-04: the gesture-navigation pill sits UNDER the bar's own icon row on a
    // phone with no 3-button nav bar reserving that space. `--tllm-safe-bottom` (native-injected,
    // see the Shell wrapper's paddingTop comment above) adds that space back as extra room below
    // the (still `h-14`, still vertically-centered) icon row rather than stealing from it, so the
    // pill lands in blank space instead of slicing through "Customize"/"Usage"'s labels. Elsewhere
    // (desktop, a phone with 3-button nav, or where the variable isn't set) this is a no-op.
    // will-change: transform forces this sticky bar onto its own GPU compositing layer —
    // founder-reported: on this Android WebView, a fast vertical scroll could make the bar
    // itself flicker out of view mid-gesture (a known sticky-position repaint timing issue on
    // some WebView builds) before reappearing once the scroll settled. Promoting it to its own
    // layer up front means it never has to be repainted mid-scroll in the first place.
    <nav className="sticky bottom-0 z-30 flex h-14 shrink-0 border-t border-border bg-panel-2 md:hidden" style={{ paddingBottom: 'var(--tllm-safe-bottom)', willChange: 'transform' }}>
      {NAV.map(({ to, label, icon: Icon }) => {
        const isActive = pathname === to || pathname.startsWith(`${to}/`)
        return (
          <NavLink
            key={to}
            to={resolveNavTarget(to)}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] transition-colors',
              isActive ? 'text-accent' : 'text-muted',
            )}
          >
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
