// The models list marks the loaded model that answers aloud (status model.audioOut), and nothing else: not a loaded model
// without it, not another row, and nothing before a model is loaded.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelsScreen } from './ModelsScreen'
import type { ModelEntry } from '../lib/types'

// The models list as the daemon answers it (`loading` until it has): `setModels` answers, re-rendering the screen as
// the query's cache update would.
const state: { models: ModelEntry[]; loading: boolean } = { models: [], loading: false }
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const setHidden = vi.fn()
let statusData: unknown = { engine: { state: 'stopped' }, model: null }

vi.mock('../lib/queries', () => ({
  queryKeys: { models: ['models'], status: ['status'] },
  useModels: () => {
    const models = useSyncExternalStore(subscribe, () => state.models)
    const loading = useSyncExternalStore(subscribe, () => state.loading)
    return { data: loading ? undefined : { models, scanning: false }, isLoading: loading, isError: false, refetch: vi.fn() }
  },
  useModelDirs: () => ({ data: { dirs: ['/models'], primaryDir: '/models' } }),
  useModelMutations: () => ({
    rescan: { mutate: vi.fn() }, addDir: { mutate: vi.fn(), isPending: false, error: null },
    removeDir: { mutate: vi.fn() }, setPrimaryDir: { mutate: vi.fn(), isPending: false },
  }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, variables: undefined },
    eject: { mutate: vi.fn(), isPending: false },
    setHidden: { mutate: setHidden, isPending: false },
  }),
  useStatus: () => ({ data: statusData }),
  useSysInfo: () => ({ data: undefined }),
  useShowAllEngineModels: () => false,
  useDownloads: () => ({ data: undefined }),
}))
vi.mock('../lib/model-loader', () => ({ useModelLoader: () => ({ requestLoad: vi.fn(), isPending: false, pendingKey: undefined }) }))
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
vi.mock('./models/DiscoverTab', () => ({ DiscoverTab: () => null }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('./models/HfRepoDialog', () => ({ HfRepoDialog: () => null }))
vi.mock('./engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
  deleteModel: vi.fn(),
}))
let desktop = true
vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => desktop }))

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'lfm3|Q4_K_M|1', name: 'lfm3-audio', quant: 'Q4_K_M', arch: 'lfm', dir: '/models',
    path: '/models/lfm3.gguf', sizeBytes: 1e9, nativeCtx: 32768, loaded: false,
    compatibleWithActiveEngine: true, format: 'gguf', hasChatTemplate: true,
    ...over,
  } as ModelEntry
}
const SPEAKER = entry({ loaded: true })
const OTHER = entry({ key: 'qwen|Q8_0|2', name: 'qwen2.5-0.5b', quant: 'Q8_0', path: '/models/qwen.gguf' })
const running = (model: Record<string, unknown>) => ({ engine: { state: 'running' }, model: { key: SPEAKER.key, name: 'lfm3-audio', quant: 'Q4_K_M', ctx: 8192, vision: false, ...model } })

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/models']}><ModelsScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.models = [SPEAKER, OTHER]
  state.loading = false
  statusData = { engine: { state: 'stopped' }, model: null }
  desktop = true
})

describe('ModelsScreen — a loaded model that answers aloud', () => {
  it.each([[true], [false]])('is marked on its own row, with an accessible label, and on no other (desktop %s)', (isDesktop) => {
    desktop = isDesktop
    statusData = running({ audioOut: true })
    renderScreen()
    const badges = screen.getAllByLabelText(/answers aloud/i)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('Answers aloud')
    expect(within(badges[0].closest('div')!.parentElement!).getByText('lfm3-audio')).toBeTruthy()
  })

  it('is not shown for a loaded model whose engine does not say it speaks', () => {
    statusData = running({})
    renderScreen()
    expect(screen.queryByText('Answers aloud')).toBeNull()
  })

  it('is not shown when no model is loaded', () => {
    state.models = [entry(), OTHER]
    renderScreen()
    expect(screen.queryByText('Answers aloud')).toBeNull()
  })

  it('is not shown on a row that is not the loaded model, even if the status says another one speaks', () => {
    statusData = running({ key: OTHER.key, name: 'qwen2.5-0.5b', audioOut: true })
    renderScreen()
    // lfm3 is the loaded row but is not the model the status describes; qwen is the described one but not loaded.
    expect(screen.queryByText('Answers aloud')).toBeNull()
  })
})
