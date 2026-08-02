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
/** Per-test control over the in-flight flags. Hardcoding `isPending: false` (as this mock used to)
 *  made D9's whole pending-disable layer structurally unverifiable: `disabled={mut.update.isPending}`
 *  on the inline form, on "Cancel edit" and `disabled={mut.remove.isPending}` on Cancel could all be
 *  deleted without failing a test. Read at every `useRoutineMutations()` call, i.e. every render, so
 *  flipping a flag before an interaction that re-renders is enough. */
const pending = { confirm: false, remove: false, update: false }
vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return {
    ...actual,
    useRoutineMutations: () => ({
      confirm: { mutate: confirmMutate, isPending: pending.confirm },
      remove: { mutate: removeMutate, isPending: pending.remove },
      update: { mutate: updateMutate, isPending: pending.update },
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
  pending.confirm = false; pending.remove = false; pending.update = false
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

  // A failed Cancel-delete must still be surfaced (the pending row is still in the database), but
  // the toast deliberately does NOT live here any more: `cancel()` calls `props.onCancelled()`
  // synchronously, and a consumer that unmounts this card in response destroys the observer before
  // the DELETE settles — TanStack Query v5 skips per-`mutate` callbacks for an observer with no
  // listeners, so the failure would vanish exactly when it matters. The toast moved onto the
  // `remove` mutation definition, which fires independently of this component's lifetime; that is
  // proven in routine-queries.test.tsx (including the unmount-first case, which no test here can
  // reach while `useRoutineMutations` is mocked). What this test pins is the other half: the card
  // must not re-add its own handler, because Query runs both levels and it would double-toast.
  it('attaches no per-call onError to the discard DELETE — the toast belongs to the mutation', async () => {
    const user = userEvent.setup()
    renderCreate()
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(removeMutate).toHaveBeenCalledTimes(1)
    const opts = removeMutate.mock.calls[0][1] as { onError?: unknown; onSettled?: unknown }
    expect(opts.onError).toBeUndefined()
    expect(opts.onSettled).toBeTypeOf('function') // the re-entry guard still has to clear
    expect(toastError).not.toHaveBeenCalled()
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

// The card must never confirm a value it captured at mount. Every test below re-renders the SAME
// component instance with new props (no `key` change, so React reuses it) — the scenario a
// `useState` initialiser silently loses, and the one Task 8's transcript produces when it replaces
// a tool-call record in place. Each of these fails against a useState-captured id/draft.
describe('RoutineConfirmCard — props are the source of truth, not a mount-time snapshot', () => {
  function createTree(routine: Routine) {
    return (
      <RoutineConfirmCard mode="create" routine={routine} onConfirmed={vi.fn()} onCancelled={vi.fn()} />
    )
  }
  function updateTree(original: Routine, draft: RoutineDraft) {
    return (
      <RoutineConfirmCard mode="update" original={original} draft={draft} onConfirmed={vi.fn()} onCancelled={vi.fn()} />
    )
  }
  /** One QueryClient across the rerender — a fresh provider element would remount the subtree and
   *  hand the card the mount it must be proven not to need. */
  function renderRerenderable(ui: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const r = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
    return { ...r, swap: (next: React.ReactNode) => r.rerender(<QueryClientProvider client={qc}>{next}</QueryClientProvider>) }
  }

  // D1 regression guard. Restoring the plan's `const [routineId] = useState(...)` leaves the card
  // displaying r2 while confirming r1 — a show-X-write-Y divergence on the one gate whose entire
  // job is to make the write match the screen. Nothing in the suite pinned this before.
  it('D1: a new routine prop on a mounted create card retargets both the display and the write', async () => {
    const user = userEvent.setup()
    const { container, swap } = renderRerenderable(createTree(pendingChatRoutine({ id: 'r1', prompt: 'PROPOSAL-A' })))
    expect(container.textContent).toContain('PROPOSAL-A')

    swap(createTree(pendingChatRoutine({ id: 'r2', prompt: 'PROPOSAL-B' })))
    expect(container.textContent).toContain('PROPOSAL-B')
    expect(container.textContent).not.toContain('PROPOSAL-A')

    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(confirmMutate).toHaveBeenCalledWith('r2', expect.anything())
  })

  // The HIGH. `key={routine.id}` provably cannot cover this one: the routine id never changes,
  // only the proposed content does, so there is no remount to miss — the card simply has to read
  // the prop. Fails against `useState<RoutineDraft>(props.draft)`: the diff keeps showing
  // PROPOSAL-A and Confirm PUTs PROPOSAL-A.
  it('HIGH: a revised proposal for the SAME routine replaces both the diff and the PUT body', async () => {
    const user = userEvent.setup()
    const original = pendingChatRoutine({ prompt: 'Old prompt', status: 'active' })
    const { swap } = renderRerenderable(updateTree(original, chatDraft({ prompt: 'PROPOSAL-A' })))
    expect(screen.getByText('+ PROPOSAL-A')).toBeInTheDocument()

    swap(updateTree(original, chatDraft({ prompt: 'PROPOSAL-B' })))
    expect(screen.getByText('+ PROPOSAL-B')).toBeInTheDocument()
    expect(screen.queryByText('+ PROPOSAL-A')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'r1', patch: expect.objectContaining({ prompt: 'PROPOSAL-B' }) },
      expect.anything(),
    )
  })

  // The HIGH's LOW-severity twin: the completeness gate had the same mount-time capture, so it
  // reported on the previous routine. Same root cause, resolved by the same change.
  it('the completeness gate re-evaluates against the new prop, not the one seen at mount', () => {
    const { swap } = renderRerenderable(createTree(pendingChatRoutine({ id: 'r1' })))
    expect(screen.getByRole('button', { name: /^Confirm$/ })).not.toBeDisabled()
    swap(createTree(pendingChatRoutine({ id: 'r2', agentId: undefined })))
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeDisabled()
  })

  // The overlays are the deliberate exception, and the reason `key={routine.id}` is still advised.
  it('an inline edit survives a prop change (it is user intent, not a stale prop) and Cancel edit drops it', async () => {
    const user = userEvent.setup()
    const original = pendingChatRoutine({ prompt: 'Old prompt', status: 'active' })
    const { swap } = renderRerenderable(updateTree(original, chatDraft({ prompt: 'PROPOSAL-A' })))
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    await user.clear(screen.getByPlaceholderText(/What should this routine do/))
    await user.type(screen.getByPlaceholderText(/What should this routine do/), 'HAND-EDITED')
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(screen.getByText('+ HAND-EDITED')).toBeInTheDocument()

    // A new proposal arrives while the user's own edit is showing: the overlay wins (that is what
    // `key` is for), and clearing it falls straight back to the FRESH prop, not the mount-time one.
    swap(updateTree(original, chatDraft({ prompt: 'PROPOSAL-B' })))
    expect(screen.getByText('+ HAND-EDITED')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    await user.click(screen.getByRole('button', { name: /Cancel edit/ }))
    expect(screen.getByText('+ PROPOSAL-B')).toBeInTheDocument()
  })
})

describe('RoutineConfirmCard — the PUT body carries only what the server can apply', () => {
  // D2 regression guard. The suite's other assertion on this body is an `expect.objectContaining`,
  // which can prove a key is present but never that one is ABSENT — so reverting `draftToPatch` to
  // the plan's `{ ...draft, scheduleDisplay }` stayed green while reintroducing the hazard:
  // routine-routes.ts gates on `(routine.flavor === 'code' || b.flavor === 'code')`, so a `flavor`
  // in the body can 401 a caller who is otherwise allowed to make this exact edit.
  it('D2: `flavor` never appears in the patch', async () => {
    const user = userEvent.setup()
    renderUpdate(pendingChatRoutine({ status: 'active' }), chatDraft({ prompt: 'New prompt' }))
    await user.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(Object.keys(updateMutate.mock.calls[0][0].patch)).not.toContain('flavor')
  })

  // ...which is exactly why the inline editor must not offer the switch. Locked in BOTH modes:
  // create mode's "Save changes" is a PUT against the pending row and cannot change flavor either.
  it.each([
    ['update', () => renderUpdate(pendingChatRoutine({ status: 'active' }), chatDraft())],
    ['create', () => renderCreate()],
  ])('M4: the inline editor pins the flavor in %s mode, leaving every other field editable', async (_mode, mount) => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    expect(screen.getByRole('button', { name: 'Chat' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Code' })).toBeDisabled()
    expect(screen.getByPlaceholderText(/What should this routine do/)).not.toBeDisabled()
    expect(screen.getByLabelText('Model')).not.toBeDisabled()
  })
})

// D9. These were unverifiable while the mock hardcoded `isPending: false`.
describe('RoutineConfirmCard — controls are inert while a write is in flight', () => {
  it('the inline editor, Cancel edit and Save changes are all disabled during the save PUT', async () => {
    const user = userEvent.setup()
    renderCreate()
    pending.update = true
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    expect(screen.getByPlaceholderText(/What should this routine do/)).toBeDisabled()
    expect(screen.getByLabelText('Model')).toBeDisabled()
    expect(screen.getByRole('button', { name: /Cancel edit/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled()
  })

  it('...and all live again when nothing is in flight', async () => {
    const user = userEvent.setup()
    renderCreate()
    await user.click(screen.getByRole('button', { name: /Edit inline/ }))
    expect(screen.getByPlaceholderText(/What should this routine do/)).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Cancel edit/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Save changes/ })).not.toBeDisabled()
  })

  it('Cancel is disabled while the discard DELETE is in flight', () => {
    pending.remove = true
    renderCreate()
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeDisabled()
  })

  it('Confirm is disabled while a confirm write is in flight', () => {
    pending.confirm = true
    renderCreate()
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeDisabled()
  })

  it('Confirm is disabled while an update write is in flight', () => {
    pending.update = true
    renderUpdate(pendingChatRoutine({ status: 'active' }), chatDraft())
    expect(screen.getByRole('button', { name: /^Confirm$/ })).toBeDisabled()
  })
})
