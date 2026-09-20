// The safetensors side of the HF repo dialog (ADR-434 (h)).
//
// A repo used to be one downloadable thing. It is now a list of checkpoint folders, and the
// three interesting cases are the edges: no checkpoint at all (say so, offer nothing), exactly
// one (behave exactly as this dialog always has), and several (let the user pick one).
//
// The fit helpers this file owns are exercised here too — `CheckpointPicker` renders one dot
// per row with exactly these, so they are shared rather than reimplemented.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HfRepoContent, fileFit } from './HfRepoDialog'
import type { HfCheckpoint, HfRepoDetail, HfRepoFile } from '../../lib/types'

const enqueue = vi.fn()
const requestLoad = vi.fn()
const toastSuccess = vi.fn()

function file(name: string, sizeBytes: number, sha256: string): HfRepoFile {
  return { name, quant: '', sizeBytes, parts: 1, mmproj: false, safetensors: true, sha256, url: `u/${name}` }
}

const ROOT_FILES = [file('config.json', 1e6, 'sha-cfg'), file('model.safetensors', 1e9, 'sha-root')]
const V2_FILES = [
  file('qwen3.5-4b-nli-v2/config.json', 1e6, 'sha-v2-cfg'),
  file('qwen3.5-4b-nli-v2/model.safetensors', 9e9, 'sha-v2'),
]
const V1_FILES = [file('qwen3.5-4b-nli-v1/model.safetensors', 4e9, 'sha-v1')]
const BIG_FILES = [file('qwen3.5-35b-a3b-nli/model.safetensors', 70e9, 'sha-35b')]

function checkpoint(over: Partial<HfCheckpoint> = {}): HfCheckpoint {
  return {
    dir: 'qwen3.5-4b-nli-v2',
    name: 'qwen3.5-4b-nli-v2',
    sizeBytes: 9e9,
    files: V2_FILES,
    jev: { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
    downloaded: false,
    localKey: null,
    ...over,
  }
}

const ROOT_CHECKPOINT = checkpoint({ dir: '', name: 'openjev', sizeBytes: 1e9 + 1e6, files: ROOT_FILES })
const V1 = checkpoint({ dir: 'qwen3.5-4b-nli-v1', name: 'qwen3.5-4b-nli-v1', sizeBytes: 4e9, files: V1_FILES })
const BIG = checkpoint({
  dir: 'qwen3.5-35b-a3b-nli',
  name: 'qwen3.5-35b-a3b-nli',
  sizeBytes: 70e9,
  files: BIG_FILES,
  jev: { architecture: 'Qwen3_5MoeForSequenceClassification', verified: false },
})

function repoDetail(over: Partial<HfRepoDetail> = {}): HfRepoDetail {
  return {
    repo: 'AlexWortega/openjev', gated: false, license: 'apache-2.0', downloads: 10, likes: 2,
    card: '', files: ROOT_FILES, safetensors: true, ...over,
  } as HfRepoDetail
}

const state: { detail: HfRepoDetail } = { detail: repoDetail() }

vi.mock('../../lib/queries', () => ({
  useHfRepo: () => ({ data: state.detail }),
  useSysInfo: () => ({ data: { gpus: [{ vramMb: 16000 }] } }),
  useStatus: () => ({ data: { engine: { kind: 'vllm' } } }),
  useDownloadMutations: () => ({ enqueue: { mutate: enqueue, isPending: false, error: null } }),
  useModelActions: () => ({ load: { mutate: vi.fn(), isPending: false } }),
  useSettings: () => ({ query: { data: { hfTokenSet: true } } }),
}))
vi.mock('../../lib/link-queries', () => ({
  useLinks: () => ({ data: [] }),
  useRemoteDownloadActions: () => ({ start: { mutate: vi.fn(), isPending: false } }),
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

function renderContent(detail: HfRepoDetail) {
  state.detail = detail
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HfRepoContent repo="AlexWortega/openjev" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** What actually got queued, as the download route sees it. */
const queued = () => enqueue.mock.calls.map((c) => c[0])

beforeEach(() => {
  enqueue.mockClear()
  requestLoad.mockClear()
  toastSuccess.mockClear()
})

describe('fileFit', () => {
  it('calls a file comfortably smaller than VRAM a fit', () => {
    expect(fileFit(8e9, 16000)).toBe('fits')
  })

  it('refuses to guess when the GPU VRAM is unknown', () => {
    expect(fileFit(1, undefined)).toBe('unknown')
  })
})

describe('HfRepoDialog — a daemon too old to list checkpoints', () => {
  it('downloads the whole repo root, exactly as it always has', async () => {
    renderContent(repoDetail({ checkpoints: undefined }))
    await userEvent.click(await screen.findByRole('button', { name: /download model/i }))
    expect(queued().map((q) => q.rfilename)).toEqual(['config.json', 'model.safetensors'])
    expect(queued().every((q) => q.subdir === 'openjev')).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith('Queued 2 files for openjev')
  })
})

describe('HfRepoDialog — a repo with no checkpoint', () => {
  it('says why, and offers nothing to press', async () => {
    renderContent(repoDetail({ checkpoints: [] }))
    expect(await screen.findByText(
      'No model checkpoint in this repo — it has weight files, but no folder with a config.json next to them.',
    )).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull()
  })
})

describe('HfRepoDialog — a repo with exactly one checkpoint', () => {
  it('at the root, downloads exactly what it downloads today', async () => {
    renderContent(repoDetail({ checkpoints: [ROOT_CHECKPOINT] }))
    await userEvent.click(await screen.findByRole('button', { name: /download model/i }))
    expect(queued()).toEqual([
      { repo: 'AlexWortega/openjev', rfilename: 'config.json', size: 1e6, sha256: 'sha-cfg', subdir: 'openjev' },
      { repo: 'AlexWortega/openjev', rfilename: 'model.safetensors', size: 1e9, sha256: 'sha-root', subdir: 'openjev' },
    ])
  })

  it('in a subfolder, downloads THAT folder into its own subdir', async () => {
    renderContent(repoDetail({ files: [], checkpoints: [checkpoint()] }))
    await userEvent.click(await screen.findByRole('button', { name: /download model/i }))
    expect(queued()).toEqual([
      { repo: 'AlexWortega/openjev', rfilename: 'qwen3.5-4b-nli-v2/config.json', size: 1e6, sha256: 'sha-v2-cfg', subdir: 'openjev/qwen3.5-4b-nli-v2' },
      { repo: 'AlexWortega/openjev', rfilename: 'qwen3.5-4b-nli-v2/model.safetensors', size: 9e9, sha256: 'sha-v2', subdir: 'openjev/qwen3.5-4b-nli-v2' },
    ])
    expect(toastSuccess).toHaveBeenCalledWith('Queued 2 files for openjev/qwen3.5-4b-nli-v2')
  })

  it('sizes the subfolder, not the empty repo root', async () => {
    renderContent(repoDetail({ files: [], checkpoints: [checkpoint()] }))
    expect(await screen.findByText(/9\.0 GB total/)).toBeTruthy()
  })

  it('marks it as a Jev model', async () => {
    renderContent(repoDetail({ checkpoints: [ROOT_CHECKPOINT] }))
    expect(await screen.findByText('Jev model')).toBeTruthy()
    expect(screen.queryByText('Not verified')).toBeNull()
  })

  it('tags an unverified architecture without hiding the download', async () => {
    renderContent(repoDetail({ files: [], checkpoints: [BIG] }))
    expect(await screen.findByText('Not verified')).toBeTruthy()
    expect(screen.getByRole('button', { name: /download model/i })).not.toBeDisabled()
  })

  it('says nothing about Jev for a plain safetensors checkpoint', async () => {
    renderContent(repoDetail({ checkpoints: [{ ...ROOT_CHECKPOINT, jev: null }] }))
    await screen.findByRole('button', { name: /download model/i })
    expect(screen.queryByText('Jev model')).toBeNull()
  })
})

describe('HfRepoDialog — a repo with several checkpoints', () => {
  it('lets the user pick one instead of downloading the lot', async () => {
    renderContent(repoDetail({ files: [], checkpoints: [checkpoint(), V1, BIG] }))
    expect(await screen.findByText('qwen3.5-4b-nli-v2')).toBeTruthy()
    expect(screen.getByText('qwen3.5-4b-nli-v1')).toBeTruthy()
    expect(screen.getByText('qwen3.5-35b-a3b-nli')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(3)
  })

  it('downloads the picked row\'s own files into that row\'s subdir', async () => {
    renderContent(repoDetail({ files: [], checkpoints: [checkpoint(), V1, BIG] }))
    await userEvent.click((await screen.findAllByRole('button', { name: 'Download' }))[1])
    expect(queued()).toEqual([
      { repo: 'AlexWortega/openjev', rfilename: 'qwen3.5-4b-nli-v1/model.safetensors', size: 4e9, sha256: 'sha-v1', subdir: 'openjev/qwen3.5-4b-nli-v1' },
    ])
  })

  it('loads an already-downloaded row through the shared loader, with the checkpoint\'s own jev', async () => {
    const downloaded = checkpoint({ downloaded: true, localKey: 'v2-key' })
    renderContent(repoDetail({ files: [], checkpoints: [downloaded, V1, BIG] }))
    await userEvent.click(await screen.findByRole('button', { name: 'Load' }))
    const [target, opts] = requestLoad.mock.calls[0]
    expect(target).toEqual({
      key: 'v2-key',
      name: 'qwen3.5-4b-nli-v2',
      jev: { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
    })
    expect(typeof opts.onSuccess).toBe('function')
    expect(typeof opts.onError).toBe('function')
  })

  it('gives the loader nothing to confirm for a plain safetensors checkpoint', async () => {
    const plain = checkpoint({ downloaded: true, localKey: 'plain-key', jev: null })
    renderContent(repoDetail({ files: [], checkpoints: [plain, V1, BIG] }))
    await userEvent.click(await screen.findByRole('button', { name: 'Load' }))
    expect(requestLoad.mock.calls[0][0].jev).toBeNull()
  })
})
