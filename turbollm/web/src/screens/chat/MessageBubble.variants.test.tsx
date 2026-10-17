// The ‹ 1/2 › version switcher when the daemon refuses the switch: a stale tab or another device
// still shows a version group that has left the shown branch, and /activate answers 409
// stale_message. The click must say why and catch the view up, not fail silently.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import { ApiError } from '../../lib/api'
import type { Message } from '../../lib/chat-types'

const stale = 'This message is no longer on the shown branch: the chat changed in another tab or device.'
const toastError = vi.fn()
vi.mock('../../components/ui/sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('../../lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chat-api')>()
  return {
    ...actual,
    getMessageVariants: () => Promise.resolve({ variants: [reply('a1', 'Use Python', true), reply('a1b', 'Use Rust', false)] }),
    activateVariant: () => Promise.reject(new ApiError('stale_message', stale, 409)),
  }
})

function reply(id: string, content: string, isActive: boolean): Message {
  return {
    id, convId: 'c1', seq: 2, role: 'assistant', content, reasoning: '', attachments: [], textAttachments: [],
    toolCalls: [], stats: {}, createdAt: '', variantGroup: 'a1', isActive, edited: false,
  }
}

describe('MessageBubble — version switcher', () => {
  it('a switch refused as stale (409) shows the daemon\'s message and refetches the chat and version lists', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    render(
      <QueryClientProvider client={qc}>
        <MessageBubble message={reply('a1', 'Use Python', true)} convId="c1" isLast editingId={null} onEditSave={() => {}} onEditCancel={() => {}} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('1/2')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Next version'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(stale))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['message-variants'] })
    await waitFor(() => expect(screen.getByTitle('Next version')).not.toBeDisabled())
  })
})
