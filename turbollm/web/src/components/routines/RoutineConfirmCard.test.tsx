import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutineConfirmCard } from './RoutineConfirmCard'
import { ApiError } from '../../lib/api'
import type { Routine } from '../../lib/routine-types'
import type { RoutineDraft } from '../../lib/routine-form'

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return { ...actual, useChatAgents: () => ({ data: [] }), useModels: () => ({ data: { models: [] } }) }
})

// Same precedent as CodeComposer.test.tsx / CodeSessionScreen.test.tsx: real sonner needs a
// mounted <Toaster/> to be observable, and the 401 test below asserts a toast actually fired
// with the right wording — that toast is this surface's ONLY auth feedback (routine-api.ts).
const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('../ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), warning: vi.fn() },
}))

const confirmMutate = vi.fn()
const removeMutate = vi.fn()
const updateMutate = vi.fn()
vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return {
    ...actual,
    useRoutineMutations: () => ({
      confirm: { mutate: confirmMutate, isPending: false },
      remove: { mutate: removeMutate, isPending: false },
      update: { mutate: updateMutate, isPending: false },
    }),
  }
})

function pendingChatRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', flavor: 'chat', status: 'pending_confirmation', prompt: 'Summarize my inbox',
    scheduleDisplay: 'Runs daily at 9:00 AM', scheduleRule: { kind: 'daily', hour: 9, minute: 0 },
    nextFireAt: null, modelKey: 'model-a', agentId: 'agent-1', createdAt: '', updatedAt: '', ...overrides,
  }
}
function chatDraft(overrides: Partial<RoutineDraft> = {}): RoutineDraft {
  return { flavor: 'chat', prompt: 'New prompt', scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'model-a', agentId: 'agent-1', ...overrides }
}

function withQc(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function renderCreate(overrides: Partial<Routine> = {}, cbs: { onConfirmed?: (r: Routine) => void; onCancelled?: () => void } = {}) {
  return withQc(
    <RoutineConfirmCard mode="create" routine={pendingChatRoutine(overrides)} onConfirmed={cbs.onConfirmed ?? vi.fn()} onCancelled={cbs.onCancelled ?? vi.fn()} />,
  )
}

function renderUpdate(
  original: Routine,
  draft: RoutineDraft,
  cbs: { onConfirmed?: (r: Routine) => void; onCancelled?: () => void } = {},
) {
  return withQc(
    <RoutineConfirmCard mode="update" original={original} draft={draft} onConfirmed={cbs.onConfirmed ?? vi.fn()} onCancelled={cbs.onCancelled ?? vi.fn()} />,
  )
}

beforeEach(() => {
  confirmMutate.mockReset(); removeMutate.mockReset(); updateMutate.mockReset()
  toastError.mockReset(); toastSuccess.mockReset()
})

describe('RoutineConfirmCard — create mode', () => {
  it('Confirm is enabled for a complete draft and calls the /confirm endpoint', async () => {
    const user = userEvent.setup()
    renderCreate()
    const btn = screen.getByRole('button', { name: /Confirm/ })
    expect(btn).not.toBeDisabled()
    await user.click(btn)
    expect(confirmMutate).toHaveBeenCalledWith('r1', expect.anything())
  })

  it('Confirm is disabled when a flavor-required field is missing (spec 20 §3 / 21 §3)', () => {
    renderCreate({ agentId: undefined })
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled()
  })

  it('shows a confirmed success state once the mutation resolves', async () => {
    confirmMutate.mockImplementation((_id, opts) => opts.onSuccess(pendingChatRoutine({ status: 'active' })))
    const user = userEvent.setup()
    const onConfirmed = vi.fn()
    renderCreate({}, { onConfirmed })
    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(await screen.findByText(/Routine confirmed/)).toBeInTheDocument()
    expect(onConfirmed).toHaveBeenCalled()
  })

  it('Cancel discards the pending row via delete and calls onCancelled', async () => {
    const user = userEvent.setup()
    const onCancelled = vi.fn()
    renderCreate({}, { onCancelled })
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(removeMutate).toHaveBeenCalledWith('r1', expect.anything())
    expect(onCancelled).toHaveBeenCalled()
  })

  it('Edit inline reveals the form and hides the Confirm/Cancel row until it closes', async () => {
    const user = userEvent.setup()
    renderCreate()
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    expect(screen.getByText('Task prompt')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Confirm$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).not.toBeInTheDocument()
  })
})

describe('RoutineConfirmCard — update mode', () => {
  it('renders an old→new diff and defers the PUT until Confirm', async () => {
    const user = userEvent.setup()
    const original = pendingChatRoutine({ prompt: 'Old prompt', status: 'active' })
    renderUpdate(original, chatDraft({ prompt: 'New prompt' }))
    expect(screen.getByText('− Old prompt')).toBeInTheDocument()
    expect(screen.getByText('+ New prompt')).toBeInTheDocument()
    expect(updateMutate).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(updateMutate).toHaveBeenCalledWith({ id: 'r1', patch: expect.objectContaining({ prompt: 'New prompt' }) }, expect.anything())
  })

  it('Cancel on an update makes no API call at all — nothing was ever persisted', async () => {
    const user = userEvent.setup()
    const onCancelled = vi.fn()
    renderUpdate(pendingChatRoutine(), chatDraft(), { onCancelled })
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(updateMutate).not.toHaveBeenCalled()
    expect(removeMutate).not.toHaveBeenCalled()
    expect(confirmMutate).not.toHaveBeenCalled()
    expect(onCancelled).toHaveBeenCalled()
  })

  // The plan's FIELD_LABELS omitted agentId, so swapping which agent runs the routine rendered
  // "No fields changed." — the gate would have understated the very change being authorized.
  it('diffs a changed agent, not just the prompt', () => {
    renderUpdate(pendingChatRoutine({ status: 'active' }), chatDraft({ prompt: 'Summarize my inbox', agentId: 'agent-2' }))
    expect(screen.getByText('Agent', { selector: 'span.font-medium' })).toBeInTheDocument()
    expect(screen.getByText('− agent-1')).toBeInTheDocument()
    expect(screen.getByText('+ agent-2')).toBeInTheDocument()
  })

  it('Save changes inside an update-mode inline edit persists nothing — only Confirm writes', async () => {
    const user = userEvent.setup()
    renderUpdate(pendingChatRoutine({ status: 'active' }), chatDraft())
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(updateMutate).not.toHaveBeenCalled()
    expect(confirmMutate).not.toHaveBeenCalled()
    // ...and the gate is reachable again once the edit closes.
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeInTheDocument()
  })
})

describe('RoutineConfirmCard — failure handling', () => {
  // routine-api.ts's header comment: no auth-signal is wired, so a code-flavor 401 raises no
  // AuthGate. This toast is the only auth feedback the user will ever get on this surface.
  it('surfaces a 401 from confirm as an explicit authorization error toast', async () => {
    const gateMessage = 'A valid API key is required to schedule a Code routine from a non-host device.'
    confirmMutate.mockImplementation((_id, opts) => opts.onError(new ApiError('unauthorized', gateMessage, 401)))
    const user = userEvent.setup()
    renderCreate({ flavor: 'code', agentId: undefined, workspacePath: 'C:/repo', codingAgent: 'pi', permissionMode: 'ask' })
    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(toastError).toHaveBeenCalledWith(`Not authorized: ${gateMessage}`)
    // Not swallowed into a success state — the card stays on the gate.
    expect(screen.queryByText(/Routine confirmed/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeInTheDocument()
  })

  it('surfaces a 401 from an update-mode Confirm too', async () => {
    const gateMessage = 'A valid API key is required to schedule a Code routine from a non-host device.'
    updateMutate.mockImplementation((_v, opts) => opts.onError(new ApiError('unauthorized', gateMessage, 401)))
    const user = userEvent.setup()
    renderUpdate(pendingChatRoutine({ status: 'active' }), chatDraft())
    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(toastError).toHaveBeenCalledWith(`Not authorized: ${gateMessage}`)
    expect(screen.queryByText(/Routine updated/)).not.toBeInTheDocument()
  })

  it('a non-401 confirm failure keeps the card on the gate and shows the server message', async () => {
    confirmMutate.mockImplementation((_id, opts) => opts.onError(new ApiError('not_pending', 'This routine was already confirmed.', 409)))
    const user = userEvent.setup()
    const onConfirmed = vi.fn()
    renderCreate({}, { onConfirmed })
    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(toastError).toHaveBeenCalledWith('This routine was already confirmed.')
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(screen.queryByText(/Routine confirmed/)).not.toBeInTheDocument()
  })

  it('a failed Cancel-delete is surfaced, not silently swallowed — the pending row is still there', async () => {
    removeMutate.mockImplementation((_id, opts) => opts.onError(new ApiError('unauthorized', 'nope', 401)))
    const user = userEvent.setup()
    renderCreate()
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(toastError).toHaveBeenCalledWith('Not authorized: nope')
  })
})

describe('RoutineConfirmCard — the gate cannot be bypassed', () => {
  it('a double click fires exactly one confirm write', async () => {
    const user = userEvent.setup()
    renderCreate()
    await user.dblClick(screen.getByRole('button', { name: /Confirm/ }))
    expect(confirmMutate).toHaveBeenCalledTimes(1)
  })

  it('a double click fires exactly one delete on cancel', async () => {
    const user = userEvent.setup()
    renderCreate()
    await user.dblClick(screen.getByRole('button', { name: /Cancel/ }))
    expect(removeMutate).toHaveBeenCalledTimes(1)
  })

  // Not a user gesture — a raw dispatched event and a programmatic .click(), both of which skip
  // the pointer-event/pointer-events:none layers that make `disabled` merely *look* inert.
  it('an incomplete draft refuses a programmatically dispatched click on Confirm', () => {
    renderCreate({ agentId: undefined })
    const btn = screen.getByRole('button', { name: /Confirm/ })
    fireEvent.click(btn)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    ;(btn as HTMLButtonElement).click()
    expect(confirmMutate).not.toHaveBeenCalled()
  })

  // isRoutineDraftComplete gained schedule-rule range validation in a fix round; the gate must
  // honour the widened check, not just the original "required fields present" one.
  it('Confirm is disabled for a schedule rule the server would reject (everyMs <= 0)', () => {
    renderCreate({ scheduleRule: { kind: 'interval', everyMs: 0 } })
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(confirmMutate).not.toHaveBeenCalled()
  })

  it('Confirm is disabled for a weekly rule with no days selected', () => {
    renderCreate({ scheduleRule: { kind: 'weekly', daysOfWeek: [], hour: 9, minute: 0 } })
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled()
  })

  it('Confirm is disabled for an out-of-range hour', () => {
    renderCreate({ scheduleRule: { kind: 'daily', hour: 26, minute: 0 } })
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled()
  })
})
