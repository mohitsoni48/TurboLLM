// A run_python call hands back images and files for download (GitHub #52). Under its card the images are pictures and
// the CSV, JSON, text and Python files are download chips under the names the code gave them; a download is never drawn
// as a (broken) picture.
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from './MessageBubble'
import type { Message } from '../../lib/chat-types'

const CHART = `attachment:${'a'.repeat(64)}.png`
const CSV = `attachment:${'b'.repeat(64)}.csv`
const reply: Message = {
  id: 'a1', convId: 'c1', seq: 2, role: 'assistant', content: 'Here is the cleaned file.', reasoning: '', attachments: [CHART, CSV],
  textAttachments: [], stats: {}, createdAt: '', variantGroup: null, isActive: true, edited: false,
  toolCalls: [{
    id: 't1', name: 'run_python', args: { code: 'df.to_csv("cleaned.csv")' }, result: 'Given to the user to download: cleaned.csv',
    files: [CHART, CSV],
    outputs: [{ name: 'chart.png', file: CHART, size: 2_000 }, { name: 'cleaned.csv', file: CSV, size: 512, formulaCells: true }],
  }],
}

describe('MessageBubble — run_python files', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the chart as a picture and the CSV as a download chip with its warning', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Blob(['png']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:chart')
    URL.revokeObjectURL = vi.fn()
    render(<QueryClientProvider client={new QueryClient()}><MessageBubble message={reply} isLast editingId={null} onEdit={() => {}} onEditSave={() => {}} onEditCancel={() => {}} /></QueryClientProvider>)
    expect(screen.getByRole('button', { name: /cleaned\.csv/ }).textContent).toContain('512 B')
    expect(screen.getByText(/A spreadsheet may run them as formulas/)).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const fetched = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(fetched.some((u) => u.endsWith('.png'))).toBe(true)
    expect(fetched.some((u) => u.includes('.csv')), 'the CSV is fetched only when the user downloads it').toBe(false)
  })
})
