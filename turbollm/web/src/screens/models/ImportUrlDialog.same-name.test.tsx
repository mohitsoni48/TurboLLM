// Import from URL of a file whose name another URL's download already saves in the model folder. A raw URL lands flat
// in the folder, so the daemon answered with the other URL's row as if it were this download, and the enqueue mutation
// resumed it: the other URL's model then landed in the library. The daemon now refuses it (409 download_in_progress);
// the dialog stays open with its message, and nothing is resumed. Driven through the real enqueue mutation, with the
// API calls mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import { ImportUrlDialog } from './ImportUrlDialog'

const h = vi.hoisted(() => ({ enqueue: vi.fn(), resume: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  enqueueDownload: (input: unknown) => h.enqueue(input),
  resumeDownload: (id: string) => h.resume(id),
}))
vi.mock('../../components/ui/sonner', () => ({ toast: { success: vi.fn(), info: vi.fn() } }))

const REFUSAL = 'Another download is already saving ggml-model-q4_0.gguf in this folder. Discard it in Downloads, or wait for it to finish.'

beforeEach(() => {
  h.enqueue.mockReset()
  h.resume.mockReset()
  h.resume.mockResolvedValue({ ok: true })
})

describe('ImportUrlDialog — a file name another URL\'s download already saves', () => {
  it('shows the refusal, stays open, and resumes nothing', async () => {
    h.enqueue.mockRejectedValue(new ApiError('download_in_progress', REFUSAL, 409))
    const onClose = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={qc}>
        <ImportUrlDialog open onClose={onClose} onOpenRepo={vi.fn()} />
      </QueryClientProvider>,
    )
    await user.type(screen.getByPlaceholderText(/huggingface\.co\/owner\/repo/), 'https://h2.example/y/ggml-model-q4_0.gguf')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(REFUSAL)).toBeTruthy()
    expect(h.enqueue).toHaveBeenCalledWith({ url: 'https://h2.example/y/ggml-model-q4_0.gguf' })
    expect(h.resume).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
