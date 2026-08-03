import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutineEditPage } from './RoutineEditPage'
import { ApiError } from '../../lib/api'
import type { Routine, RoutineRun } from '../../lib/routine-types'

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useChatAgents: () => ({ data: [{ id: 'agent-1', name: 'Research Agent', description: '', systemPrompt: '', skillIds: [], tools: [] }] }),
    useModels: () => ({ data: { models: [{ key: 'model-a', name: 'Model A', compatibleWithActiveEngine: true }] } }),
  }
})

// Real sonner needs a mounted <Toaster/> to be observable, and the 401 assertions below are
// checking this feature's ONLY auth feedback (routine-api.ts's header comment).
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('../../components/ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), warning: vi.fn() },
}))

/** Mutable holders so each test sets its own routine/runs before rendering — and, more to the
 *  point, so a test can CHANGE them between renders and prove the page re-reads them rather than
 *  holding a copy. */
let routineData: Routine | undefined
let runsData: RoutineRun[] = []
const queryState = { isLoading: false, isError: false }
const routineRefetch = vi.fn()
const createMutate = vi.fn()
const confirmMutate = vi.fn()
const updateMutate = vi.fn()
const removeMutate = vi.fn()
const pauseMutate = vi.fn()
const resumeMutate = vi.fn()
const runNowMutate = vi.fn()
const approveMutate = vi.fn()
const denyMutate = vi.fn()

vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return {
    ...actual,
    useRoutine: () => ({ data: routineData, isLoading: queryState.isLoading, isError: queryState.isError, refetch: routineRefetch }),
    useRoutineRuns: () => ({ data: runsData, isLoading: false, isError: false, refetch: vi.fn() }),
    useRoutineMutations: () => ({
      create: { mutate: createMutate, isPending: false },
      confirm: { mutate: confirmMutate, isPending: false },
      update: { mutate: updateMutate, isPending: false },
      remove: { mutate: removeMutate, isPending: false },
      pause: { mutate: pauseMutate, isPending: false },
      resume: { mutate: resumeMutate, isPending: false },
      runNow: { mutate: runNowMutate, isPending: false },
      approve: { mutate: approveMutate, isPending: false },
      deny: { mutate: denyMutate, isPending: false },
    }),
  }
})

function LocationProbe() {
  const { pathname } = useLocation()
  return <span data-testid="pathname">{pathname}</span>
}

function pendingRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', flavor: 'chat', status: 'pending_confirmation', prompt: 'Summarize my inbox',
    scheduleDisplay: 'Runs daily at 9:00 AM', scheduleRule: { kind: 'daily', hour: 9, minute: 0 },
    nextFireAt: null, modelKey: 'model-a', agentId: 'agent-1', createdAt: '', updatedAt: '', ...overrides,
  }
}
function activeRoutine(overrides: Partial<Routine> = {}): Routine {
  return pendingRoutine({ status: 'active', nextFireAt: '2026-08-02T09:00:00.000Z', ...overrides })
}

function newTree() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/workspace/code/routines/new']}>
        <Routes><Route path="/workspace/code/routines/new" element={<RoutineEditPage />} /></Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
}
function renderNew() {
  return render(newTree())
}

function detailTree(id = 'r1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/workspace/code/routines/${id}`]}>
        <Routes><Route path="/workspace/code/routines/:routineId" element={<RoutineEditPage />} /></Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
}
function renderDetail(id = 'r1') {
  return render(detailTree(id))
}

/** The page renders the Code-mode sidebar, which has its own "Active" session filter and its own
 *  buttons — scope status/badge assertions to the routine's own header row. */
function headerRow(): HTMLElement {
  return screen.getByText('Summarize my inbox').closest('div') as HTMLElement
}

beforeEach(() => {
  routineData = undefined
  runsData = []
  queryState.isLoading = false
  queryState.isError = false
  routineRefetch.mockReset()
  createMutate.mockReset(); confirmMutate.mockReset(); updateMutate.mockReset(); removeMutate.mockReset()
  pauseMutate.mockReset(); resumeMutate.mockReset(); runNowMutate.mockReset()
  approveMutate.mockReset(); denyMutate.mockReset()
  toastError.mockReset(); toastSuccess.mockReset()
})

describe('RoutineEditPage — create flow', () => {
  it('fills the form, creates a pending routine, then shows the confirm gate', async () => {
    const user = userEvent.setup()
    createMutate.mockImplementation((_input, opts) => opts.onSuccess(pendingRoutine()))
    renderNew()

    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'Summarize my inbox')
    await user.selectOptions(screen.getByDisplayValue('Choose a model…'), 'model-a')
    await user.selectOptions(screen.getByDisplayValue('Choose an agent…'), 'agent-1')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Summarize my inbox', modelKey: 'model-a', agentId: 'agent-1', flavor: 'chat', scheduleDisplay: 'Runs daily at 9:00 AM' }),
      expect.anything(),
    )
    expect(await screen.findByText('Confirm this new routine')).toBeInTheDocument()
  })

  it('Continue stays disabled until every flavor-required field is filled', async () => {
    const user = userEvent.setup()
    renderNew()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'Summarize my inbox')
    await user.selectOptions(screen.getByDisplayValue('Choose a model…'), 'model-a')
    // Agent still unset — a chat routine cannot be created without one (routine-routes.ts's
    // validateCreate), so the button must not offer to try.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await user.selectOptions(screen.getByDisplayValue('Choose an agent…'), 'agent-1')
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })

  it('labels a 401 on create as an authorization problem, the only auth feedback this surface has', async () => {
    const user = userEvent.setup()
    createMutate.mockImplementation((_input, opts) => opts.onError(new ApiError('unauthorized', 'A valid API key is required to schedule a Code routine from a non-host device.', 401)))
    renderNew()
    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'Do a thing')
    await user.selectOptions(screen.getByDisplayValue('Choose a model…'), 'model-a')
    await user.selectOptions(screen.getByDisplayValue('Choose an agent…'), 'agent-1')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(toastError).toHaveBeenCalledWith('Not authorized: A valid API key is required to schedule a Code routine from a non-host device.')
    // Still on the form, with the draft intact, so the user can retry after pasting a key.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })

  // ── "actual current state, not recorded state" ────────────────────────────────────────────
  it('replaces the confirm gate with a settled state once the routine stops being pending_confirmation', async () => {
    const user = userEvent.setup()
    createMutate.mockImplementation((_input, opts) => opts.onSuccess(pendingRoutine()))
    const { rerender } = renderNew()
    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'Summarize my inbox')
    await user.selectOptions(screen.getByDisplayValue('Choose a model…'), 'model-a')
    await user.selectOptions(screen.getByDisplayValue('Choose an agent…'), 'agent-1')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Confirm this new routine')).toBeInTheDocument()

    // The routine got confirmed elsewhere (another tab, the chat transcript's own confirm card)
    // while this page sat open, and the detail query the page now runs against the created id
    // returns an ACTIVE routine. This card's Cancel is a hard DELETE with cascade to the run
    // history and DELETE has no status guard of any kind, so leaving it actionable turns
    // "dismiss this proposal" into "silently destroy a live scheduled job".
    routineData = activeRoutine()
    rerender(newTree())
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(screen.getByText(/no longer awaiting confirmation/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument()
    expect(removeMutate).not.toHaveBeenCalled()
  })
})

describe('RoutineEditPage — existing-routine detail', () => {
  it('shows status badge, Pause for an active routine, and run history', () => {
    routineData = activeRoutine()
    runsData = [{ id: 'run1', routineId: 'r1', status: 'ok', configSnapshot: '{}', startedAt: '2026-08-01T09:00:00.000Z' }]
    renderDetail()
    expect(within(headerRow()).getByText('Active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument()
    expect(screen.getByText(/Ran successfully/)).toBeInTheDocument()
  })

  it('Pause calls the pause mutation with the routine id', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: /Pause/ }))
    expect(pauseMutate).toHaveBeenCalledWith('r1', expect.anything())
  })

  it('offers Resume (not Pause) for a paused routine, and still offers Run now', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine({ status: 'paused', nextFireAt: null })
    renderDetail()
    expect(screen.queryByRole('button', { name: /Pause/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Resume/ }))
    expect(resumeMutate).toHaveBeenCalledWith('r1', expect.anything())
    // /run-now only refuses 'not_confirmed' (routine-routes.ts), so a paused routine can still be
    // fired by hand.
    await user.click(screen.getByRole('button', { name: /Run now/ }))
    expect(runNowMutate).toHaveBeenCalledWith('r1', expect.anything())
  })

  it('offers neither Pause/Resume nor Run now for a routine still awaiting confirmation', () => {
    routineData = pendingRoutine()
    renderDetail()
    expect(within(headerRow()).getByText('Awaiting confirmation')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pause/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Resume/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument()
  })

  it('editing a field and reviewing shows the update confirm gate with a diff, and Confirm calls update', async () => {
    const user = userEvent.setup()
    updateMutate.mockImplementation((_v, opts) => opts.onSuccess(activeRoutine({ prompt: 'New prompt' })))
    routineData = activeRoutine()
    renderDetail()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const promptBox = screen.getByPlaceholderText(/What should this routine do/)
    await user.clear(promptBox)
    await user.type(promptBox, 'New prompt')
    await user.click(screen.getByRole('button', { name: 'Review change' }))

    expect(screen.getByText('Confirm this change')).toBeInTheDocument()
    expect(screen.getByText('− Summarize my inbox')).toBeInTheDocument()
    expect(screen.getByText('+ New prompt')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(updateMutate).toHaveBeenCalledWith({ id: 'r1', patch: expect.objectContaining({ prompt: 'New prompt' }) }, expect.anything())
  })

  it('the inline edit form cannot change flavor — PUT can never apply it', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Code' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Chat' })).toBeDisabled()
  })

  it('Discard drops the proposed edit instead of leaving a confirm gate behind', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const promptBox = screen.getByPlaceholderText(/What should this routine do/)
    await user.clear(promptBox)
    await user.type(promptBox, 'Something else')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
    expect(updateMutate).not.toHaveBeenCalled()
  })

  it('an edit that changes nothing raises no confirm gate', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
  })

  it('renders an approval card, not a plain summary row, for a needs_approval run', () => {
    routineData = activeRoutine()
    runsData = [{
      id: 'run1', routineId: 'r1', status: 'needs_approval', configSnapshot: '{}',
      startedAt: '2026-08-01T09:00:00.000Z',
      pendingToolCall: JSON.stringify({ convId: 'c1', assistantContent: '', precedingCalls: [], call: { id: 'x', name: 'run_shell', args: { command: 'ls' } } }),
    }]
    renderDetail()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByText('run_shell')).toBeInTheDocument()
    expect(within(headerRow()).getByText('Needs approval')).toBeInTheDocument()
  })

  it('shows a skeleton, not an error, while the routine is still loading', () => {
    queryState.isLoading = true
    const { container } = renderDetail()
    expect(screen.queryByText('Could not load this routine.')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.tllm-pulse').length).toBeGreaterThan(0)
  })

  it('shows a retryable inline error when the routine cannot be read', async () => {
    const user = userEvent.setup()
    queryState.isError = true
    renderDetail()
    expect(screen.getByText('Could not load this routine.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(routineRefetch).toHaveBeenCalled()
  })
})

describe('RoutineEditPage — delete', () => {
  it('requires the AlertDialog confirmation before removing the routine', async () => {
    const user = userEvent.setup()
    removeMutate.mockImplementation((_id, opts) => opts.onSuccess({ ok: true }))
    routineData = activeRoutine()
    renderDetail()

    await user.click(screen.getByRole('button', { name: /Delete/ }))
    expect(removeMutate).not.toHaveBeenCalled() // dialog open, nothing deleted yet
    expect(screen.getByText('Delete this routine?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete routine' }))
    expect(removeMutate).toHaveBeenCalledWith('r1', expect.anything())
    expect(toastSuccess).toHaveBeenCalledWith('Routine deleted.')
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/code/routines')
  })

  it('Cancel closes the dialog without deleting anything', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: /Delete/ }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(removeMutate).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete this routine?')).not.toBeInTheDocument()
  })

  it('passes NO per-call onError — the failure toast is owned by the mutation definition', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: /Delete/ }))
    await user.click(screen.getByRole('button', { name: 'Delete routine' }))
    // routine-queries.ts's `remove` toasts at the mutation level precisely so a failed DELETE is
    // still surfaced after this page navigates away. TanStack Query runs BOTH callback levels, so
    // a per-call onError here would double-toast the same failure.
    const opts = removeMutate.mock.calls[0][1] as Record<string, unknown>
    expect(opts.onError).toBeUndefined()
  })
})

// ── The defect class two prior components in this feature each shipped once: a control wired to
//    a RECORDED copy of state instead of the ACTUAL CURRENT one. ─────────────────────────────
describe('RoutineEditPage — every control reads the live routine, never a captured copy', () => {
  it('swaps Pause for Resume when the live query reports the routine was paused elsewhere', () => {
    routineData = activeRoutine()
    const { rerender } = renderDetail()
    expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument()

    // Another tab paused it; the detail query's poll lands. No remount, no navigation — if the
    // page had captured the routine in useState (the exact bug two sibling components shipped),
    // this would still be offering Pause, and clicking it would 409.
    routineData = activeRoutine({ status: 'paused', nextFireAt: null })
    rerender(detailTree())
    expect(screen.queryByRole('button', { name: /Pause/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument()
  })

  it('a failed pause toasts and refetches, so a view that fell behind corrects itself', async () => {
    const user = userEvent.setup()
    pauseMutate.mockImplementation((_id, opts) => opts.onError(new ApiError('not_active', 'Routine is not active.', 409)))
    routineData = activeRoutine()
    renderDetail()
    await user.click(screen.getByRole('button', { name: /Pause/ }))
    expect(toastError).toHaveBeenCalledWith('Routine is not active.')
    expect(routineRefetch).toHaveBeenCalled()
  })

  it('the delete dialog describes the routine as it is NOW, including a run that starts while it is open', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    runsData = [{ id: 'run1', routineId: 'r1', status: 'ok', configSnapshot: '{}', startedAt: '2026-08-01T09:00:00.000Z' }]
    const { rerender } = render(detailTree())
    // Open the dialog against a quiet routine.
    await user.click(screen.getByRole('button', { name: /Delete/ }))
    expect(screen.getByText('Delete this routine?')).toBeInTheDocument()
    expect(screen.queryByText(/A run is in progress right now/)).not.toBeInTheDocument()

    // A scheduled fire starts while the dialog sits open. The confirm button is about to discard
    // it, so the dialog has to say so — which it can only do by reading the live run list rather
    // than a snapshot taken when the dialog opened.
    runsData = [{ id: 'run2', routineId: 'r1', status: 'running', configSnapshot: '{}', startedAt: '2026-08-02T09:00:00.000Z' }, ...runsData]
    rerender(detailTree())
    expect(screen.getByText(/A run is in progress right now/)).toBeInTheDocument()
  })

  it('deletes the routine currently on screen, even after the live query swapped in a different one', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    const { rerender } = renderDetail()
    await user.click(screen.getByRole('button', { name: /Delete/ }))

    // The routed id changed under the page (a redirect, a browser Back into a different routine)
    // while the dialog was open. The DELETE must follow the routine the dialog is describing —
    // which it does because both the description and the click handler read routineQ.data.
    routineData = activeRoutine({ id: 'r2', prompt: 'Nightly backup' })
    rerender(detailTree('r2'))
    await user.click(screen.getByRole('button', { name: 'Delete routine' }))
    expect(removeMutate).toHaveBeenCalledWith('r2', expect.anything())
  })

  it('diffs a proposed edit against the LIVE routine, not against the routine as it was when Edit was clicked', async () => {
    const user = userEvent.setup()
    routineData = activeRoutine()
    const { rerender } = renderDetail()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const promptBox = screen.getByPlaceholderText(/What should this routine do/)
    await user.clear(promptBox)
    await user.type(promptBox, 'New prompt')
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByText('− Summarize my inbox')).toBeInTheDocument()

    // Someone else edited the model in the meantime. The gate must show what THIS change does to
    // the routine as it stands now, not to the version this page happened to load first.
    routineData = activeRoutine({ modelKey: 'model-b' })
    rerender(detailTree())
    expect(screen.getByText('− model-b')).toBeInTheDocument()
    expect(screen.getByText('+ model-a')).toBeInTheDocument()
  })
})
