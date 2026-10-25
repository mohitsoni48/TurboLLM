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

describe('ConversationSettingsDialog — a LiteRT-LM model', () => {
  const qc = new QueryClient()

  it('leaves out Min P, which LiteRT-LM has not, and labels Top K 0 as no limit; other models keep it', async () => {
    // The slider sent a min_p no LiteRT-LM applies.
    const { unmount } = render(<QueryClientProvider client={qc}><ConversationSettingsDialog conv={conv} litertLm modelSampling={{ temp: 0.6, topP: 0.95, topK: 0, minP: 0.05 }} /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle(/Thread settings/))
    await screen.findByText('Top K')
    expect(screen.queryByText('Min P')).toBeNull()
    expect(screen.getByText('off')).toBeTruthy()
    expect(screen.getByText(/LiteRT-LM has no Min P\. Top K 0 is no top-k limit\./)).toBeTruthy()
    unmount()
    render(<QueryClientProvider client={qc}><ConversationSettingsDialog conv={conv} /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle(/Thread settings/))
    expect(await screen.findByText('Min P')).toBeTruthy()
    expect(screen.queryByText(/LiteRT-LM has no Min P/)).toBeNull()
  })

  it('shows a Min P the thread already has as not applied, and Clear drops only it', async () => {
    // Set under another engine, it was hidden with the slider: still sent, and only Reset, which drops every sampling
    // override, could remove it.
    vi.mocked(updateConversation).mockClear()
    const withMinP = { ...conv, sampling: { min_p: 0.1, temperature: 0.9 } } as unknown as Conversation
    render(<QueryClientProvider client={qc}><ConversationSettingsDialog conv={withMinP} litertLm /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle(/Thread settings/))
    await screen.findByText('Top K')
    expect(screen.getByText(/LiteRT-LM has no Min P: this thread's Min P \(0\.10\) is not applied\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }))
    expect(screen.getByText(/LiteRT-LM has no Min P\. Top K 0 is no top-k limit\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateConversation).toHaveBeenCalledTimes(1))
    expect(updateConversation).toHaveBeenLastCalledWith('c1', expect.objectContaining({ sampling: { temperature: 0.9 } }))
  })

  it("counts a thread's camelCase minP, which an API client may store, and Clear drops it too", async () => {
    // The chat sends a thread's minP as min_p and names it in its note, which points here.
    vi.mocked(updateConversation).mockClear()
    const withMinP = { ...conv, sampling: { minP: 0.05, temperature: 0.9 } } as unknown as Conversation
    render(<QueryClientProvider client={qc}><ConversationSettingsDialog conv={withMinP} litertLm /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle(/Thread settings/))
    await screen.findByText('Top K')
    expect(screen.getByText(/LiteRT-LM has no Min P: this thread's Min P \(0\.05\) is not applied\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateConversation).toHaveBeenCalledTimes(1))
    expect(updateConversation).toHaveBeenLastCalledWith('c1', expect.objectContaining({ sampling: { temperature: 0.9 } }))
  })

  it('says Preserve thinking does not apply to a model whose template shows it none of its past reasoning', async () => {
    // Qwen3-0.6B's, Gemma's and LFM2.5-VL's templates read no reasoning_content, where the chat sends past reasoning to
    // LiteRT-LM: the switch would seem to work and change nothing.
    const { unmount } = render(<QueryClientProvider client={qc}><ConversationSettingsDialog conv={conv} litertLm noPastReasoning /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle(/Thread settings/))
    await screen.findByText('Preserve thinking across turns')
    expect(screen.getByText(/This model's chat template shows it none of its past reasoning, so this does not apply to it\./)).toBeTruthy()
    unmount()
    render(<QueryClientProvider client={qc}><ConversationSettingsDialog conv={conv} litertLm /></QueryClientProvider>)
    fireEvent.click(screen.getByTitle(/Thread settings/))
    await screen.findByText('Preserve thinking across turns')
    expect(screen.queryByText(/none of its past reasoning/)).toBeNull()
  })
})
