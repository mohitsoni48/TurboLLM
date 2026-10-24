import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { ConversationSettingsDialog } from './ConversationSettingsDialog'
import type { Conversation } from '../../lib/chat-types'
import { updateConversation } from '../../lib/chat-api'

vi.mock('../../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})
vi.mock('../../lib/chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chat-api')>()
  return { ...actual, updateConversation: vi.fn(() => Promise.resolve({})) }
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

  // Save closes the dialog before the refetch it started lands. Reopened in that gap,
  // the form loads the old values; once the refetch arrives it must take them, or a second Save
  // writes the old values back.
  const saveAndReopen = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByPlaceholderText(/Leave blank/)).toBeNull())
    fireEvent.click(screen.getByTitle(/Thread settings/))
    return screen.findByPlaceholderText(/Leave blank/)
  }

  it('reopened before the post-save refetch lands, it shows the saved values once they arrive, and a second Save keeps them', async () => {
    vi.mocked(updateConversation).mockClear()
    const { rerender } = render(ui(conv))
    fireEvent.click(screen.getByTitle(/Thread settings/))
    fireEvent.change(await screen.findByPlaceholderText(/Leave blank/), { target: { value: 'Answer in French.' } })
    await saveAndReopen()
    rerender(ui({ ...conv, systemPrompt: 'Answer in French.' } as Conversation))
    expect(screen.getByPlaceholderText(/Leave blank/)).toHaveValue('Answer in French.')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateConversation).toHaveBeenCalledTimes(2))
    expect(updateConversation).toHaveBeenLastCalledWith('c1', expect.objectContaining({ systemPrompt: 'Answer in French.' }))
  })

  it('when that refetch lands, a field the user already changed again keeps their edit and the others take the saved values', async () => {
    vi.mocked(updateConversation).mockClear()
    const { rerender } = render(ui(conv))
    fireEvent.click(screen.getByTitle(/Thread settings/))
    fireEvent.click(await screen.findByRole('switch'))
    const prompt = await saveAndReopen()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true') // still the old value
    fireEvent.change(prompt, { target: { value: 'Be brief.' } })
    rerender(ui({ ...conv, preserveThinking: false } as Conversation))
    expect(screen.getByPlaceholderText(/Leave blank/)).toHaveValue('Be brief.')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateConversation).toHaveBeenCalledTimes(2))
    expect(updateConversation).toHaveBeenLastCalledWith('c1', expect.objectContaining({ systemPrompt: 'Be brief.', preserveThinking: false }))
  })
})
