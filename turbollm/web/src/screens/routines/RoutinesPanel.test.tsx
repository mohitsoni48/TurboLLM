import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutinesPanel } from './RoutinesPanel'
import type { RoutineWithLatestRun } from '../../lib/routine-queries'

// Mocked once, shared by RoutinesPanel's OWN (now nonexistent) usage and — the actual list's new
// home — ConversationSidebar.tsx's RoutinesList. Same module, same mock, one source of truth.
const useRoutinesWithLatestRunMock = vi.fn()
vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return { ...actual, useRoutinesWithLatestRun: () => useRoutinesWithLatestRunMock() }
})

// Routines is experimental, off by default (Settings → Experimental) — ConversationSidebar now
// filters the "Routines" mode tab out entirely unless `daemon.experimental.routines` is on. Every
// test in this file is exercising the (now-enabled) Routines mode itself, not the gate, so it
// needs the flag reporting enabled by default.
vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return { ...actual, useSettings: () => ({ query: { data: { experimental: { routines: true } } } }) }
})

/** Reads the router's real location, so a navigation assertion checks where the app actually
 *  ends up rather than that some spy was called with a string. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <span data-testid="pathname">{pathname}</span>
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/routines']}>
        <RoutinesPanel />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function activeRoutine(): RoutineWithLatestRun {
  return {
    routine: {
      id: 'r1', flavor: 'chat', status: 'active', prompt: 'Summarize my inbox',
      scheduleDisplay: 'Runs daily at 9:00 AM', scheduleRule: { kind: 'daily', hour: 9, minute: 0 },
      nextFireAt: '2026-08-02T09:00:00.000Z', modelKey: 'm', createdAt: '', updatedAt: '',
    },
    latestRun: { id: 'run1', routineId: 'r1', status: 'ok', configSnapshot: '{}', startedAt: '2026-08-01T09:00:00.000Z' },
  }
}

beforeEach(() => useRoutinesWithLatestRunMock.mockReset())

// RoutinesPanel itself (/workspace/routines with nothing selected) is now just Routines mode's
// landing state — the list moved to the sidebar (ConversationSidebar.tsx's RoutinesList),
// mirroring how WorkspaceScreen/CodeHomeScreen are their own modes' landing states. So unlike the
// old version, its own main-content assertions no longer depend on how many routines exist.
describe('RoutinesPanel — landing state', () => {
  it('always shows the "select or create" prompt, regardless of how many routines exist', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [activeRoutine()], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    expect(screen.getByText(/Select a routine from the sidebar, or create one/)).toBeInTheDocument()
  })

  it('the "New routine" button navigates to the create route', async () => {
    const user = userEvent.setup()
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    // Two match this name now: the main-content empty-state CTA, and the sidebar's own "New"
    // icon button (title="New routine" in Routines mode) — both correctly navigate to the same
    // place, so either is a valid target for this assertion.
    await user.click(screen.getAllByRole('button', { name: /New routine/ })[0])
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/routines/new')
  })

  it('keeps the mobile sidebar trigger, so the drawer is reachable below md', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
  })
})

// The list itself now lives in the sidebar (a real peer of the Chat conversation list and Code
// session list — spec 20 §2.1's own follow-up to the "looks bolted on" feedback: Routines used
// to be a link pinned above the Code session list, with its list rendered in the main content
// area under a DIFFERENT mode's own chrome). Exercised here (not a dedicated ConversationSidebar
// test) because RoutinesPanel is what actually mounts it for the bare /workspace/routines route.
describe('RoutinesPanel — sidebar shows the real routines list', () => {
  it('renders each routine with its status and last-run summary', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [activeRoutine()], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    const title = screen.getByText('Summarize my inbox')
    const row = title.closest('[role="button"]')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('Active')).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText(/Ran successfully/)).toBeInTheDocument()
  })

  it('a populated row navigates to that routine\'s detail route', async () => {
    const user = userEvent.setup()
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [activeRoutine()], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    await user.click(screen.getByText('Summarize my inbox'))
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/routines/r1')
  })

  it('says "No routines yet" in the sidebar when there are none', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    expect(screen.getByText('No routines yet.')).toBeInTheDocument()
  })
})

// The whole point of this task: Routines is now a real peer of Chat/Code in the mode switch,
// not a link pinned above the Code session list that left the pill itself always claiming
// "Code" was the active mode even while looking at Routines.
describe('RoutinesPanel — Routines is a real mode in the switch, not a bolted-on link', () => {
  it('the mode switch shows Routines as the current page, not Code', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    const group = screen.getByRole('group', { name: 'Workspace mode' })
    expect(within(group).getByText('Routines').closest('[aria-current="page"]')).toBeInTheDocument()
    // Chat/Code are plain links here, not the "current page" — only one mode is ever active.
    expect(within(group).getByRole('link', { name: /Chat/ })).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: /Code/ })).toBeInTheDocument()
  })
})
