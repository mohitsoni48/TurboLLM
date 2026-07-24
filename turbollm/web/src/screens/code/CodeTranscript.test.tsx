import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CodeTranscript, TodoChecklist } from './CodeTranscript'
import { toggleDisplayPref } from '../../lib/code-display-prefs'
import type { Message } from '../../lib/chat-types'
import type { QueuedTurn, SteerKind } from '../../lib/code-types'

function userMessage(content: string, id: string): Message {
  return {
    id, convId: 'c1', seq: 0, role: 'user', content, reasoning: '',
    attachments: [], textAttachments: [], toolCalls: [], stats: {}, createdAt: '2026-07-24T00:00:00Z',
    variantGroup: null, isActive: true, edited: false,
  }
}

function queuedTurn(task: string, userMsgId: string, kind: SteerKind): QueuedTurn {
  return { task, userMsgId, kind }
}

describe('CodeTranscript — inline queued cards', () => {
  it('renders no queued card (and no "Send now") when the queue is empty', () => {
    render(<CodeTranscript messages={[]} queued={[]} onSendNowQueued={() => {}} />)
    expect(screen.queryByText('Send now')).not.toBeInTheDocument()
    expect(screen.queryByText('Runs next')).not.toBeInTheDocument()
    expect(screen.queryByText('Steers this turn')).not.toBeInTheDocument()
  })

  it('renders a follow-up queued card with its task text and a "Runs next" badge', () => {
    render(<CodeTranscript messages={[]} queued={[queuedTurn('do the thing', 'q1', 'followUp')]} onSendNowQueued={() => {}} />)
    expect(screen.getByText('do the thing')).toBeInTheDocument()
    expect(screen.getByText('Runs next')).toBeInTheDocument()
    expect(screen.queryByText('Steers this turn')).not.toBeInTheDocument()
  })

  it('renders a steer queued card with a "Steers this turn" badge', () => {
    render(<CodeTranscript messages={[]} queued={[queuedTurn('go left instead', 'q1', 'steer')]} onSendNowQueued={() => {}} />)
    expect(screen.getByText('go left instead')).toBeInTheDocument()
    expect(screen.getByText('Steers this turn')).toBeInTheDocument()
    expect(screen.queryByText('Runs next')).not.toBeInTheDocument()
  })

  it('renders three queued cards in send order', () => {
    const queued = [
      queuedTurn('first', 'q1', 'followUp'),
      queuedTurn('second', 'q2', 'followUp'),
      queuedTurn('third', 'q3', 'followUp'),
    ]
    render(<CodeTranscript messages={[]} queued={queued} onSendNowQueued={() => {}} />)
    const first = screen.getByText('first')
    const second = screen.getByText('second')
    const third = screen.getByText('third')
    // eslint-disable-next-line no-bitwise
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // eslint-disable-next-line no-bitwise
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('distinguishes a steer from a follow-up when both are queued together', () => {
    const queued = [
      queuedTurn('redirect now', 'q1', 'steer'),
      queuedTurn('and then this', 'q2', 'followUp'),
    ]
    render(<CodeTranscript messages={[]} queued={queued} onSendNowQueued={() => {}} />)
    expect(screen.getByText('Steers this turn')).toBeInTheDocument()
    expect(screen.getByText('Runs next')).toBeInTheDocument()
  })

  it('fires onSendNowQueued with the entry\'s userMsgId when "Send now" is clicked', () => {
    const onSendNow = vi.fn()
    render(<CodeTranscript messages={[]} queued={[queuedTurn('promote me', 'q42', 'followUp')]} onSendNowQueued={onSendNow} />)
    fireEvent.click(screen.getByText('Send now'))
    expect(onSendNow).toHaveBeenCalledWith('q42')
  })

  it('omits the "Send now" affordance when no handler is given (card still renders)', () => {
    render(<CodeTranscript messages={[]} queued={[queuedTurn('waiting', 'q1', 'followUp')]} />)
    expect(screen.getByText('waiting')).toBeInTheDocument()
    expect(screen.queryByText('Send now')).not.toBeInTheDocument()
  })

  it('renders queued cards at the tail — after existing transcript messages (ADR-199 ordering)', () => {
    render(
      <CodeTranscript
        messages={[userMessage('PAST TASK', 'm1')]}
        queued={[queuedTurn('FUTURE TASK', 'q1', 'followUp')]}
        onSendNowQueued={() => {}}
      />,
    )
    const past = screen.getByText('PAST TASK')
    const future = screen.getByText('FUTURE TASK')
    // The queued card must come AFTER the already-rendered transcript message, never above it.
    // eslint-disable-next-line no-bitwise
    expect(past.compareDocumentPosition(future) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('defaults an untagged queued entry (older cached shape) to the follow-up treatment', () => {
    // Backend always tags `kind`, but a queue entry cached before that field existed would arrive
    // without it — the card must still render (as a follow-up) rather than crash.
    const untagged = { task: 'legacy', userMsgId: 'q1' } as unknown as QueuedTurn
    render(<CodeTranscript messages={[]} queued={[untagged]} onSendNowQueued={() => {}} />)
    expect(screen.getByText('legacy')).toBeInTheDocument()
    expect(screen.getByText('Runs next')).toBeInTheDocument()
  })

  // test plan §3 basic requirement: queued renders "NOT above the still-streaming live turn" —
  // the existing tail-ordering test above only checks ordering against PAST (persisted) messages;
  // this checks it against an actually-live entry, the real ADR-199 scenario.
  it('renders a queued card AFTER the still-streaming live turn, never above it (live + queued together)', () => {
    render(
      <CodeTranscript
        messages={[]}
        live={{ timeline: [{ kind: 'text', text: 'LIVE TURN CONTENT' }], reasoning: '' }}
        queued={[queuedTurn('QUEUED FOLLOW-UP', 'q1', 'followUp')]}
        onSendNowQueued={() => {}}
      />,
    )
    const liveContent = screen.getByText('LIVE TURN CONTENT')
    const queuedContent = screen.getByText('QUEUED FOLLOW-UP')
    // eslint-disable-next-line no-bitwise
    expect(liveContent.compareDocumentPosition(queuedContent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // test plan §3 basic requirement: "A queued item transitions translucent → full opacity the
  // instant it actually starts running." At this presentational component's level that's: the
  // item leaves `queued` and the SAME content now renders as the live entry — no orphaned
  // translucent card left behind, no double-render of the same task.
  it('a queued item promoted to live disappears from the queue — no orphaned card, no double-render', () => {
    const { rerender } = render(
      <CodeTranscript messages={[]} queued={[queuedTurn('run the fix', 'q1', 'followUp')]} onSendNowQueued={() => {}} />,
    )
    expect(screen.getByText('run the fix')).toBeInTheDocument()
    expect(screen.getByText('Runs next')).toBeInTheDocument()

    // The queue drains server-side the instant this turn goes live — same task, now live instead.
    rerender(
      <CodeTranscript
        messages={[]}
        queued={[]}
        live={{ timeline: [{ kind: 'text', text: 'run the fix' }], reasoning: '' }}
        onSendNowQueued={() => {}}
      />,
    )
    expect(screen.queryByText('Runs next')).not.toBeInTheDocument()
    expect(screen.getAllByText('run the fix')).toHaveLength(1)
  })

  // test plan §3 edge case: "Stop while a message is queued — the translucent card must not
  // orphan in the transcript once the queue is cleared server-side." Distinct from the promotion
  // case above: here nothing takes its place (stopped, not run).
  it('clearing the queue (e.g. Stop) removes the translucent card entirely — nothing orphaned', () => {
    const { rerender } = render(
      <CodeTranscript messages={[]} queued={[queuedTurn('cancel me', 'q1', 'followUp')]} onSendNowQueued={() => {}} />,
    )
    expect(screen.getByText('cancel me')).toBeInTheDocument()
    rerender(<CodeTranscript messages={[]} queued={[]} onSendNowQueued={() => {}} />)
    expect(screen.queryByText('cancel me')).not.toBeInTheDocument()
  })

  // test plan §3 edge case: unicode/emoji/RTL text isn't subject to the app's "no emoji in UI
  // chrome" rule (that's chrome, not user content) — just needs to render faithfully.
  it('renders unicode/emoji/RTL content in a queued card without mangling it', () => {
    const text = '修复错误 🐛 שלום עולם — fix the الخطأ'
    render(<CodeTranscript messages={[]} queued={[queuedTurn(text, 'q1', 'followUp')]} onSendNowQueued={() => {}} />)
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  // test plan §3 edge case: a long multi-paragraph queued message wraps/renders in full, the same
  // as a normal CodeInstructionEntry — not truncated. compareDocumentPosition-style getByText on
  // the full string is brittle across a multi-paragraph blob (whitespace-pre-wrap can produce
  // several DOM nodes/ancestors that all "contain" the same textContent), so this checks the
  // first and last paragraph both survived instead of asserting on the raw concatenated string.
  it('renders a long multi-paragraph queued message in full, not truncated', () => {
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} with enough text to wrap across multiple lines in a narrow card.`).join('\n\n')
    const { container } = render(<CodeTranscript messages={[]} queued={[queuedTurn(long, 'q1', 'followUp')]} onSendNowQueued={() => {}} />)
    expect(container.textContent).toContain('Paragraph 1 with enough text')
    expect(container.textContent).toContain('Paragraph 6 with enough text')
  })
})

describe('CodeTranscript — Phase 2 live rendering', () => {
  it('shows a "Retrying…" banner with attempt count and reason from retry state', () => {
    render(
      <CodeTranscript
        messages={[]}
        live={{ timeline: [], reasoning: '', retry: { attempt: 2, maxAttempts: 5, message: 'rate limited' } }}
      />,
    )
    expect(screen.getByText('Retrying… attempt 2 of 5 — rate limited')).toBeInTheDocument()
  })

  it('renders a round divider for a turn block in the live timeline, as a plain line with no "Round N" text', () => {
    // No text label (founder feedback, 2026-07-24) — the divider is a bare rule now, so this
    // guards the actual regression: the label must never come back.
    const { container } = render(
      <CodeTranscript
        messages={[]}
        live={{ timeline: [{ kind: 'turn', index: 1 }], reasoning: '' }}
      />,
    )
    expect(screen.queryByText(/Round \d/)).not.toBeInTheDocument()
    expect(container.querySelector('span[aria-hidden].block.h-px')).toBeInTheDocument()
  })

  it('streams a running tool call\'s live partial output into its card', () => {
    render(
      <CodeTranscript
        messages={[]}
        live={{
          timeline: [{ kind: 'tool', call: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'pending', partial: 'streaming output here' } }],
          reasoning: '',
        }}
      />,
    )
    // The live snapshot shows in the card before any terminal result exists.
    expect(screen.getByText('streaming output here')).toBeInTheDocument()
  })

  it('supersedes the live partial with the terminal result across the pending→done transition', () => {
    const { rerender } = render(
      <CodeTranscript
        messages={[]}
        live={{
          timeline: [{ kind: 'tool', call: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'pending', partial: 'stale partial' } }],
          reasoning: '',
        }}
      />,
    )
    // While running, the card auto-opens and shows the streaming partial.
    expect(screen.getByText('stale partial')).toBeInTheDocument()
    // The same tool call finishes (same id → same card instance, so it stays open): the terminal
    // result takes over and the now-stale partial is gone.
    rerender(
      <CodeTranscript
        messages={[]}
        live={{
          timeline: [{ kind: 'tool', call: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'done', result: 'final result', partial: 'stale partial' } }],
          reasoning: '',
        }}
      />,
    )
    expect(screen.getByText('final result')).toBeInTheDocument()
    expect(screen.queryByText('stale partial')).not.toBeInTheDocument()
  })

  it('shows the Retrying banner and NOT the Compacting one when a retry and compaction overlap', () => {
    // The transcript has one shared status-banner slot; retry is the more salient transient state
    // and must take priority so the two are never confused (test plan: "distinct, not confused").
    render(
      <CodeTranscript
        messages={[]}
        live={{ timeline: [], reasoning: '', compacting: true, retry: { attempt: 1, maxAttempts: 3, message: 'blip' } }}
      />,
    )
    expect(screen.getByText(/Retrying…/)).toBeInTheDocument()
    expect(screen.queryByText('Compacting conversation…')).not.toBeInTheDocument()
  })

  it('shows the Compacting banner (distinct copy) when compacting with no retry in flight', () => {
    render(<CodeTranscript messages={[]} live={{ timeline: [], reasoning: '', compacting: true }} />)
    expect(screen.getByText('Compacting conversation…')).toBeInTheDocument()
    expect(screen.queryByText(/Retrying…/)).not.toBeInTheDocument()
  })

  it('never shows a "Round N" label at any round index, however high', () => {
    render(<CodeTranscript messages={[]} live={{ timeline: [{ kind: 'turn', index: 3 }], reasoning: '' }} />)
    expect(screen.queryByText(/Round \d/)).not.toBeInTheDocument()
  })
})

describe('TodoChecklist (ADR-255) — pinned above the composer by CodeSessionScreen.tsx, not rendered inline in the transcript', () => {
  // Moved out of CodeTranscript entirely (founder feedback, 2026-07-24: a plan rendered inline
  // scrolled out of view the moment there was enough content to push it off-screen) — tested here
  // as the standalone exported component CodeSessionScreen.tsx now renders directly.
  it('renders nothing when todos is empty', () => {
    const { container } = render(<TodoChecklist todos={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a populated checklist with mixed statuses and a done/total count', () => {
    render(
      <TodoChecklist
        todos={[
          { content: 'Read the failing test', status: 'completed' },
          { content: 'Fix the off-by-one bug', status: 'in_progress' },
          { content: 'Re-run the suite', status: 'pending' },
        ]}
      />,
    )
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.getByText('Read the failing test')).toBeInTheDocument()
    expect(screen.getByText('Fix the off-by-one bug')).toBeInTheDocument()
    expect(screen.getByText('Re-run the suite')).toBeInTheDocument()
  })
})

describe('CodeTranscript — /details + /thinking global display toggles (ADR-258)', () => {
  // These toggles persist in localStorage; reset so a flipped pref never leaks across tests.
  afterEach(() => { localStorage.clear() })

  it('/details force-expands a collapsed tool card (and collapses again when toggled off)', () => {
    render(
      <CodeTranscript
        messages={[]}
        live={{
          timeline: [{ kind: 'tool', call: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'done', result: 'collapsed output' } }],
          reasoning: '',
        }}
      />,
    )
    // A finished non-diff tool card starts collapsed — its output is hidden.
    expect(screen.queryByText('collapsed output')).not.toBeInTheDocument()
    act(() => { toggleDisplayPref('details') })
    expect(screen.getByText('collapsed output')).toBeInTheDocument()
    act(() => { toggleDisplayPref('details') })
    expect(screen.queryByText('collapsed output')).not.toBeInTheDocument()
  })

  it('/thinking force-opens a collapsed reasoning block', () => {
    render(<CodeTranscript messages={[]} live={{ timeline: [], reasoning: 'my private reasoning' }} />)
    // Reasoning is collapsed by default — the label shows, the content does not.
    expect(screen.queryByText('my private reasoning')).not.toBeInTheDocument()
    act(() => { toggleDisplayPref('thinking') })
    expect(screen.getByText('my private reasoning')).toBeInTheDocument()
  })

  it('the two toggles are independent (/details does not open reasoning)', () => {
    render(
      <CodeTranscript
        messages={[]}
        live={{
          timeline: [{ kind: 'tool', call: { id: 't1', name: 'bash', args: {}, status: 'done', result: 'the output' } }],
          reasoning: 'the reasoning',
        }}
      />,
    )
    act(() => { toggleDisplayPref('details') })
    expect(screen.getByText('the output')).toBeInTheDocument()
    expect(screen.queryByText('the reasoning')).not.toBeInTheDocument()
  })
})

describe('CodeTranscript — !command / !!command shell escape (ADR-258)', () => {
  it('renders a persisted ! shell result as a "$ command" terminal entry (not a chat bubble)', () => {
    const msg: Message = {
      ...userMessage('I ran a shell command in the repo:\n\n$ npm test\n\nall tests passed', 'm1'),
      toolCalls: [{ id: 'shell-1', name: 'shell', args: { command: 'npm test', exitCode: 0, timedOut: false }, result: 'all tests passed' }],
    }
    render(<CodeTranscript messages={[msg]} />)
    expect(screen.getByText('$ npm test')).toBeInTheDocument()
    expect(screen.getByText('all tests passed')).toBeInTheDocument()
    // The framed model-context content is NOT surfaced as an instruction bubble.
    expect(screen.queryByText(/I ran a shell command in the repo/)).not.toBeInTheDocument()
  })

  it('surfaces a non-zero exit code on a failed persisted shell command', () => {
    const msg: Message = {
      ...userMessage('x', 'm1'),
      toolCalls: [{ id: 's', name: 'shell', args: { command: 'false', exitCode: 1, timedOut: false }, result: '' }],
    }
    render(<CodeTranscript messages={[msg]} />)
    expect(screen.getByText('exit 1')).toBeInTheDocument()
  })

  it('renders ephemeral !! shell runs at the transcript tail', () => {
    render(<CodeTranscript messages={[]} shellRuns={[{ id: 'sh1', command: 'ls -la', output: 'file.txt', exitCode: 0, timedOut: false }]} />)
    expect(screen.getByText('$ ls -la')).toBeInTheDocument()
    expect(screen.getByText('file.txt')).toBeInTheDocument()
  })

  it('marks a timed-out shell run', () => {
    render(<CodeTranscript messages={[]} shellRuns={[{ id: 'sh1', command: 'sleep 99', output: '', exitCode: null, timedOut: true }]} />)
    expect(screen.getByText('timed out')).toBeInTheDocument()
  })
})
