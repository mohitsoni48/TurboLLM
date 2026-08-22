import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './ui/tooltip'
import { Shell } from './Shell'
import type { Routine, RoutineRun } from '../lib/routine-types'
import type { RoutineWithLatestRun } from '../lib/routine-queries'
import type { Status } from '../lib/types'

const useRoutinesWithLatestRunMock = vi.fn()
vi.mock('../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/routine-queries')>()
  return { ...actual, useRoutinesWithLatestRun: () => useRoutinesWithLatestRunMock() }
})

// Routines is experimental, off by default (Settings → Experimental) — Shell.tsx now reads
// `daemon.experimental.routines` before it even asks `useRoutinesWithLatestRun` for a count, so
// every pre-existing badge test here needs it reporting enabled to keep testing what it always
// tested (the badge's OWN counting logic). The dedicated "hidden while off" behavior gets its own
// describe block below instead of being folded into every existing case.
const useSettingsMock = vi.fn()
vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return { ...actual, useSettings: () => useSettingsMock() }
})

function mockSettings(routinesEnabled: boolean) {
  useSettingsMock.mockReturnValue({ query: { data: { experimental: { routines: routinesEnabled } } } })
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', flavor: 'chat', status: 'active', prompt: 'Summarize my inbox',
    scheduleDisplay: 'Runs every hour', scheduleRule: { kind: 'interval', everyMs: 3_600_000 },
    nextFireAt: null, modelKey: 'm', createdAt: '', updatedAt: '',
    ...overrides,
  }
}

function run(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return { id: 'run1', routineId: 'r1', status: 'needs_approval', configSnapshot: '{}', startedAt: '', ...overrides }
}

function mockItems(items: RoutineWithLatestRun[]) {
  useRoutinesWithLatestRunMock.mockReturnValue({ items, isLoading: false, isError: false, refetch: vi.fn() })
}

/** Shell mounts EngineProvisionBanner, whose `useBackendInstall()` calls `useQueryClient()`
 *  unconditionally (before its own `if (!p) return null`), so a QueryClientProvider is required
 *  even though this test mocks away every routine query. The plan's literal render helper omitted
 *  it and throws "No QueryClient set" on the first render. */
function renderShell(status?: Status, scroll?: 'bounded' | 'document') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A FRESH element each call: re-rendering the same element reference makes React bail out of
  // reconciliation entirely, so `repoll()` would silently assert nothing.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <Shell status={status} online={false} version="v0.0.0-dev" scroll={scroll}>content</Shell>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree())
  return { ...view, repoll: () => view.rerender(tree()) }
}

/** Only the two fields NavRail reads off `status`; the rest of Status is irrelevant here. */
function statusWithDownloads(active: number): Status {
  return { engine: { state: 'stopped' }, downloads: { active } } as unknown as Status
}

beforeEach(() => {
  useRoutinesWithLatestRunMock.mockReset()
  mockItems([])
  useSettingsMock.mockReset()
  mockSettings(true)
})

describe('Shell nav badge', () => {
  it('shows no badge when nothing needs approval', () => {
    mockItems([])
    renderShell()
    expect(screen.queryByLabelText(/Workspace \(\d+ needing attention\)/)).not.toBeInTheDocument()
    // ...and the plain label is still the accessible name, i.e. the entry itself still renders.
    expect(screen.getByLabelText('Workspace')).toBeInTheDocument()
  })

  it('shows a count badge on Workspace when a routine needs approval', () => {
    mockItems([{ routine: routine(), latestRun: run() }])
    renderShell()
    expect(screen.getByLabelText('Workspace (1 needing attention)')).toBeInTheDocument()
  })

  it('counts every routine parked at needs_approval, not just the first', () => {
    mockItems([
      { routine: routine({ id: 'r1' }), latestRun: run({ id: 'run1', routineId: 'r1' }) },
      { routine: routine({ id: 'r2' }), latestRun: run({ id: 'run2', routineId: 'r2' }) },
      // An ordinary finished routine contributes nothing.
      { routine: routine({ id: 'r3' }), latestRun: run({ id: 'run3', routineId: 'r3', status: 'ok' }) },
    ])
    renderShell()
    expect(screen.getByLabelText('Workspace (2 needing attention)')).toBeInTheDocument()
  })

  /** The count reads the RAW run status, not `deriveRoutineDisplayStatus` — so a PAUSED routine
   *  whose run is parked at needs_approval still counts. That state is reachable (`/pause` only
   *  requires status 'active') and genuinely actionable: RoutinesPanel's row summary renders
   *  "Stalled, needs approval", RoutineEditPage renders a working approval card off the same raw
   *  read, and the notification poller fires for it. Deriving here would leave the user an OS
   *  notification with no matching nav badge. Pinning it so nobody re-derives the count later. */
  it('counts a paused routine whose last run is parked at needs_approval', () => {
    mockItems([{ routine: routine({ status: 'paused' }), latestRun: run() }])
    renderShell()
    expect(screen.getByLabelText('Workspace (1 needing attention)')).toBeInTheDocument()
  })

  /** The badge reads live query output on every render rather than latching anything, so a later
   *  poll that no longer reports an approval clears it. Re-renders the SAME tree (a real re-render
   *  of the mounted rail) rather than mounting a second Shell, so this genuinely exercises the
   *  update path. */
  it('drops the badge again once the approval is resolved', () => {
    mockItems([{ routine: routine(), latestRun: run() }])
    const { repoll } = renderShell()
    expect(screen.getByLabelText('Workspace (1 needing attention)')).toBeInTheDocument()

    mockItems([{ routine: routine(), latestRun: run({ status: 'ok' }) }])
    repoll()
    expect(screen.queryByLabelText(/Workspace \(\d+ needing attention\)/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Workspace')).toBeInTheDocument()
  })

  /** Regression guard: this task rewrote the single `badge` expression that Models' download
   *  counter (ADR-039) already used, so its branch needs its own coverage — including that it
   *  keeps its own "downloading" wording rather than inheriting Workspace's. */
  it('leaves the Models downloads badge untouched', () => {
    mockItems([])
    renderShell(statusWithDownloads(3))
    expect(screen.getByLabelText('Models (3 downloading)')).toBeInTheDocument()
  })

  it('shows both badges at once, each with its own wording', () => {
    mockItems([{ routine: routine(), latestRun: run() }])
    renderShell(statusWithDownloads(2))
    expect(screen.getByLabelText('Models (2 downloading)')).toBeInTheDocument()
    expect(screen.getByLabelText('Workspace (1 needing attention)')).toBeInTheDocument()
  })

  it('hides the badge while Routines is off in Settings → Experimental, even with a pending approval', () => {
    mockSettings(false)
    mockItems([{ routine: routine(), latestRun: run() }])
    renderShell()
    expect(screen.queryByLabelText(/Workspace \(\d+ needing attention\)/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Workspace')).toBeInTheDocument()
  })

  it('hides the badge while settings has not loaded yet (conservative default)', () => {
    useSettingsMock.mockReturnValue({ query: { data: undefined } })
    mockItems([{ routine: routine(), latestRun: run() }])
    renderShell()
    expect(screen.queryByLabelText(/Workspace \(\d+ needing attention\)/)).not.toBeInTheDocument()
  })
})

/** Issue #178. The shell has two layouts, and which one is live is what decides whether the WINDOW
 *  can scroll a long screen. Chat/Workspace/Code/Discover must keep the bounded one; the list-style
 *  screens opt into the document one via `useDocumentScroll()`. */
describe('Shell scroll mode', () => {
  function mainEl() {
    return document.querySelector('main') as HTMLElement
  }
  function shellEl() {
    return document.querySelector('.app-shell') as HTMLElement
  }

  it('defaults to the bounded shell: main is the scroller and <html> stays locked', () => {
    renderShell()
    expect(mainEl().className).toContain('overflow-auto')
    expect(mainEl().className).toContain('min-h-0')
    expect(shellEl().className).toContain('h-full')
    expect(document.documentElement.classList.contains('tllm-doc-scroll')).toBe(false)
  })

  it('in document mode main stops being a scroller and <html> is unlocked', () => {
    renderShell(undefined, 'document')
    expect(mainEl().className).not.toContain('overflow-auto')
    // `min-h-0` comes off with it, or `main` could collapse below its content in the
    // now auto-height column.
    expect(mainEl().className).not.toContain('min-h-0')
    expect(shellEl().className).toContain('min-h-dvh')
    expect(shellEl().className).not.toContain('h-full')
    expect(document.documentElement.classList.contains('tllm-doc-scroll')).toBe(true)
  })

  it('removes the <html> unlock again when the shell unmounts', () => {
    const { unmount } = renderShell(undefined, 'document')
    expect(document.documentElement.classList.contains('tllm-doc-scroll')).toBe(true)
    unmount()
    expect(document.documentElement.classList.contains('tllm-doc-scroll')).toBe(false)
  })

  /** LOAD-BEARING: MobileNav used to be `position: static`, which only works while the page can't
   *  scroll. Unlocked, a static bar sits at the end of a 3000px document — measured at top 3019 on
   *  a 850px-tall viewport, i.e. off-screen. Same for the desktop rail, which would otherwise
   *  stretch the full page height. */
  it('keeps both nav surfaces pinned to the viewport, in either mode', () => {
    for (const mode of ['bounded', 'document'] as const) {
      const view = renderShell(undefined, mode)
      const [rail, mobile] = Array.from(document.querySelectorAll('nav')) as HTMLElement[]
      expect(rail.className).toContain('sticky')
      expect(rail.className).toContain('top-0')
      expect(rail.className).toContain('h-dvh')
      expect(mobile.className).toContain('sticky')
      expect(mobile.className).toContain('bottom-0')
      expect(mobile.className).toContain('z-30')
      // Pins the height index.css's `--tllm-mobile-nav-h` is written against.
      expect(mobile.className).toContain('h-14')
      view.unmount()
    }
  })
})
