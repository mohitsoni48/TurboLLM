// "Fork from here" (GitHub issue 323): on every message of a chat that can be changed, never in a read-only view, and not
// on the reply still being written.
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1', convId: 'c1', seq: 1, role: 'user', content: 'hello', reasoning: '', attachments: [],
  textAttachments: [], toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false, ...over,
} as Message)

const show = (m: Message, props: { onFork?: (m: Message) => void; daemonGenerating?: boolean; isLast?: boolean } = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble message={m} isLast={props.isLast ?? false} editingId={null} onEdit={() => {}} onEditSave={() => {}} onEditCancel={() => {}} onFork={props.onFork} daemonGenerating={props.daemonGenerating} />
    </QueryClientProvider>,
  )

describe('MessageBubble — Fork from here', () => {
  it('forks from a question and from a finished reply, passing the message', () => {
    const onFork = vi.fn()
    const q = msg()
    const { unmount } = show(q, { onFork })
    fireEvent.click(screen.getByTitle('Fork from here'))
    expect(onFork).toHaveBeenCalledWith(q)
    unmount()

    const a = msg({ id: 'a1', role: 'assistant', content: 'hi there', stats: { totalMs: 10 } as Message['stats'] })
    show(a, { onFork })
    fireEvent.click(screen.getByTitle('Fork from here'))
    expect(onFork).toHaveBeenLastCalledWith(a)
  })

  it('is not offered in a read-only view', () => {
    show(msg())
    expect(screen.queryByTitle('Fork from here')).toBeNull()
  })

  it('is not offered on the reply still being written', () => {
    show(msg({ id: 'a1', role: 'assistant', content: '', stats: { aborted: false } as Message['stats'] }), { onFork: vi.fn(), daemonGenerating: true, isLast: true })
    expect(screen.queryByTitle('Fork from here')).toBeNull()
  })
})
