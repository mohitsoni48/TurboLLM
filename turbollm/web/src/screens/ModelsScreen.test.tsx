// Jev models on the Models page (ADR-434 (g), (i)(3)).
//
// A Jev model is a classifier, not a chat model: it needs vLLM, so on any other engine it is
// unavailable rather than absent, it never carries a chat-template complaint, and loading it
// goes through the shared loader that asks before it interrupts running work.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelsScreen } from './ModelsScreen'
import type { JevInfo, ModelEntry } from '../lib/types'

const state: { models: ModelEntry[] } = { models: [] }
const requestLoad = vi.fn()

vi.mock('../lib/queries', () => ({
  queryKeys: { models: ['models'], status: ['status'] },
  useModels: () => ({ data: { models: state.models, scanning: false }, isLoading: false, isError: false, refetch: vi.fn() }),
  useModelDirs: () => ({ data: { dirs: ['D:\models'], primaryDir: 'D:\models' } }),
  useModelMutations: () => ({
    rescan: { mutate: vi.fn() }, addDir: { mutate: vi.fn(), isPending: false, error: null },
    removeDir: { mutate: vi.fn() }, setPrimaryDir: { mutate: vi.fn(), isPending: false },
  }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, variables: undefined },
    eject: { mutate: vi.fn(), isPending: false },
  }),
  useStatus: () => ({ data: { engine: { state: 'stopped' }, model: null } }),
}))
vi.mock('../lib/model-loader', () => ({
  useModelLoader: () => ({ requestLoad, isPending: false, pendingKey: undefined }),
}))
vi.mock('../lib/link-queries', () => ({
  useLinks: () => ({ data: undefined }),
  useRemoteModels: () => ({ data: undefined }),
  useRemoteModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, variables: undefined },
    unload: { mutate: vi.fn(), isPending: false, variables: undefined },
  }),
}))
vi.mock('../lib/onboarding-queries', () => ({ useOnboardingState: () => ({ data: undefined }) }))
vi.mock('../lib/usePinnedModels', () => ({ usePinnedModels: () => ({ isPinned: () => false, togglePinned: vi.fn() }) }))
vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))
vi.mock('./models/DiscoverTab', () => ({ DiscoverTab: () => null }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('./models/HfRepoDialog', () => ({ HfRepoDialog: () => null }))
vi.mock('./engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
  deleteModel: vi.fn(),
}))

const JEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: '{}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'local-1', name: 'Local Llama', quant: 'Q4_K_M', arch: 'llama', dir: 'D:\models',
    path: 'D:\models\local.gguf', sizeBytes: 4e9, nativeCtx: 8192, loaded: false,
    compatibleWithActiveEngine: true, format: 'gguf', hasChatTemplate: true,
    ...over,
  } as ModelEntry
}

function jevEntry(over: Partial<ModelEntry> = {}): ModelEntry {
  return entry({
    key: 'jev-1', name: 'qwen3.5-4b-nli-v2', format: 'mlx', arch: 'qwen3_5', jev: JEV, ...over,
  })
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ModelsScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.models = [entry()]
  requestLoad.mockClear()
})

describe('ModelsScreen — Jev models', () => {
  it('keeps a Jev model visible on an engine that cannot load it, and says why', () => {
    state.models = [jevEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' })]
    renderScreen()
    expect(screen.getByText('qwen3.5-4b-nli-v2')).toBeTruthy()
    expect(screen.getByText('Needs vLLM (Linux or WSL2)')).toBeTruthy()
    expect(screen.getByText('Jev')).toBeTruthy()
  })

  it('leaves a Jev model out of the hidden-model banner', () => {
    state.models = [
      jevEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' }),
      entry({ key: 'mlx-1', name: 'Mistral MLX', format: 'mlx', compatibleWithActiveEngine: false }),
    ]
    renderScreen()
    expect(screen.getByText("1 model is hidden — the active engine can't load it.")).toBeTruthy()
    expect(screen.queryByText('Mistral MLX')).toBeNull()
  })

  it('never labels a Jev model "no chat template" — it never chats', () => {
    state.models = [jevEntry({ hasChatTemplate: false })]
    renderScreen()
    expect(screen.queryByText('no chat template')).toBeNull()
  })

  it('still labels a non-Jev MLX model with no chat template', () => {
    state.models = [entry({ key: 'mlx-2', name: 'Mistral MLX', format: 'mlx', hasChatTemplate: false })]
    renderScreen()
    expect(screen.getByText('no chat template')).toBeTruthy()
  })

  // The loader reads the model's own `jev` field, so the row hands the entry over whole rather
  // than computing a flag this call site could forget (§5 ruling 9).
  it('loads a Jev model through the loader, jev field and all', async () => {
    state.models = [jevEntry()]
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: 'Load' }))
    expect(requestLoad).toHaveBeenCalledWith(jevEntry())
    expect(requestLoad.mock.calls[0][0].jev).toEqual(JEV)
  })

  it('loads a plain model through the same loader, with nothing to confirm', async () => {
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: 'Load' }))
    expect(requestLoad).toHaveBeenCalledWith(entry())
    expect(requestLoad.mock.calls[0][0].jev).toBeUndefined()
  })
})
