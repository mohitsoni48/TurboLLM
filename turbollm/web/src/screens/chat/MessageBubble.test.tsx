// Scoped to MessageBubble's new routine-confirm rendering path only — its existing behavior
// (markdown, thinking blocks, sources, variant switcher) is unchanged and untested here.
//
// These cases deliberately do NOT match the plan's own Step 2 test list. The plan constructed a
// `routineConfirm: RoutineConfirmPayload` field by hand and asserted the card rendered from it —
// tests that pass while the feature is dead in production, because the shipped backend
// (turbollm/src/routines/routine-tools.ts) never populates such a field and has no way to. Every
// fixture below instead uses the EXACT strings those executors really return, so a regression in
// the parsing/derivation this feature actually depends on fails here.
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message, ToolCallRecord } from '../../lib/chat-types'
import type { Routine } from '../../lib/routine-types'

// RoutineFormFields (reached through RoutineConfirmCard) pulls the agent/model lists; the confirm
// card only mounts it behind "Edit inline", but the import chain is evaluated regardless.
vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return { ...actual, useChatAgents: () => ({ data: [] }), useModels: () => ({ data: { models: [] } }) }
})

// The REAL useRoutine hook runs — only the HTTP call underneath it is stubbed. That keeps the
// loading/success/error branches of the wrapper genuinely exercised instead of asserted against a
// hand-mocked hook return.
const getRoutineMock = vi.fn<(id: string) => Promise<Routine>>()
vi.mock('../../lib/routine-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routine-api')>()
  return { ...actual, getRoutine: (id: string) => getRoutineMock(id) }
})

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', flavor: 'chat', status: 'pending_confirmation', prompt: 'Summarize my inbox',
    scheduleDisplay: 'Runs daily at 9:00 AM', scheduleRule: { kind: 'daily', hour: 9, minute: 0 },
    nextFireAt: null, modelKey: 'model-a', agentId: 'agent-1', createdAt: '', updatedAt: '', ...overrides,
  }
}

function assistantMessage(toolCalls: ToolCallRecord[]): Message {
  return {
    id: 'm1', convId: 'c1', seq: 1, role: 'assistant', content: 'Done.', reasoning: '',
    attachments: [], textAttachments: [], toolCalls, stats: {}, createdAt: '',
    variantGroup: null, isActive: true, edited: false,
  }
}

function renderBubble(toolCalls: ToolCallRecord[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MessageBubble message={assistantMessage(toolCalls)} isLast={false} editingId={null} onEditSave={() => {}} onEditCancel={() => {}} />
    </QueryClientProvider>,
  )
}

/** What `friendlyName()` renders for these tool names in the generic card header — the marker that
 *  the confirm gate did NOT take over. */
const GENERIC = {
  create: 'create routine',
  update: 'update routine',
  remove: 'delete routine',
}

beforeEach(() => {
  getRoutineMock.mockReset()
  getRoutineMock.mockResolvedValue(routine())
})

describe('MessageBubble — create_routine confirm gate', () => {
  // execCreateRoutine's real success string. The routine id exists NOWHERE else.
  const createdResult =
    'Created routine "r1" (Runs daily at 9:00 AM) in status "pending_confirmation". ' +
    'It will NOT run until a human confirms it in the Routines panel — tell the user to review and confirm it.'

  it('renders the confirm card once the routine fetch resolves, and drops the generic card', async () => {
    renderBubble([{ id: 'tc1', name: 'create_routine', args: { flavor: 'chat' }, result: createdResult }])
    expect(await screen.findByText('Confirm this new routine')).toBeInTheDocument()
    expect(screen.getByText(/Summarize my inbox/)).toBeInTheDocument()
    expect(screen.queryByText(GENERIC.create)).not.toBeInTheDocument()
    expect(getRoutineMock).toHaveBeenCalledWith('r1')
  })

  it('shows a loading placeholder, not a confirm gate, while the routine is still being fetched', () => {
    getRoutineMock.mockReturnValue(new Promise<Routine>(() => {})) // never settles
    renderBubble([{ id: 'tc1', name: 'create_routine', args: {}, result: createdResult }])
    expect(screen.getByText('Loading routine…')).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
  })

  // The gate must never appear for a create the backend REFUSED — no row was written, so there is
  // nothing to confirm. execCreateRoutine returns this for the code-flavor gate and for every
  // validateCreate failure.
  it('falls back to the generic card for an Error: result (creation rejected)', async () => {
    renderBubble([{
      id: 'tc1', name: 'create_routine', args: { flavor: 'code' },
      result: 'Error: A valid API key is required to schedule a Code routine from a non-host device.',
    }])
    expect(await screen.findByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  it('falls back to the generic card while the call is still pending (no result yet)', () => {
    // A live/streaming call: LiveToolCall status 'pending', result undefined. MessageBubble's own
    // completed mapping can also produce a resultless record for an interrupted turn.
    renderBubble([{ id: 'tc1', name: 'create_routine', args: {} }])
    expect(screen.getByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading routine…')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  // Genuinely reachable: the user discards the pending routine from the Routines panel, then
  // scrolls back to this turn in the transcript.
  it('falls back to the generic card when the routine no longer exists', async () => {
    getRoutineMock.mockRejectedValue(new Error('not_found'))
    renderBubble([{ id: 'tc1', name: 'create_routine', args: {}, result: createdResult }])
    expect(await screen.findByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
  })

  it('falls back to the generic card when the tool call errored outright', () => {
    renderBubble([{ id: 'tc1', name: 'create_routine', args: {}, error: 'tool loop aborted' }])
    expect(screen.getByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
  })
})

describe('MessageBubble — update_routine confirm gate', () => {
  // execUpdateRoutine's real preview string. Note it is NOT parsed: the id comes from args, and
  // the diff from the stored routine + args.
  const previewResult = 'PREVIEW (not applied) — call again with confirm: true to apply:\n  prompt: "Summarize my inbox" -> "Summarize my inbox and Slack"'

  it('builds the update-mode diff from args.routineId plus the model\'s changed fields', async () => {
    getRoutineMock.mockResolvedValue(routine({ status: 'active', prompt: 'Summarize my inbox' }))
    renderBubble([{
      id: 'tc1', name: 'update_routine',
      args: { routineId: 'r1', prompt: 'Summarize my inbox and Slack' },
      result: previewResult,
    }])
    expect(await screen.findByText('Confirm this change')).toBeInTheDocument()
    expect(screen.getByText('− Summarize my inbox')).toBeInTheDocument()
    expect(screen.getByText('+ Summarize my inbox and Slack')).toBeInTheDocument()
    expect(screen.queryByText(GENERIC.update)).not.toBeInTheDocument()
    expect(getRoutineMock).toHaveBeenCalledWith('r1')
  })

  // Unnamed fields must keep their stored value — overlaying `undefined` would make the diff
  // advertise blanking them.
  it('leaves fields the tool call did not name untouched', async () => {
    getRoutineMock.mockResolvedValue(routine({ status: 'active' }))
    renderBubble([{
      id: 'tc1', name: 'update_routine',
      args: { routineId: 'r1', scheduleRule: { kind: 'daily', hour: 18, minute: 30 } },
      result: previewResult,
    }])
    expect(await screen.findByText('Confirm this change')).toBeInTheDocument()
    expect(screen.getByText('− Runs daily at 9:00 AM')).toBeInTheDocument()
    expect(screen.getByText('+ Runs daily at 6:30 PM')).toBeInTheDocument()
    // The prompt was not in `args`, so it is not part of the proposed change.
    expect(screen.queryByText('Prompt', { selector: 'span.font-medium' })).not.toBeInTheDocument()
  })

  it('falls back to the generic card when args.routineId is missing', async () => {
    renderBubble([{ id: 'tc1', name: 'update_routine', args: { prompt: 'New prompt' }, result: previewResult }])
    expect(await screen.findByText(GENERIC.update)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  // The gate is the PREVIEW phase's. Once the model has called back with confirm: true the write
  // already landed, so a "Confirm this change" card would invite a redundant PUT and its "Cancel"
  // would falsely imply nothing was persisted.
  it('falls back to the generic card for an ALREADY-APPLIED update', async () => {
    renderBubble([{
      id: 'tc1', name: 'update_routine',
      args: { routineId: 'r1', prompt: 'New prompt', confirm: true },
      result: 'Updated routine "r1".',
    }])
    expect(await screen.findByText(GENERIC.update)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  it('falls back to the generic card for an Error: result', async () => {
    renderBubble([{
      id: 'tc1', name: 'update_routine', args: { routineId: 'r9' },
      result: 'Error: no routine with id "r9".',
    }])
    expect(await screen.findByText(GENERIC.update)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
  })
})

describe('MessageBubble — the other routine tools stay generic', () => {
  // An explicit scope decision, not an omission: the Routines panel (Tasks 9/10) owns the delete
  // confirmation, and Task 8's scope names create/update only. See RoutineConfirmToolCard.tsx's
  // header. This test exists so removing that decision cannot happen silently.
  it('delete_routine renders the plain generic tool-call card, even at its preview phase', async () => {
    renderBubble([{
      id: 'tc1', name: 'delete_routine', args: { routineId: 'r1' },
      result: 'PREVIEW (not deleted) — routine "r1" ("Summarize my inbox") has 3 run(s) in its history. ' +
        'Deleting also removes that history permanently, with no undo. Call again with confirm: true to actually delete.',
    }])
    expect(await screen.findByText(GENERIC.remove)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  it('list_routines renders the plain generic tool-call card', () => {
    renderBubble([{ id: 'tc1', name: 'list_routines', args: {}, result: '- r1 [active] chat — "Runs daily at 9:00 AM" — Summarize my inbox' }])
    expect(screen.getByText('list routines')).toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })
})
