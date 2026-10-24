import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

const msg: Message = {
  id: 'u1', convId: 'c1', seq: 1, role: 'user', content: 'original question', reasoning: '', attachments: [],
  textAttachments: [], toolCalls: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false,
}

describe('MessageBubble — edit draft', () => {
  it('opens an ArrowUp edit (editingId set directly, no pencil click) on the message text, not an abandoned draft', () => {
    let setEditingId: (id: string | null) => void = () => {}
    function Host() {
      const [editingId, set] = useState<string | null>(null)
      setEditingId = set
      return <MessageBubble message={msg} isLast editingId={editingId} onEdit={(m) => set(m.id)} onEditSave={() => {}} onEditCancel={() => set(null)} />
    }
    render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half-typed rewrite I abandoned' } })
    fireEvent.click(screen.getByText('Cancel'))
    // ChatScreen's composer ArrowUp handler: setEditingId(lastUser.id) — it never calls beginEdit.
    act(() => setEditingId('u1'))
    expect(screen.getByRole('textbox')).toHaveValue('original question')
  })
})
