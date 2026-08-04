import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutineApprovalCard } from './RoutineApprovalCard'
import { ApiError } from '../../lib/api'
import type { RoutineRun } from '../../lib/routine-types'

// Same precedent as RoutineConfirmCard.test.tsx: real sonner needs a mounted <Toaster/> to be
// observable, and the 401 assertion below is checking this feature's ONLY auth feedback
// (routine-api.ts's header comment names approve/deny among the eight endpoints that can 401).
const toastError = vi.fn()
vi.mock('../ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const approveMutate = vi.fn()
const denyMutate = vi.fn()
const pending = { approve: false, deny: false }
vi.mock('../../lib/routine-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-queries')>()
  return {
    ...actual,
    useRoutineMutations: () => ({
      approve: { mutate: approveMutate, isPending: pending.approve },
      deny: { mutate: denyMutate, isPending: pending.deny },
    }),
  }
})

/** The REAL persisted shape — `serializePendingToolCall(PendingRoutineToolCall)` from
 *  turbollm/src/routines/approval.ts, which is what `stallRoutineRun` writes to the
 *  `pending_tool_call` column. The plan's own fixture was a flat `{ name, args }`, a shape no
 *  backend path ever produces; a test built on it would have passed against a parser that reads
 *  nothing on real data. */
function pendingToolCallJson(name = 'run_shell', args: Record<string, unknown> = { command: 'rm -rf /tmp/x' }): string {
  return JSON.stringify({
    convId: 'conv-1',
    assistantContent: 'cleaning up',
    precedingCalls: [],
    call: { id: 'call-1', name, args },
  })
}

function run(overrides: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 'run1', routineId: 'r1', status: 'needs_approval', configSnapshot: '{}',
    startedAt: '2026-08-01T09:00:00.000Z', pendingToolCall: pendingToolCallJson(),
    ...overrides,
  }
}

function renderCard(r: RoutineRun = run(), routineId = 'r1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><RoutineApprovalCard routineId={routineId} run={r} /></QueryClientProvider>)
}

beforeEach(() => {
  approveMutate.mockReset(); denyMutate.mockReset(); toastError.mockReset()
  pending.approve = false; pending.deny = false
})

describe('RoutineApprovalCard', () => {
  it('shows the specific blocked tool call, not a generic message', () => {
    renderCard()
    expect(screen.getByText('run_shell')).toBeInTheDocument()
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeInTheDocument()
  })

  it('Approve calls the approve endpoint with the routine and run ids', async () => {
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(approveMutate).toHaveBeenCalledWith({ routineId: 'r1', runId: 'run1' }, expect.anything())
  })

  it('Deny calls the deny endpoint and the card stops offering a decision', async () => {
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(denyMutate).toHaveBeenCalledWith({ routineId: 'r1', runId: 'run1' }, expect.anything())
    expect(await screen.findByText(/Denied/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
  })

  it('handles an unparsable pendingToolCall without crashing, and without pretending to know what it is', () => {
    renderCard(run({ pendingToolCall: 'not json' }))
    expect(screen.getByText('This run needs your approval:')).toBeInTheDocument()
    expect(screen.getByText(/details could not be read/)).toBeInTheDocument()
    // Still actionable — the user can refuse a call the UI can't describe.
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('handles a missing pendingToolCall (a run stalled before the column was written)', () => {
    renderCard(run({ pendingToolCall: undefined }))
    expect(screen.getByText('an unreadable tool call')).toBeInTheDocument()
  })
})

// ── The defect class two prior components in this feature each shipped once: a gate that reads
//    the RECORDED state of something instead of its ACTUAL CURRENT state. ─────────────────────
describe('RoutineApprovalCard — reflects the run’s CURRENT status, not its own recollection', () => {
  it('offers no decision at all once the run is no longer needs_approval', () => {
    // The exact re-render this covers: pendingToolCall is persisted forever, so re-opening the
    // page (or a poll tick) after ANYONE — another tab, another device, the daemon — resolved the
    // run hands this component a fully-populated pending call on an already-finished run.
    renderCard(run({ status: 'ok', endedAt: '2026-08-01T09:05:00.000Z' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
    expect(screen.getByText(/No longer awaiting approval/)).toBeInTheDocument()
  })

  it('reports a denied-elsewhere run from the run itself, not from a local flag', () => {
    renderCard(run({ status: 'errored', error: 'Denied by user', endedAt: '2026-08-01T09:05:00.000Z' }))
    expect(screen.getByText(/Denied by user/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('a resolved status wins over this card’s own just-submitted decision', async () => {
    const user = userEvent.setup()
    const { rerender } = renderCard()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByText(/Approved — waiting/)).toBeInTheDocument()
    // The poll lands: the run actually errored out rather than completing. The card must report
    // what happened, not keep asserting its own optimistic "approved" note.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <RoutineApprovalCard routineId="r1" run={run({ status: 'errored', error: 'tool crashed' })} />
      </QueryClientProvider>,
    )
    expect(screen.queryByText(/Approved — waiting/)).not.toBeInTheDocument()
    expect(screen.getByText(/tool crashed/)).toBeInTheDocument()
  })

  it('a SECOND blocked call on the same run is actionable again, not swallowed by the first decision', async () => {
    const user = userEvent.setup()
    const { rerender } = renderCard()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()

    // Approving one call resumes the run, which can immediately re-park on the NEXT call
    // (chat-runner.ts / code-runner.ts both re-stall) — status stays 'needs_approval' and only
    // pendingToolCall changes. A card that latched on "I already decided" would leave this new
    // call permanently un-approvable.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <RoutineApprovalCard routineId="r1" run={run({ pendingToolCall: pendingToolCallJson('write_file', { path: '/etc/hosts' }) })} />
      </QueryClientProvider>,
    )
    expect(screen.getByText('write_file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('refuses to act on a run belonging to a different routine', () => {
    renderCard(run({ routineId: 'other-routine' }), 'r1')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.getByText(/belongs to a different routine/)).toBeInTheDocument()
  })
})

describe('RoutineApprovalCard — failure handling', () => {
  it('toasts a 401 as an authorization problem and restores the buttons so the user can retry', async () => {
    const user = userEvent.setup()
    approveMutate.mockImplementation((_v, opts) => opts.onError(new ApiError('unauthorized', 'A valid API key is required to schedule a Code routine from a non-host device.', 401)))
    renderCard()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(toastError).toHaveBeenCalledWith('Not authorized: A valid API key is required to schedule a Code routine from a non-host device.')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('toasts a 409 (already resolved elsewhere) with the server’s own message', async () => {
    const user = userEvent.setup()
    denyMutate.mockImplementation((_v, opts) => opts.onError(new ApiError('not_stalled', 'Run is not awaiting approval.', 409)))
    renderCard()
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(toastError).toHaveBeenCalledWith('Run is not awaiting approval.')
  })

  it('does not double-submit when both buttons are hit inside one tick', async () => {
    // isPending only flips after a React state update, so the disabled prop alone cannot stop
    // this — the synchronous ref guard is what does.
    renderCard()
    const approve = screen.getByRole('button', { name: 'Approve' })
    const deny = screen.getByRole('button', { name: 'Deny' })
    approve.click()
    deny.click()
    expect(approveMutate).toHaveBeenCalledTimes(1)
    expect(denyMutate).not.toHaveBeenCalled()
  })

  it('disables both buttons while a decision is in flight', () => {
    pending.approve = true
    renderCard()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  })
})
