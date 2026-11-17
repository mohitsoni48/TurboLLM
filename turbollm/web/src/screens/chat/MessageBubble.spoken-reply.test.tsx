// A reply the model spoke: its clip is a player under its words, and the whole message when it has none. Never played by
// itself: autoplay belongs to a voice conversation, not to a message in the list.
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

const CLIP = `attachment:${'a'.repeat(64)}.wav`
const reply = (content: string, attachments: string[]): Message => ({
  id: 'a1', convId: 'c1', seq: 2, role: 'assistant', content, reasoning: '', attachments,
  textAttachments: [], toolCalls: [], stats: { aborted: false }, createdAt: '', variantGroup: null, isActive: true, edited: false,
})
const show = (m: Message) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MessageBubble message={m} isLast editingId={null} onEdit={() => {}} onEditSave={() => {}} onEditCancel={() => {}} onRegenerate={() => {}} onDelete={() => {}} />
  </QueryClientProvider>,
)

describe('MessageBubble — a spoken reply', () => {
  let play: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(new Blob(['wav']), { status: 200 })))
    URL.createObjectURL = vi.fn(() => 'blob:reply-clip')
    URL.revokeObjectURL = vi.fn()
    play = vi.fn(() => Promise.resolve())
    HTMLMediaElement.prototype.play = play as unknown as typeof HTMLMediaElement.prototype.play
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the words and a player for a reply with both', async () => {
    show(reply('The capital of France is Paris.', [CLIP]))
    expect(screen.getByText('The capital of France is Paris.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Spoken reply').getAttribute('src')).toBe('blob:reply-clip'))
    expect(screen.queryByText('This message is empty.')).toBeNull()
  })

  it('shows only a player, not an empty-message card, for a reply with audio and no words', async () => {
    const { container } = show(reply('', [CLIP]))
    await waitFor(() => expect(screen.getByLabelText('Spoken reply')).toBeInTheDocument())
    expect(screen.queryByText('This message is empty.')).toBeNull()
    expect(screen.queryByText('Generation failed or was stopped.')).toBeNull()
    expect(container.querySelector('.prose-tllm')).toBeNull()
    // Nothing to copy, read aloud or edit; the message can still be regenerated and deleted.
    expect(screen.queryByTitle('Edit')).toBeNull()
    expect(screen.getByTitle('Regenerate')).toBeInTheDocument()
    expect(screen.getByTitle('Delete')).toBeInTheDocument()
  })

  it('shows no player for a reply that is only text', () => {
    show(reply('Just words.', []))
    expect(screen.getByText('Just words.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Spoken reply')).toBeNull()
    expect(screen.getByTitle('Edit')).toBeInTheDocument()
  })

  it('never starts playing by itself', async () => {
    show(reply('Hello.', [CLIP]))
    const player = await screen.findByLabelText('Spoken reply')
    expect(player).not.toHaveAttribute('autoplay')
    expect((player as HTMLAudioElement).autoplay).toBe(false)
    expect(play).not.toHaveBeenCalled()
  })

  it('says the reply is unavailable when its clip is gone, and keeps the words', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 404 })))
    show(reply('Still here.', [CLIP]))
    await waitFor(() => expect(screen.getByText('Spoken reply unavailable')).toBeInTheDocument())
    expect(screen.getByText('Still here.')).toBeInTheDocument()
  })

  it('leaves a user message\'s player as it was: labelled as a voice message', () => {
    show({ ...reply('', ['data:audio/wav;base64,AAAA']), role: 'user' })
    expect(screen.getByLabelText('Voice message')).toBeInTheDocument()
  })
})
