// Scoped to MessageBubble's new routine-confirm rendering path only — its existing behavior
// (markdown, thinking blocks, sources, variant switcher) is unchanged and untested here.
//
// These cases deliberately do NOT match the plan's own Step 2 test list. The plan constructed a
// `routineConfirm: RoutineConfirmPayload` field by hand and asserted the card rendered from it —
// tests that pass while the feature is dead in production, because the shipped backend
// (turbollm/src/routines/routine-tools.ts) never populates such a field and has no way to. Every
// fixture below instead uses the EXACT strings those executors really return, so a regression in
// the parsing/derivation this feature actually depends on fails here.
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble, StreamingBubble } from './MessageBubble'
import type { LiveToolCall, Message, ToolCallRecord } from '../../lib/chat-types'
import { routineKeys } from '../../lib/routine-queries'
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
  const utils = render(
    <QueryClientProvider client={qc}>
      <MessageBubble message={assistantMessage(toolCalls)} isLast={false} editingId={null} onEditSave={() => {}} onEditCancel={() => {}} />
    </QueryClientProvider>,
  )
  // The client is returned so a test can simulate the routine changing UNDER a still-mounted card
  // (the Routines panel's own confirm invalidates exactly this key — routine-queries.ts).
  return { qc, ...utils }
}

/** The STREAMING half of the same surface: StreamingBubble → InlineToolStep → the same wrapper.
 *  Needed because a live tool call can carry a `status` a persisted `ToolCallRecord` cannot —
 *  MessageBubble's own mapping collapses every record to 'done'/'error' and rewrites `result` to
 *  the error text, so an errored call PAIRED WITH a success-shaped result only exists here. */
function renderStreaming(calls: LiveToolCall[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <StreamingBubble
        timeline={calls.map((call) => ({ kind: 'tool' as const, call }))}
        reasoning=""
        progress={null}
        liveGenTps={0}
        genTokens={0}
      />
    </QueryClientProvider>,
  )
  return { qc, ...utils }
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

  // ── H1: the gate must read the ROUTINE's current status, not just the tool call ─────────────
  //
  // Create-mode Cancel is a hard DELETE (RoutineConfirmCard.tsx) and DELETE /api/v1/routines/:id
  // has no status guard, cascading to the run history. Offering it for a routine that is already
  // live turns "dismiss this proposal" into "destroy a running scheduled job". The tool result
  // says `pending_confirmation` forever; only the fetched routine knows the truth.
  it.each(['active', 'paused'] as const)(
    'never renders the create gate for a routine already in status %s (page reload / revisiting the turn)',
    async (status) => {
      getRoutineMock.mockResolvedValue(routine({ status }))
      renderBubble([{ id: 'tc1', name: 'create_routine', args: {}, result: createdResult }])
      expect(await screen.findByText(GENERIC.create)).toBeInTheDocument()
      expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
      // The destructive control specifically: no Cancel-as-delete anywhere on this card.
      expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument()
      // The gate did run — this is a status refusal, not an accidental no-fetch.
      expect(getRoutineMock).toHaveBeenCalledWith('r1')
    },
  )

  // H1 route 1: the user confirms from the STILL-STREAMING card, the turn ends, StreamingBubble
  // unmounts and MessageBubble mounts a FRESH card — RoutineConfirmCard's local `resolved` state
  // died with the old tree, so only the status check can stop the gate reappearing.
  it('does not re-offer the gate on the completed-message card after the streaming card confirmed it', async () => {
    const { unmount } = renderStreaming([
      { id: 'tc1', name: 'create_routine', args: {}, status: 'done', result: createdResult },
    ])
    expect(await screen.findByText('Confirm this new routine')).toBeInTheDocument()
    unmount() // turn finished: the streaming tree (and its `resolved` state) is gone

    getRoutineMock.mockResolvedValue(routine({ status: 'active' })) // …because Confirm landed
    renderBubble([{ id: 'tc1', name: 'create_routine', args: {}, result: createdResult }])
    expect(await screen.findByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument()
  })

  // H1 route 2: the user confirms the SAME routine from the Routines panel while this card is
  // still mounted and unresolved. That mutation invalidates `routineKeys.detail(id)` — the very
  // query this card reads — so the now-active routine flows straight back into it.
  it('drops the gate when the routine goes active underneath a still-mounted card', async () => {
    const { qc } = renderBubble([{ id: 'tc1', name: 'create_routine', args: {}, result: createdResult }])
    expect(await screen.findByText('Confirm this new routine')).toBeInTheDocument()

    getRoutineMock.mockResolvedValue(routine({ status: 'active' }))
    await act(async () => { await qc.invalidateQueries({ queryKey: routineKeys.detail('r1') }) })

    expect(await screen.findByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument()
  })

  // L1: the `^` anchor on CREATED_ROUTINE_RE is load-bearing — a result that merely CONTAINS the
  // phrase (a tool loop prefixing its own note, a list/echo of an earlier action) is not a create
  // this turn performed, and must not arm a delete button.
  it('does not trigger the gate when the created-routine phrase is not at the START of the result', async () => {
    renderBubble([{
      id: 'tc1', name: 'create_routine', args: {},
      result: `Earlier in this session: ${createdResult}`,
    }])
    expect(await screen.findByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  // L2: the tool-call STATUS guard, pinned on its own. The result string here is the real success
  // string and would match the regex outright, so this test fails if that guard is removed — the
  // other "failed call" cases are blocked by `!result` or by the regex instead. Only the streaming
  // surface can produce this pairing (see renderStreaming's comment).
  it('does not render the gate for a FAILED call whose result would otherwise match', () => {
    renderStreaming([{ id: 'tc1', name: 'create_routine', args: {}, status: 'error', result: createdResult }])
    expect(screen.getByText(GENERIC.create)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this new routine')).not.toBeInTheDocument()
    expect(screen.queryByText('Loading routine…')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
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

  // ── M1: a preview the model already applied is history, not an outstanding request ──────────
  //
  // The successful two-phase flow ALWAYS leaves both records in the transcript. Left ungated, the
  // earlier one keeps a live "Confirm this change" whose Cancel prints "Routine change cancelled."
  // after the write landed, and whose Confirm would re-apply the old proposal over newer values.
  it('renders the PREVIEW record as generic once a later confirm: true apply supersedes it', async () => {
    renderBubble([
      {
        id: 'tc1', name: 'update_routine',
        args: { routineId: 'r1', prompt: 'Summarize my inbox and Slack' },
        result: previewResult,
      },
      {
        id: 'tc2', name: 'update_routine',
        args: { routineId: 'r1', prompt: 'Summarize my inbox and Slack', confirm: true },
        result: 'Updated routine "r1".',
      },
    ])
    // Both records render as plain generic cards; neither is an actionable gate.
    expect(await screen.findAllByText(GENERIC.update)).toHaveLength(2)
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  // The suppression is per-routine, not a blanket "any later apply kills every preview".
  it('keeps the gate when the later apply targets a DIFFERENT routine', async () => {
    getRoutineMock.mockResolvedValue(routine({ status: 'active' }))
    renderBubble([
      {
        id: 'tc1', name: 'update_routine',
        args: { routineId: 'r1', prompt: 'Summarize my inbox and Slack' },
        result: previewResult,
      },
      {
        id: 'tc2', name: 'update_routine',
        args: { routineId: 'r2', prompt: 'Something else', confirm: true },
        result: 'Updated routine "r2".',
      },
    ])
    expect(await screen.findByText('Confirm this change')).toBeInTheDocument()
    expect(getRoutineMock).toHaveBeenCalledWith('r1')
  })

  // ── M2: scheduleDisplay is a real tool field the draft layer cannot carry ───────────────────
  //
  // Rendering a gate here would show "No fields changed." for a change that WAS proposed, and
  // Confirm would PUT the re-derived display instead of the model's. The generic card keeps the
  // raw PREVIEW — which contains the actual proposed string — readable.
  it('falls back to the generic card when scheduleDisplay is the ONLY field named', async () => {
    renderBubble([{
      id: 'tc1', name: 'update_routine',
      args: { routineId: 'r1', scheduleDisplay: 'Runs weekdays at 9' },
      result: 'PREVIEW (not applied) — call again with confirm: true to apply:\n' +
        '  scheduleDisplay: "Runs daily at 9:00 AM" -> "Runs weekdays at 9"',
    }])
    expect(await screen.findByText(GENERIC.update)).toBeInTheDocument()
    expect(screen.queryByText('Confirm this change')).not.toBeInTheDocument()
    expect(screen.queryByText('No fields changed.')).not.toBeInTheDocument()
    expect(getRoutineMock).not.toHaveBeenCalled()
  })

  // Named ALONGSIDE a real change it is the pre-existing acceptable case: the other field's diff
  // is genuine, and the display shown is the one derived from the rule (what Confirm will PUT).
  it('still renders the gate when scheduleDisplay accompanies a real, representable change', async () => {
    getRoutineMock.mockResolvedValue(routine({ status: 'active' }))
    renderBubble([{
      id: 'tc1', name: 'update_routine',
      args: { routineId: 'r1', scheduleDisplay: 'Half six every day', scheduleRule: { kind: 'daily', hour: 18, minute: 30 } },
      result: 'PREVIEW (not applied) — call again with confirm: true to apply:\n' +
        '  scheduleDisplay: "Runs daily at 9:00 AM" -> "Half six every day"',
    }])
    expect(await screen.findByText('Confirm this change')).toBeInTheDocument()
    expect(screen.getByText('+ Runs daily at 6:30 PM')).toBeInTheDocument()
  })

  // L3: args come from a model, so every overlaid value is type-checked. A non-string `prompt`
  // must be dropped rather than reaching the card — the draft stays the stored value and the rest
  // of the proposal still renders.
  it('ignores a non-string value for an overlayable field and renders the rest correctly', async () => {
    getRoutineMock.mockResolvedValue(routine({ status: 'active' }))
    renderBubble([{
      id: 'tc1', name: 'update_routine',
      args: { routineId: 'r1', prompt: 42, scheduleRule: { kind: 'daily', hour: 18, minute: 30 } },
      result: previewResult,
    }])
    expect(await screen.findByText('Confirm this change')).toBeInTheDocument()
    expect(screen.getByText('+ Runs daily at 6:30 PM')).toBeInTheDocument()
    // The bogus value never reaches the card, and the stored prompt is kept intact.
    expect(screen.queryByText(/42/)).not.toBeInTheDocument()
    expect(screen.getByText(/Summarize my inbox/)).toBeInTheDocument()
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
