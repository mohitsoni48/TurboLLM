import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentDownload, fileSize } from './AttachmentDownload'
import { toast } from '../../components/ui/sonner'

const ID = `${'c'.repeat(64)}.csv`
const OUTPUT = { name: 'cleaned sales.csv', file: `attachment:${ID}`, size: 3_400 }

describe('AttachmentDownload', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:download-1')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('tllm.authToken', 'tllm-key')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fetchMock.mockReset()
    localStorage.clear()
  })

  it('shows the name the code gave the file and its size, and fetches nothing until clicked', () => {
    render(<AttachmentDownload output={OUTPUT} />)
    expect(screen.getByRole('button', { name: /cleaned sales\.csv/ }).textContent).toContain('3.3 KB')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/may run them as formulas/)).toBeNull()
  })

  it('fetches the file with the auth header and saves it under its name through a blob URL', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['a,b']), { status: 200 }))
    const clicked: Array<{ href: string; download: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download })
    })
    render(<AttachmentDownload output={OUTPUT} />)
    fireEvent.click(screen.getByRole('button', { name: /cleaned sales\.csv/ }))
    await waitFor(() => expect(clicked).toEqual([{ href: 'blob:download-1', download: 'cleaned sales.csv' }]))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/v1/attachments/${ID}?name=cleaned%20sales.csv`)
    expect((init?.headers as Record<string, string>)['X-TurboLLM-Auth']).toBe('tllm-key')
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-1'))
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('says so when the file cannot be fetched', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '')
    render(<AttachmentDownload output={OUTPUT} />)
    fireEvent.click(screen.getByRole('button', { name: /cleaned sales\.csv/ }))
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not download cleaned sales.csv')))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('warns about a CSV a spreadsheet may run formulas from', () => {
    render(<AttachmentDownload output={{ ...OUTPUT, formulaCells: true }} />)
    expect(screen.getByText('Some cells start with = + - or @. A spreadsheet may run them as formulas.')).toBeTruthy()
  })
})

describe('fileSize', () => {
  it('reads as people read sizes', () => {
    expect(fileSize(0)).toBe('0 B')
    expect(fileSize(1023)).toBe('1023 B')
    expect(fileSize(1024)).toBe('1.0 KB')
    expect(fileSize(25 * 1024)).toBe('25 KB')
    expect(fileSize(3.5 * 1024 * 1024)).toBe('3.5 MB')
    expect(fileSize(120 * 1024 * 1024)).toBe('120 MB')
  })
})
