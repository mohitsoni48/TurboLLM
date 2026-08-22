// GitHub #177 — an in-flight turn must not render as a red error.
//
// The daemon inserts the assistant row EMPTY (`stats: { aborted: false }`) before the first token
// exists. Any client that isn't the tab which started the stream — after a reload, in a second
// tab — has no local `live` state for it, so MessageBubble's empty-message branch painted
// "This message is empty." over a generation that was running perfectly well.
//
// The three cases that must NOT change are pinned right alongside the fix, because the whole risk
// of suppressing an error card is suppressing a real one: a genuinely empty FINISHED message, an
// aborted message, and a not-last message all keep their card.
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { isAwaitingGeneration, MessageBubble } from './MessageBubble'
import type { Message, MessageStats } from '../../lib/chat-types'

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return { ...actual, useChatAgents: () => ({ data: [] }), useModels: () => ({ data: { models: [] } }) }
})

/** Exactly what chat-routes.ts writes for the placeholder row: empty everything, `aborted: false`,
 *  and — the load-bearing part — NO `totalMs`, because nothing has finalized it yet. */
function placeholder(stats: Partial<MessageStats> = { aborted: false }): Message {
  return {
    id: 'm1', convId: 'c1', seq: 2, role: 'assistant', content: '', reasoning: '',
    attachments: [], textAttachments: [], toolCalls: [], stats, createdAt: '',
    variantGroup: null, isActive: true, edited: false,
  }
}

/** A finalized turn always carries the stats block runGeneration builds — totalMs included. */
const FINALIZED: Partial<MessageStats> = { aborted: false, totalMs: 1200, ttftMs: 90, genTokens: 0, promptTokens: 42 }

function renderBubble(message: Message, opts: { isLast?: boolean; daemonGenerating?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MessageBubble
        message={message}
        isLast={opts.isLast ?? true}
        daemonGenerating={opts.daemonGenerating ?? false}
        editingId={null}
        onEditSave={() => {}}
        onEditCancel={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('isAwaitingGeneration', () => {
  it('is true only for an unfinalized last row while the daemon reports a generation', () => {
    expect(isAwaitingGeneration(placeholder(), true, true)).toBe(true)
  })

  it('is false when the daemon reports nothing generating', () => {
    expect(isAwaitingGeneration(placeholder(), true, false)).toBe(false)
  })

  it('is false for a row that is not the last one', () => {
    expect(isAwaitingGeneration(placeholder(), false, true)).toBe(false)
  })

  it('is false once the row has been finalized — this is what keeps a genuinely empty finished message an error, even while ANOTHER conversation generates', () => {
    expect(isAwaitingGeneration(placeholder(FINALIZED), true, true)).toBe(false)
  })

  it('is false for an aborted row', () => {
    expect(isAwaitingGeneration(placeholder({ aborted: true }), true, true)).toBe(false)
  })
})

describe('MessageBubble empty-assistant rendering', () => {
  it('shows the generating affordance, not an error, while the daemon is generating', () => {
    renderBubble(placeholder(), { isLast: true, daemonGenerating: true })
    expect(screen.getByText('Generating…')).toBeTruthy()
    expect(screen.queryByText('This message is empty.')).toBeNull()
  })

  it('still shows "This message is empty." for a genuinely empty FINISHED message', () => {
    renderBubble(placeholder(FINALIZED), { isLast: true, daemonGenerating: true })
    expect(screen.getByText(/This message is empty\./)).toBeTruthy()
    expect(screen.queryByText('Generating…')).toBeNull()
  })

  it('still shows "Generation failed or was stopped." when aborted', () => {
    renderBubble(placeholder({ aborted: true, totalMs: 300 }), { isLast: true, daemonGenerating: true })
    expect(screen.getByText(/Generation failed or was stopped\./)).toBeTruthy()
  })

  it('still shows the error card when nothing is generating (the pre-existing behavior)', () => {
    renderBubble(placeholder(), { isLast: true, daemonGenerating: false })
    expect(screen.getByText(/This message is empty\./)).toBeTruthy()
  })

  it('does not suppress the card for an older message in the thread', () => {
    renderBubble(placeholder(), { isLast: false, daemonGenerating: true })
    expect(screen.getByText(/This message is empty\./)).toBeTruthy()
  })

  it('renders real content untouched while a generation is in flight', () => {
    const m = { ...placeholder(FINALIZED), content: 'the finished answer' }
    renderBubble(m, { isLast: true, daemonGenerating: true })
    expect(screen.getByText('the finished answer')).toBeTruthy()
    expect(screen.queryByText('Generating…')).toBeNull()
  })
})
