import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentImage, isImageAttachment } from './AttachmentImage'

const REF = `attachment:${'a'.repeat(64)}.png`

describe('AttachmentImage', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:attachment-1')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('tllm.authToken', 'tllm-key')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
    localStorage.clear()
  })

  it('shows an inline data URL as it is, with no request', () => {
    render(<AttachmentImage attachment="data:image/png;base64,AAAA" />)
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches a stored image with the auth header (an <img> cannot send it) and shows it from a blob URL', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['png']), { status: 200 }))
    const { unmount } = render(<AttachmentImage attachment={REF} />)
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:attachment-1'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/v1/attachments/${'a'.repeat(64)}.png`)
    expect((init?.headers as Record<string, string>)['X-TurboLLM-Auth']).toBe('tllm-key')
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-1')
  })

  it('a different image shows the loading placeholder, never the previous one\'s revoked blob URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(['png']), { status: 200 }))
    const { rerender } = render(<AttachmentImage attachment={REF} />)
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:attachment-1'))
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}))
    rerender(<AttachmentImage attachment={`attachment:${'b'.repeat(64)}.png`} />)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-1')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows a placeholder when the image cannot be loaded', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    render(<AttachmentImage attachment={REF} />)
    await waitFor(() => expect(screen.getByText('Image unavailable')).toBeTruthy())
  })
})

describe('isImageAttachment', () => {
  it('is an inline image or a stored one, nothing else', () => {
    expect(isImageAttachment('data:image/jpeg;base64,AAAA')).toBe(true)
    expect(isImageAttachment(REF)).toBe(true)
    expect(isImageAttachment('data:text/plain;base64,AAAA')).toBe(false)
    expect(isImageAttachment('https://example.com/a.png')).toBe(false)
  })
})
