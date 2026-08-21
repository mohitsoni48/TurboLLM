import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelsScreen } from './ModelsScreen'
import type { LinkSummary } from '../lib/link-api'
import type { RemoteModelRow as RemoteRow } from '../lib/remote-models'
import type { ModelEntry } from '../lib/types'

// The screen's own data layer, stubbed to a quiet default — this file is about the MERGE
// and the capability gating, not about model scanning.
const state: { models: ModelEntry[]; links: LinkSummary[]; remote: RemoteRow[] } = {
  models: [], links: [], remote: [],
}
const remoteLoad = vi.fn()
const localLoad = vi.fn()

vi.mock('../lib/queries', () => ({
  queryKeys: { models: ['models'], status: ['status'] },
  useModels: () => ({ data: { models: state.models, scanning: false }, isLoading: false, isError: false, refetch: vi.fn() }),
  useModelDirs: () => ({ data: { dirs: ['D:\\models'], primaryDir: 'D:\\models' } }),
  useModelMutations: () => ({
    rescan: { mutate: vi.fn() }, addDir: { mutate: vi.fn(), isPending: false, error: null },
    removeDir: { mutate: vi.fn() }, setPrimaryDir: { mutate: vi.fn(), isPending: false },
  }),
  useModelActions: () => ({
    load: { mutate: localLoad, isPending: false, variables: undefined },
    eject: { mutate: vi.fn(), isPending: false },
  }),
  useStatus: () => ({ data: { engine: { state: 'stopped' }, model: null } }),
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

vi.mock('../lib/link-queries', () => ({
  useLinks: () => ({ data: state.links }),
  useRemoteModels: () => ({ data: state.remote }),
  useRemoteModelActions: () => ({
    load: { mutate: remoteLoad, isPending: false },
    unload: { mutate: vi.fn(), isPending: false },
  }),
}))

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'local-1', name: 'Local Llama', quant: 'Q4_K_M', arch: 'llama', dir: 'D:\\models',
    path: 'D:\\models\\local.gguf', sizeBytes: 4e9, nativeCtx: 8192, loaded: false,
    compatibleWithActiveEngine: true, format: 'gguf', hasChatTemplate: true,
    ...over,
  } as ModelEntry
}

function link(over: Partial<LinkSummary> = {}): LinkSummary {
  return {
    id: 'l1', name: 'workstation', status: 'online',
    grantedCapabilities: ['models:use', 'models:load', 'models:unload'], lastError: null, ...over,
  }
}

function remote(over: Partial<RemoteRow['model']> = {}, linkId = 'l1'): RemoteRow {
  return {
    linkId,
    machine: 'workstation',
    model: { key: 'r1', name: 'Remote Qwen', quant: 'Q4_K_M', nativeCtx: 32768, vision: false, loaded: false, ...over },
  }
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
  state.links = []
  state.remote = []
  remoteLoad.mockClear()
  localLoad.mockClear()
})

describe('ModelsScreen — merged fleet library', () => {
  it('is unchanged for an install with no links', () => {
    renderScreen()
    expect(screen.getByText('Local Llama')).toBeTruthy()
    // No machine filter and no origin column when there is only one machine.
    expect(screen.queryByRole('group', { name: /filter by machine/i })).toBeNull()
    expect(screen.queryByText('This machine')).toBeNull()
  })

  it('lists this machine\'s models before any linked machine\'s', () => {
    state.links = [link()]
    state.remote = [remote()]
    const { container } = renderScreen()
    const text = container.textContent ?? ''
    expect(text.indexOf('Local Llama')).toBeLessThan(text.indexOf('Remote Qwen'))
  })

  it('shows an origin for every row once a link exists', () => {
    state.links = [link()]
    state.remote = [remote()]
    renderScreen()
    // "This machine" appears both as a filter chip and as the local row's origin badge.
    expect(screen.getAllByText('This machine').length).toBeGreaterThan(0)
    expect(screen.getAllByText('workstation').length).toBeGreaterThan(0)
  })

  it('filters to one machine, on link id', async () => {
    state.links = [link()]
    state.remote = [remote()]
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: 'workstation' }))
    expect(screen.queryByText('Local Llama')).toBeNull()
    expect(screen.getByText('Remote Qwen')).toBeTruthy()
  })

  it('loads a remote model through the link, never through the local engine route', async () => {
    // The bug this guards: a qualified remote id reaching POST /api/v1/engine/start aborts
    // every in-flight generation and then loads a DIFFERENT local model.
    state.links = [link()]
    state.remote = [remote()]
    state.models = []
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: /load/i }))
    expect(remoteLoad.mock.calls[0][0]).toEqual({ linkId: 'l1', modelKey: 'r1' })
    expect(localLoad).not.toHaveBeenCalled()
  })

  it('disables a remote Load, naming the capability, when the grant is missing', () => {
    state.links = [link({ grantedCapabilities: ['models:use'] })]
    state.remote = [remote()]
    state.models = []
    renderScreen()
    const btn = screen.getByRole('button', { name: /load/i })
    expect(btn).toBeDisabled()
    expect(btn.getAttribute('title')).toMatch(/models:load/)
  })

  it('an offline machine contributes no rows but is still explained', () => {
    state.links = [link({ status: 'unreachable', lastError: 'workstation is not reachable.' })]
    state.remote = [remote()]
    renderScreen()
    expect(screen.queryByText('Remote Qwen')).toBeNull()
    expect(screen.getByText(/not reachable/i)).toBeTruthy()
    // …and it stays selectable in the filter, so the user can still ask about it.
    expect(screen.getByRole('button', { name: 'workstation' })).toBeTruthy()
  })

  it('two machines with the same model name produce two distinct rows', () => {
    state.links = [link(), link({ id: 'l2', name: 'kaggle' })]
    state.remote = [remote({ name: 'Twin' }), remote({ name: 'Twin' }, 'l2')]
    state.models = []
    renderScreen()
    expect(screen.getAllByText('Twin')).toHaveLength(2)
  })
})
