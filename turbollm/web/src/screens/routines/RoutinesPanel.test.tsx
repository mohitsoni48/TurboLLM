import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutinesPanel } from './RoutinesPanel'
import type { RoutineWithLatestRun } from '../../lib/routine-queries'

const useRoutinesWithLatestRunMock = vi.fn()
vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return { ...actual, useRoutinesWithLatestRun: () => useRoutinesWithLatestRunMock() }
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
      <MemoryRouter initialEntries={['/workspace/code/routines']}>
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

describe('RoutinesPanel', () => {
  it('shows a loading skeleton, not the empty or error state, while fetching', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: true, isError: false, refetch: vi.fn() })
    const { container } = renderPanel()
    expect(screen.queryByText(/No routines yet/)).not.toBeInTheDocument()
    expect(screen.queryByText('Could not load routines.')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.tllm-pulse').length).toBeGreaterThan(0)
  })

  it('shows the illustrated empty state with a CTA when there are zero routines', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    expect(screen.getByText(/No routines yet/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /New routine/ }).length).toBeGreaterThan(0)
  })

  it('shows an inline error with a working retry on failure', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: true, refetch })
    renderPanel()
    expect(screen.getByText('Could not load routines.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalled()
  })

  it('renders a populated row with its status badge and last-run summary', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [activeRoutine()], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    const title = screen.getByText('Summarize my inbox')
    const row = title.closest('button')
    expect(row).not.toBeNull()
    // Scoped to the row: the Code sidebar this screen now renders has its own "Active" session
    // filter, so an unscoped getByText would match two different things.
    expect(within(row!).getByText('Active')).toBeInTheDocument()
    expect(within(row!).getByText(/Ran successfully/)).toBeInTheDocument()
  })
})

// M4.2 — the wiring had no verification of any kind: the CTA's target and the row's target were
// three literal path strings nothing ever exercised.
describe('RoutinesPanel — navigation', () => {
  it('the empty-state CTA navigates to the create route', async () => {
    const user = userEvent.setup()
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    await user.click(screen.getAllByRole('button', { name: /New routine/ })[0])
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/code/routines/new')
  })

  it('the header CTA navigates to the create route', async () => {
    const user = userEvent.setup()
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [activeRoutine()], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    await user.click(screen.getByRole('button', { name: /New routine/ }))
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/code/routines/new')
  })

  it('a populated row navigates to that routine detail route', async () => {
    const user = userEvent.setup()
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [activeRoutine()], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    await user.click(screen.getByText('Summarize my inbox'))
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/code/routines/r1')
  })
})

// H2 — the screen is a Code-mode screen, so it must render Code mode's own sidebar. Without it
// the session list, the Chat|Code pill and the Routines link itself all disappear on this route,
// which also made the link's active-state treatment unobservable dead code.
describe('RoutinesPanel — Code-mode chrome', () => {
  it('renders the Code sidebar, with its Routines link marked as the current page', async () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    const link = await screen.findByRole('link', { name: /Routines/ })
    expect(link).toHaveAttribute('href', '/workspace/code/routines')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link.className).toContain('text-accent')
  })

  it('keeps the mobile sidebar trigger, so the drawer is reachable below md', () => {
    useRoutinesWithLatestRunMock.mockReturnValue({ items: [], isLoading: false, isError: false, refetch: vi.fn() })
    renderPanel()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
  })
})
