import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { ConversationSettingsDialog } from './ConversationSettingsDialog'
import type { Conversation } from '../../lib/chat-types'

vi.mock('../../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})

const conv = {
  id: 'c1', title: 'New chat', systemPrompt: '', sampling: {}, skillIds: [], preserveThinking: true,
  expertMode: false, messages: [],
} as unknown as Conversation

describe('ConversationSettingsDialog — unsaved edits', () => {
  const qc = new QueryClient()
  const ui = (c: Conversation) => (
    <QueryClientProvider client={qc}><ConversationSettingsDialog conv={c} /></QueryClientProvider>
  )

  it('keeps what the user is typing when the same conversation refetches while the dialog is open', async () => {
    const { rerender } = render(ui(conv))
    fireEvent.click(screen.getByTitle(/Thread settings/))
    const prompt = await screen.findByPlaceholderText(/Leave blank/)
    fireEvent.change(prompt, { target: { value: 'Answer in French.' } })
    // What a reply finishing (setQueryData + refetch) or the auto-title does to convQ.data: the
    // same conversation, as a new object.
    rerender(ui({ ...conv, title: 'Auto title', messages: [] } as Conversation))
    expect(screen.getByPlaceholderText(/Leave blank/)).toHaveValue('Answer in French.')
  })

  it('still loads the other conversation\'s settings when the conversation itself changes', async () => {
    const { rerender } = render(ui(conv))
    fireEvent.click(screen.getByTitle(/Thread settings/))
    fireEvent.change(await screen.findByPlaceholderText(/Leave blank/), { target: { value: 'unsaved' } })
    rerender(ui({ ...conv, id: 'c2', systemPrompt: 'Be terse.' } as Conversation))
    expect(screen.getByPlaceholderText(/Leave blank/)).toHaveValue('Be terse.')
  })
})
