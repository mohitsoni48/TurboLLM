// Scalability review 2.7: a sent image is stored by the daemon as a file the message names `attachment:<id>`; older
// messages carry the data URL itself. The bubble shows both.
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

const REF = `attachment:${'b'.repeat(64)}.jpg`
const msg = (attachments: string[]): Message => ({
  id: 'u1', convId: 'c1', seq: 1, role: 'user', content: 'what is this', reasoning: '', attachments,
  textAttachments: [], toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false,
})
const show = (m: Message) =>
  render(<QueryClientProvider client={new QueryClient()}><MessageBubble message={m} isLast editingId={null} onEdit={() => {}} onEditSave={() => {}} onEditCancel={() => {}} /></QueryClientProvider>)

describe('MessageBubble — image attachments', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows an inline image and a stored one', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['jpg']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:stored')
    URL.revokeObjectURL = vi.fn()
    show(msg(['data:image/png;base64,AAAA', REF]))
    await waitFor(() => expect(screen.getAllByAltText('attached image').map((img) => img.getAttribute('src')))
      .toEqual(['data:image/png;base64,AAAA', 'blob:stored']))
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/attachments/${'b'.repeat(64)}.jpg`)
  })
})
