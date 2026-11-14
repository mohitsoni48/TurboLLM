// Scalability review 2.7: a sent image is stored by the daemon as a file the message names `attachment:<id>`; older
// messages carry the data URL itself. The bubble shows both.
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'
import { resetTtsBackend } from '../../lib/voice/tts'

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

// A voice message sent as audio has no words: the clip's player is the message, and an empty bubble above it would be
// a stray coloured box. A clip is stored (or inlined) like an image but must never be drawn as one.
describe('MessageBubble — voice clips', () => {
  const CLIP = `attachment:${'d'.repeat(64)}.wav`
  const INLINE_CLIP = 'data:audio/wav;base64,AAAA'
  const withContent = (content: string, attachments: string[]): Message => ({ ...msg(attachments), content })
  const bubbleText = (container: HTMLElement) => container.querySelector('.bg-accent')

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(new Blob(['wav']), { status: 200 })))
    URL.createObjectURL = vi.fn(() => 'blob:stored-clip')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows a player and no empty text bubble for a message that is only a clip', async () => {
    const { container } = show(withContent('', [CLIP]))
    await waitFor(() => expect(screen.getByLabelText('Voice message').getAttribute('src')).toBe('blob:stored-clip'))
    expect(bubbleText(container)).toBeNull()
  })

  it('shows an inline clip\'s player at once, with no empty bubble', () => {
    const { container } = show(withContent('', [INLINE_CLIP]))
    expect(screen.getByLabelText('Voice message').getAttribute('src')).toBe(INLINE_CLIP)
    expect(bubbleText(container)).toBeNull()
  })

  it('shows both the text and the player when a message has words and a clip', () => {
    const { container } = show(withContent('and this is what I said', [INLINE_CLIP]))
    expect(bubbleText(container)?.textContent).toBe('and this is what I said')
    expect(screen.getByLabelText('Voice message')).toBeInTheDocument()
  })

  it('still shows the bubble of an image-only message, and its image', () => {
    const { container } = show(withContent('', ['data:image/png;base64,AAAA']))
    expect(bubbleText(container)).not.toBeNull()
    expect(screen.getByAltText('attached image').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(screen.queryByLabelText('Voice message')).toBeNull()
  })

  it('shows a stored .wav only as a player, never as an <img>', async () => {
    const { container } = show(withContent('', [CLIP, `attachment:${'e'.repeat(64)}.mp3`]))
    await waitFor(() => expect(screen.getAllByLabelText('Voice message')).toHaveLength(2))
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows a clip and an image side by side', async () => {
    show(withContent('', [INLINE_CLIP, 'data:image/png;base64,BBBB']))
    expect(screen.getByLabelText('Voice message')).toBeInTheDocument()
    expect(screen.getAllByAltText('attached image')).toHaveLength(1)
  })
})

describe('MessageBubble — read aloud', () => {
  const reply = (over: Partial<Message> = {}): Message => ({ ...msg([]), id: 'a1', role: 'assistant', content: 'The answer is four.', ...over })

  function installSpeech(voices: number) {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: {
        getVoices: () => Array.from({ length: voices }, (_, i) => ({ voiceURI: `v${i}`, name: `V${i}`, lang: 'en-US', localService: true, default: true })),
        speak: vi.fn(), cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      },
    })
    vi.stubGlobal('SpeechSynthesisUtterance', class { voice: unknown = null; lang = ''; rate = 1; onend = null; onerror = null; constructor(readonly text: string) {} })
  }

  beforeEach(() => resetTtsBackend())
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as { speechSynthesis?: unknown }).speechSynthesis
    resetTtsBackend()
  })

  it('offers "Read aloud" on a finished reply when the device can speak', () => {
    installSpeech(1)
    show(reply())
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument()
  })

  it('offers nothing where the device cannot speak', () => {
    show(reply())
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull()
    installSpeech(0)
    resetTtsBackend()
    show(reply())
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull()
  })

  it('offers nothing on a reply that failed (empty)', () => {
    installSpeech(1)
    show(reply({ content: '', stats: { totalMs: 5 } }))
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull()
  })

  it('offers nothing on a reply the daemon is still generating', () => {
    installSpeech(1)
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble message={reply({ content: '', stats: { aborted: false } })} isLast daemonGenerating editingId={null} onEdit={() => {}} onEditSave={() => {}} onEditCancel={() => {}} />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull()
  })
})
