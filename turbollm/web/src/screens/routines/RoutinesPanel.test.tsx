import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutinesPanel } from './RoutinesPanel'

const useRoutinesWithLatestRunMock = vi.fn()
vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return { ...actual, useRoutinesWithLatestRun: () => useRoutinesWithLatestRunMock() }
})

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><RoutinesPanel /></MemoryRouter>
    </QueryClientProvider>,
  )
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
    useRoutinesWithLatestRunMock.mockReturnValue({
      items: [{
        routine: {
          id: 'r1', flavor: 'chat', status: 'active', prompt: 'Summarize my inbox',
          scheduleDisplay: 'Runs daily at 9:00 AM', scheduleRule: { kind: 'daily', hour: 9, minute: 0 },
          nextFireAt: '2026-08-02T09:00:00.000Z', modelKey: 'm', createdAt: '', updatedAt: '',
        },
        latestRun: { id: 'run1', routineId: 'r1', status: 'ok', configSnapshot: '{}', startedAt: '2026-08-01T09:00:00.000Z' },
      }],
      isLoading: false, isError: false, refetch: vi.fn(),
    })
    renderPanel()
    expect(screen.getByText('Summarize my inbox')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText(/Ran successfully/)).toBeInTheDocument()
  })
})
