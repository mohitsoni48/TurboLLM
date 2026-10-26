// Import-from-URL: the dialog accepts BOTH self-contained single-file model formats —
// .gguf (llama.cpp family) and .litertlm (LiteRT-LM) — from any HTTPS host or as an HF
// resolve link, while still routing repo URLs to the repo view and rejecting files no
// engine can load standalone (a bare .safetensors needs its config/tokenizer siblings).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportUrlDialog } from './ImportUrlDialog'

const enqueue = vi.fn()
const toastSuccess = vi.hoisted(() => vi.fn())
const toastInfo = vi.hoisted(() => vi.fn())

vi.mock('../../lib/queries', () => ({
  useDownloadMutations: () => ({ enqueue: { mutate: enqueue, isPending: false, error: null, reset: () => {} } }),
}))
vi.mock('../../components/ui/sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), info: (m: string) => toastInfo(m) },
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderDialog() {
  return render(
    <ImportUrlDialog open onClose={vi.fn()} onOpenRepo={vi.fn()} />,
  )
}

const input = () => screen.getByPlaceholderText(/huggingface\.co\/owner\/repo/)

beforeEach(() => {
  enqueue.mockReset()
  toastSuccess.mockClear()
  toastInfo.mockClear()
})

describe('ImportUrlDialog — single-file model formats', () => {
  it('still accepts a .gguf URL from any host and previews the filename', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(input(), 'https://example.com/files/model.Q4_K_M.gguf')

    expect(screen.getByText('Will save as')).toBeInTheDocument()
    expect(screen.getByText('model.Q4_K_M.gguf')).toBeInTheDocument()
    expect(screen.queryByText(/Enter a Hugging Face model link/i)).not.toBeInTheDocument()
  })

  it('accepts a .litertlm URL from any host and previews the filename', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(input(), 'https://example.com/files/gemma_q4.litertlm')

    expect(screen.getByText('gemma_q4.litertlm')).toBeInTheDocument()
    expect(screen.queryByText(/Enter a Hugging Face model link/i)).not.toBeInTheDocument()
  })

  it('accepts an HF resolve link to a .gguf and enqueues it unchanged', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(input(), 'https://huggingface.co/bartowski/Qwen3-8B-GGUF/resolve/main/qwen3-8b-Q4_K_M.gguf')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(enqueue).toHaveBeenCalledWith(
      { url: 'https://huggingface.co/bartowski/Qwen3-8B-GGUF/resolve/main/qwen3-8b-Q4_K_M.gguf' },
      expect.anything(),
    )
  })

  it('accepts an HF resolve link to a .litertlm bundle and enqueues the normalized URL', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(input(), 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-gpu.litertlm')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(enqueue).toHaveBeenCalledWith(
      { url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-gpu.litertlm' },
      expect.anything(),
    )
  })

  it('normalizes an hf:// .litertlm link to a direct resolve URL', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(input(), 'hf://litert-community/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it-gpu.litertlm')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(enqueue).toHaveBeenCalledWith(
      { url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-gpu.litertlm' },
      expect.anything(),
    )
  })

  it('rejects a bare .safetensors with the both-formats message', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(input(), 'https://example.com/files/model.safetensors')

    // The message interleaves plain text with font-mono spans, so match on the whole <p>.
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          !!el.textContent?.includes('an http(s) link to a .gguf or .litertlm model file'),
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    expect(enqueue).not.toHaveBeenCalled()
  })
})

// A URL already in the download list queues nothing new. The dialog used to close without a
// word; it now says what happened (the enqueue mutation has resumed a paused row by then).
describe('ImportUrlDialog — a URL already in the download list', () => {
  const URL_ = 'https://example.com/files/model.Q4_K_M.gguf'
  const row = { id: 'dl-1', name: 'model.Q4_K_M.gguf', status: 'queued' }
  async function importIt(result: unknown) {
    enqueue.mockImplementation((_input: unknown, opts?: { onSuccess?: (out: unknown) => void }) => opts?.onSuccess?.(result))
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ImportUrlDialog open onClose={onClose} onOpenRepo={vi.fn()} />)
    await user.type(input(), URL_)
    await user.click(screen.getByRole('button', { name: 'Import' }))
    return onClose
  }

  it('says "Resumed" when it was a paused download', async () => {
    const onClose = await importIt({ downloads: [], existing: [row], resumed: [row] })
    expect(onClose).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Resumed model.Q4_K_M.gguf')
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('says "Already downloading" when it is still downloading', async () => {
    await importIt({ downloads: [], existing: [{ ...row, status: 'downloading' }], resumed: [] })
    expect(toastInfo).toHaveBeenCalledWith('Already downloading model.Q4_K_M.gguf')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('says nothing extra for a new download, which shows in the Downloads panel', async () => {
    await importIt({ downloads: [row], existing: [], resumed: [] })
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
  })
})
