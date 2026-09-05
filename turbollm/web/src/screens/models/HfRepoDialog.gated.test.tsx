import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HfRepoContent } from './HfRepoDialog'

// Issue #198. A gated repo used to disable Download unconditionally — with a valid HF
// token configured, a set of files the backend had already listed, and a download path
// that authenticates every request, the button still could not be pressed. The token, not
// the gate flag, is what makes an attempt pointless: these tests pin the button to it,
// on both repo shapes (GGUF and safetensors), and pin the notice's copy to the same state
// so the user is told which half is still on them.

const enqueue = vi.fn()

const state = { gated: true, hfTokenSet: false, safetensors: false }

vi.mock('../../lib/queries', () => ({
  useHfRepo: () => ({
    data: {
      repo: 'owner/gated-repo',
      gated: state.gated,
      downloads: 0,
      likes: 0,
      license: 'other',
      safetensors: state.safetensors,
      card: '',
      files: state.safetensors
        ? [{ name: 'model.safetensors', quant: '', sizeBytes: 8e9, sha256: 'abc', mmproj: false, downloaded: false }]
        : [{ name: 'model-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4e9, sha256: 'abc', mmproj: false, downloaded: false }],
    },
  }),
  useSysInfo: () => ({ data: { gpus: [{ vramMb: 16000 }] } }),
  useStatus: () => ({ data: { engine: { kind: 'llamacpp' } } }),
  useDownloadMutations: () => ({ enqueue: { mutate: enqueue, isPending: false, error: null } }),
  useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false } }),
  useSettings: () => ({ query: { data: { hfTokenSet: state.hfTokenSet } } }),
}))

// No links: the download target is never a question here, so the plain local button renders.
vi.mock('../../lib/link-queries', () => ({
  useLinks: () => ({ data: [] }),
  useRemoteDownloadActions: () => ({ start: { mutate: vi.fn(), isPending: false } }),
}))

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderContent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HfRepoContent repo="owner/gated-repo" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.gated = true
  state.hfTokenSet = false
  state.safetensors = false
  enqueue.mockClear()
})

describe('HfRepoDialog — gated repos', () => {
  it('downloads a gated repo when a Hugging Face token is configured', async () => {
    state.hfTokenSet = true
    renderContent()
    const btn = await screen.findByRole('button', { name: /download/i })
    expect(btn).not.toBeDisabled()
    await userEvent.click(btn)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][0]).toMatchObject({ repo: 'owner/gated-repo', rfilename: 'model-Q4_K_M.gguf' })
  })

  it('blocks a gated repo only while NO token is configured', async () => {
    renderContent()
    expect(await screen.findByRole('button', { name: /download/i })).toBeDisabled()
  })

  it('names the missing half: add a token when there is none…', async () => {
    renderContent()
    expect(await screen.findByText(/add a Hugging Face token/i)).toBeTruthy()
  })

  it('…and accept the license when the token is already there', async () => {
    state.hfTokenSet = true
    renderContent()
    expect(await screen.findByText(/Accept the license/i)).toBeTruthy()
    expect(screen.queryByText(/add a Hugging Face token/i)).toBeNull()
  })

  it('applies the same rule to a gated safetensors repo, and explains it there too', async () => {
    state.safetensors = true
    state.hfTokenSet = true
    renderContent()
    const btn = await screen.findByRole('button', { name: /download model/i })
    expect(btn).not.toBeDisabled()
    // The notice used to render only on the GGUF side: a safetensors repo was greyed out
    // with no explanation at all.
    expect(screen.getByText(/This is a gated model/i)).toBeTruthy()
    await userEvent.click(btn)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('leaves an ungated repo alone', async () => {
    state.gated = false
    renderContent()
    expect(await screen.findByRole('button', { name: /download/i })).not.toBeDisabled()
    expect(screen.queryByText(/This is a gated model/i)).toBeNull()
  })
})
