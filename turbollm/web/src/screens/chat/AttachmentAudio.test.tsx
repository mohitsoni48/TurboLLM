import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentAudio } from './AttachmentAudio'
import { isAudioAttachment, isImageAttachment } from './AttachmentImage'

const HEX = 'c'.repeat(64)

describe('AttachmentAudio', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:clip-1')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('tllm.authToken', 'tllm-key')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
    localStorage.clear()
  })

  it('plays an inline data:audio/wav URL directly, with no request', () => {
    render(<AttachmentAudio attachment="data:audio/wav;base64,AAAA" />)
    const player = screen.getByLabelText('Voice message')
    expect(player.tagName).toBe('AUDIO')
    expect(player.getAttribute('src')).toBe('data:audio/wav;base64,AAAA')
    expect(player).toHaveAttribute('controls')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches a stored clip with the auth header (an <audio> cannot send it) and plays it from a blob URL', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['wav']), { status: 200 }))
    const { unmount } = render(<AttachmentAudio attachment={`attachment:${HEX}.wav`} />)
    await waitFor(() => expect(screen.getByLabelText('Voice message').getAttribute('src')).toBe('blob:clip-1'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/v1/attachments/${HEX}.wav`)
    expect((init?.headers as Record<string, string>)['X-TurboLLM-Auth']).toBe('tllm-key')
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip-1')
  })

  it('shows a placeholder, not a player, while a stored clip loads', () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}))
    render(<AttachmentAudio attachment={`attachment:${HEX}.wav`} />)
    expect(screen.queryByLabelText('Voice message')).toBeNull()
  })

  it('says the voice message is unavailable when the fetch fails', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    render(<AttachmentAudio attachment={`attachment:${HEX}.wav`} />)
    await waitFor(() => expect(screen.getByText('Voice message unavailable')).toBeInTheDocument())
    expect(screen.queryByLabelText('Voice message')).toBeNull()
  })

  it('says it too when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<AttachmentAudio attachment={`attachment:${HEX}.mp3`} />)
    await waitFor(() => expect(screen.getByText('Voice message unavailable')).toBeInTheDocument())
  })
})

describe('isAudioAttachment / isImageAttachment', () => {
  it.each([
    ['data:image/png;base64,AAAA', false, true],
    ['data:audio/wav;base64,AAAA', true, false],
    ['data:audio/mpeg;base64,AAAA', true, false],
    [`attachment:${HEX}.png`, false, true],
    [`attachment:${HEX}.jpg`, false, true],
    [`attachment:${HEX}.wav`, true, false],
    [`attachment:${HEX}.mp3`, true, false],
    [`attachment:${HEX}`, false, true],
    ['data:text/plain;base64,AAAA', false, false],
    ['https://example.com/clip.wav', false, false],
  ])('%s: audio %s, image %s', (attachment, audio, image) => {
    expect(isAudioAttachment(attachment)).toBe(audio)
    expect(isImageAttachment(attachment)).toBe(image)
  })
})
