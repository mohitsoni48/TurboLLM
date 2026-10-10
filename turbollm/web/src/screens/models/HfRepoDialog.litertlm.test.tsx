// The LiteRT-LM side of the HF repo dialog: a `.litertlm` repo renders as a VARIANT
// picker (one self-contained bundle per file — gpu/web/device builds, not quants),
// explains what a bundle is, and enqueues a single repo-file download with NO subdir —
// the daemon's expansion path (not the safetensors component path) owns placing it.
// The picker carries NO fit signal and NO auto-pick: both estimate GPU VRAM from a
// GGUF's file size, and a bundle (encoders embedded, often CPU-bound under LiteRT-LM)
// makes that noise — the hardware target is the user's call, so nothing is selected
// until they make it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HfRepoContent } from './HfRepoDialog'
import { ApiError } from '../../lib/api'
import type { LinkSummary } from '../../lib/link-api'
import type { HfRepoDetail, HfRepoFile } from '../../lib/types'

const enqueue = vi.fn()
const requestLoad = vi.fn()
const toastSuccess = vi.fn()

function bundle(name: string, variant: string, sizeBytes: number, sha256: string, quant = '?'): HfRepoFile {
  return { name, quant, variant, sizeBytes, parts: 1, mmproj: false, litertlm: true, sha256, url: `u/${name}` }
}

// The real litert-community/gemma-4-E2B-it-litert-lm shape (verified live): one repo,
// several device/precision variants of the same model. None of these names states a
// precision, so `quant` reads '?' — the same answer the library scanner gives the
// downloaded file — and the variant label is the row's identity.
const FILES = [
  bundle('gemma-4-E2B-it-gpu.litertlm', 'GPU', 2.0e9, 'sha-gpu'),
  bundle('gemma-4-E2B-it.litertlm', 'Default', 2.6e9, 'sha-base'),
  bundle('gemma-4-E2B-it_Google_Tensor_G5.litertlm', 'Google Tensor G5', 3.1e9, 'sha-g5'),
]

function repoDetail(over: Partial<HfRepoDetail> = {}): HfRepoDetail {
  return {
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    gated: false,
    license: 'apache-2.0',
    downloads: 10,
    likes: 2,
    card: '',
    files: FILES,
    litertlm: true,
    ...over,
  } as HfRepoDetail
}

const state: { detail: HfRepoDetail } = { detail: repoDetail() }

vi.mock('../../lib/queries', () => ({
  useHfRepo: () => ({ data: state.detail }),
  useSysInfo: () => ({ data: { gpus: [{ vramMb: 16000 }] } }),
  useStatus: () => ({ data: { engine: { kind: 'litert-lm' } } }),
  // mutate records the input AND runs the caller's onSuccess, so a download's toast
  // fires the way it does against the real mutation (the single-file path toasts there).
  useDownloadMutations: () => ({
    enqueue: {
      mutate: (input: unknown, opts?: { onSuccess?: () => void }) => {
        enqueue(input)
        opts?.onSuccess?.()
      },
      isPending: false,
      error: null,
    },
  }),
  useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false } }),
  useSettings: () => ({ query: { data: { hfTokenSet: true } } }),
}))

// Hoisted above the consts, so the factory only closes over lazy accessors: the links
// list and the remote-start spy are reached at call time, not at mock time.
const remoteStart = vi.fn()
const linkState: { links: LinkSummary[] } = { links: [] }
vi.mock('../../lib/link-queries', () => ({
  useLinks: () => ({ data: linkState.links }),
  useRemoteDownloadActions: () => ({ start: { mutate: (...a: unknown[]) => remoteStart(...a), isPending: false } }),
}))
vi.mock('../../lib/model-loader', () => ({
  useModelLoader: () => ({ requestLoad, isPending: false, pendingKey: undefined }),
}))
// Wrapped rather than passed directly: a `vi.mock` factory is hoisted above the `const`.
vi.mock('../../components/ui/sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: () => {} },
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderContent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HfRepoContent repo="litert-community/gemma-4-E2B-it-litert-lm" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** What actually got queued, as the download route sees it. */
const queued = () => enqueue.mock.calls.map((c) => c[0])

/** Open the variant picker (nothing is pre-selected for .litertlm) and choose a row. */
async function pickVariant(label: string | RegExp) {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Select a variant/ }))
  await user.click(screen.getByRole('menuitem', { name: label }))
}

beforeEach(() => {
  state.detail = repoDetail()
  linkState.links = []
  enqueue.mockClear()
  requestLoad.mockClear()
  toastSuccess.mockClear()
  remoteStart.mockReset()
})

describe('HfRepoContent — a .litertlm repo', () => {
  it('labels the picker "Variant", explains the bundle format, and pre-selects NOTHING', async () => {
    renderContent()

    expect(screen.getByText('Variant')).toBeInTheDocument()
    expect(screen.getByText(/LiteRT-LM model — each file is one self-contained bundle/i)).toBeInTheDocument()
    // The explainer must not claim every variant runs 'on CPU or GPU' — device builds
    // (Tensor G5, MediaTek) only run on their hardware. It points at matching instead.
    expect(screen.getByText(/Pick the variant matching your hardware/i)).toBeInTheDocument()
    // The auto-pick is a GGUF heuristic (largest that fits) and a bundle's target is a
    // hardware choice — so the picker starts on its placeholder, not on a guess that
    // could be a Web or SoC-specific build this machine cannot even run.
    expect(await screen.findByRole('button', { name: /Select a variant/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Google Tensor G5/ })).not.toBeInTheDocument()
  })

  it('lists every bundle as variant · size with NO fit dot, and no VRAM verdict once picked', async () => {
    const user = userEvent.setup()
    renderContent()

    await user.click(await screen.findByRole('button', { name: /Select a variant/ }))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['GPU · 2.0 GB', 'Default · 2.6 GB', 'Google Tensor G5 · 3.1 GB']),
    )
    // The fit dot estimates GPU VRAM from file size — meaningless for a bundle (encoders
    // embedded, often CPU-bound): neither the rows nor the trigger carry one.
    expect(document.querySelectorAll('[title*="VRAM"], [title*="fit" i]').length).toBe(0)

    await user.click(screen.getByRole('menuitem', { name: /Default/ }))
    // The VRAM verdict line is skipped the same way — the size rides in the row itself.
    expect(screen.queryByText(/GB file ·/)).not.toBeInTheDocument()
  })

  it('enqueues the chosen bundle as a plain repo-file download — no subdir, size and sha carried', async () => {
    const user = userEvent.setup()
    renderContent()

    await pickVariant(/^GPU/)
    await user.click(screen.getByRole('button', { name: /Download/ }))

    expect(queued()).toEqual([
      {
        repo: 'litert-community/gemma-4-E2B-it-litert-lm',
        rfilename: 'gemma-4-E2B-it-gpu.litertlm',
        size: 2.0e9,
        sha256: 'sha-gpu',
      },
    ])
    expect(toastSuccess).toHaveBeenCalledWith('Downloading gemma-4-E2B-it-gpu.litertlm')
  })

  it('reads the precision from the name beside the variant, matching the library scanner', async () => {
    // A bundle whose name states a precision shows BOTH: the hardware variant and the
    // precision — 'MT6989 · Q4 · 1.0 GB' — so Discover and the library (whose scanner
    // reads quant='Q4' off the same file name) describe one file, not two.
    state.detail = repoDetail({
      files: [bundle('Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm', 'MT6989', 1.0e9, 'sha-89', 'Q4')],
    })
    renderContent()

    await pickVariant(/MT6989/)
    expect(screen.getByRole('button', { name: /MT6989 · Q4 · 1\.0 GB/ })).toBeInTheDocument()
  })

  it('offers Load instead of Download for a bundle already in the library', async () => {
    const user = userEvent.setup()
    state.detail = repoDetail({
      files: FILES.map((f) =>
        f.name === 'gemma-4-E2B-it.litertlm'
          ? { ...f, downloaded: true, localKey: 'gemma 4 e2b it|default|2600000000' }
          : f,
      ),
    })
    renderContent()

    await pickVariant(/^Default/)
    await user.click(screen.getByRole('button', { name: /^Load/ }))

    expect(requestLoad).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'gemma 4 e2b it|default|2600000000', name: 'gemma-4-E2B-it.litertlm' }),
      expect.anything(),
    )
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('HfRepoContent — a .litertlm repo over Turbo Link', () => {
  it('surfaces a host refusal as the generic remote failure (no version-skew special case)', async () => {
    // An older host (still on the .gguf-only guard) refuses a .litertlm with invalid_request,
    // but the peer proxy relays only a 400's status and code — its message is replaced — so
    // the UI cannot tell that from any other invalid_request and does not try to.
    linkState.links = [
      { id: 'l1', name: 'workstation', status: 'online', grantedCapabilities: ['downloads:read', 'downloads:write'], lastError: null },
    ]
    remoteStart.mockImplementationOnce((_input: unknown, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(new ApiError('invalid_request', 'workstation could not do that right now.', 400))
    })
    const user = userEvent.setup()
    renderContent()

    await pickVariant(/^GPU/)
    await user.click(screen.getByTestId('download-target-trigger'))
    await user.click(screen.getByText('workstation'))

    expect(await screen.findByText(/rejected the request as malformed/i)).toBeInTheDocument()
    expect(screen.queryByText(/older TurboLLM/i)).not.toBeInTheDocument()
  })
})

describe('HfRepoContent — the variant selection survives a refetch of the same repo', () => {
  it('keeps a picked variant when `detail` gets a new reference, and resets for a different repo', async () => {
    // `detail` is a fresh object on every verifying poll (1.5s) and window-focus refetch.
    // The selection must not be cleared by those — only by opening a different repo.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (onClose: () => void) => (
      <QueryClientProvider client={qc}>
        <HfRepoContent repo="litert-community/gemma-4-E2B-it-litert-lm" onClose={onClose} />
      </QueryClientProvider>
    )
    const { rerender } = render(tree(vi.fn()))
    await pickVariant(/^GPU/)
    expect(screen.getByRole('button', { name: /^GPU · / })).toBeInTheDocument()

    // Same repo, new reference (the badges flipped after a poll).
    state.detail = repoDetail({ files: FILES.map((f) => ({ ...f })) })
    rerender(tree(vi.fn()))
    expect(screen.getByRole('button', { name: /^GPU · / })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Select a variant/ })).not.toBeInTheDocument()

    // A DIFFERENT repo opens: a stale name must not carry over.
    state.detail = repoDetail({ repo: 'litert-community/other-litert-lm', files: FILES.map((f) => ({ ...f })) })
    rerender(tree(vi.fn()))
    expect(await screen.findByRole('button', { name: /Select a variant/ })).toBeInTheDocument()
  })
})

describe('HfRepoContent — a .litertlm repo with same-named bundles in different subfolders', () => {
  it('lists both full-path entries as distinct rows and enqueues the exact one picked', async () => {
    // The daemon disambiguates basename collisions by listing the full repo path as the
    // name (hf.ts litertlmFiles) — this pins the UI half: two rows stay selectable
    // (unique React keys, unique labels) and the picked one enqueues its exact path.
    state.detail = repoDetail({
      files: [
        bundle('gpu/model.litertlm', 'GPU Model', 1.0e9, 'sha-gpu'),
        bundle('web/model.litertlm', 'WEB Model', 0.8e9, 'sha-web'),
      ],
    })
    const user = userEvent.setup()
    renderContent()

    await user.click(await screen.findByRole('button', { name: /Select a variant/ }))
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['WEB Model · 800 MB', 'GPU Model · 1.0 GB']),
    )

    await user.click(screen.getByRole('menuitem', { name: /WEB Model/ }))
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(queued()).toEqual([
      {
        repo: 'litert-community/gemma-4-E2B-it-litert-lm',
        rfilename: 'web/model.litertlm',
        size: 0.8e9,
        sha256: 'sha-web',
      },
    ])
  })
})

describe('HfRepoContent — an empty repo', () => {
  it('says no downloadable model files, not "no GGUF files"', () => {
    state.detail = repoDetail({ litertlm: undefined, files: [] })
    renderContent()

    expect(screen.getByText('No downloadable model files found in this repo.')).toBeInTheDocument()
    expect(screen.queryByText(/No GGUF files/i)).not.toBeInTheDocument()
  })
})
