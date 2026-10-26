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
import type { DownloadRecord, JevInfo, ModelEntry } from '../lib/types'

const state: { models: ModelEntry[]; status: unknown; sys?: unknown; showAll?: boolean; downloads?: Partial<DownloadRecord>[] } = { models: [], status: undefined }
const requestLoad = vi.fn()

vi.mock('../lib/queries', () => ({
  queryKeys: { models: ['models'], status: ['status'] },
  useModels: () => ({ data: { models: state.models, scanning: false }, isLoading: false, isError: false, refetch: vi.fn() }),
  useModelDirs: () => ({ data: { dirs: ['/models'], primaryDir: '/models' } }),
  useModelMutations: () => ({
    rescan: { mutate: vi.fn() }, addDir: { mutate: vi.fn(), isPending: false, error: null },
    removeDir: { mutate: vi.fn() }, setPrimaryDir: { mutate: vi.fn(), isPending: false },
  }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, variables: undefined },
    eject: { mutate: vi.fn(), isPending: false },
  }),
  useStatus: () => ({ data: state.status ?? { engine: { state: 'stopped' }, model: null } }),
  useSysInfo: () => ({ data: state.sys }),
  useShowAllEngineModels: () => state.showAll ?? false,
  useDownloads: () => ({ data: state.downloads ? { downloads: state.downloads } : undefined }),
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
    key: 'local-1', name: 'Local Llama', quant: 'Q4_K_M', arch: 'llama', dir: '/models',
    path: '/models/local.gguf', sizeBytes: 4e9, nativeCtx: 8192, loaded: false,
    compatibleWithActiveEngine: true, format: 'gguf', hasChatTemplate: true,
    ...over,
  } as ModelEntry
}

function jevEntry(over: Partial<ModelEntry> = {}): ModelEntry {
  return entry({
    key: 'jev-1', name: 'qwen3.5-4b-nli-v2', format: 'mlx', arch: 'qwen3_5', jev: JEV, ...over,
  })
}

function layaEntry(over: Partial<ModelEntry> = {}): ModelEntry {
  return entry({
    key: 'laya-1', name: 'laya', format: 'mlx', arch: 'laya',
    laya: { checkpoints: ['english', 'multilingual'] }, ...over,
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
  state.status = undefined
  state.sys = undefined
  state.showAll = undefined
  state.models = [entry()]
  state.downloads = undefined
  requestLoad.mockClear()
})

describe('ModelsScreen — Jev models', () => {
  it('keeps a Jev model visible on an engine that cannot load it, and says why', () => {
    state.models = [jevEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' })]
    renderScreen()
    expect(screen.getByText('qwen3.5-4b-nli-v2')).toBeTruthy()
    expect(screen.getByText('Needs vLLM (Linux or WSL2)')).toBeTruthy()
  })

  // ADR-444: one name for both, and a quieter label for the runtime that still differs.
  it('badges a Jev model as text classification on vLLM', () => {
    state.models = [jevEntry()]
    renderScreen()
    expect(screen.getByText('Text classification')).toBeTruthy()
    expect(screen.getByText('vLLM')).toBeTruthy()
    expect(screen.queryByText('Jev')).toBeNull()
  })

  it('badges a Laya model as text classification on the Laya engine', () => {
    state.models = [layaEntry()]
    renderScreen()
    expect(screen.getByText('laya')).toBeTruthy()
    expect(screen.getByText('Text classification')).toBeTruthy()
    expect(screen.getByText('Laya engine')).toBeTruthy()
    expect(screen.queryByText('Laya')).toBeNull()
  })

  it('keeps a Laya model out of the hidden-model banner, as it does a Jev model', () => {
    state.models = [
      layaEntry({ compatibleWithActiveEngine: false }),
      entry({ key: 'mlx-1', name: 'Mistral MLX', format: 'mlx', compatibleWithActiveEngine: false }),
    ]
    renderScreen()
    expect(screen.getByText("1 model is hidden — the active engine can't load it.")).toBeTruthy()
    expect(screen.getByText('laya')).toBeTruthy()
  })

  it('shows a Laya model as loading, not running, while its engine prepares', () => {
    state.models = [layaEntry({ loaded: true, compatibleWithActiveEngine: true })]
    state.status = {
      engine: { state: 'stopped' }, model: null,
      laya: { key: 'laya-1', name: 'laya', checkpoints: ['english'], state: 'starting' },
    }
    renderScreen()
    expect(screen.getByRole('button', { name: /Loading/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Eject/ })).toBeNull()
    expect(screen.queryByText(/· running/)).toBeNull()
  })

  it('shows a Laya model as running once its engine is ready', () => {
    state.models = [layaEntry({ loaded: true, compatibleWithActiveEngine: true })]
    state.status = {
      engine: { state: 'stopped' }, model: null,
      laya: { key: 'laya-1', name: 'laya', checkpoints: ['english'], state: 'running' },
    }
    renderScreen()
    expect(screen.getByRole('button', { name: /Eject/ })).toBeTruthy()
  })

  it('never warns that a Laya model has no chat template: it never chats', () => {
    state.models = [layaEntry({ hasChatTemplate: false, compatibleWithActiveEngine: true })]
    renderScreen()
    expect(screen.queryByText('no chat template')).toBeNull()
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

  // …but with the rows revealed it must count what is actually on screen: the Jev model carries
  // a can't-load chip of its own, so saying "1" beside two such rows is simply false.
  it('counts every model that cannot load once they are all shown', async () => {
    state.models = [
      jevEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' }),
      entry({ key: 'mlx-1', name: 'Mistral MLX', format: 'mlx', compatibleWithActiveEngine: false }),
    ]
    renderScreen()

    await userEvent.click(screen.getByRole('button', { name: 'Show all' }))

    expect(screen.getByText("Showing all models. 2 can't load on the active engine.")).toBeTruthy()
    expect(screen.getByText('Mistral MLX')).toBeTruthy()
  })

  // Settings → Models' "Show models for every engine": the screen opens with every model on it, a .litertlm bundle
  // under llama.cpp included. That row says why the selected engine may not run it, and its Load starts it there
  // all the same (the daemon does not refuse it, and the engine's error shows if it fails): its Load was off.
  it('lists every model with "Show models for every engine" on, and a row the engine cannot run still says why', async () => {
    state.showAll = true
    const bundle = entry({ key: 'litert-1', name: 'Gemma 3n', format: 'litertlm', path: '/models/gemma.litertlm', compatibleWithActiveEngine: false, incompatibleReason: 'needs LiteRT-LM' })
    state.models = [entry(), bundle]
    renderScreen()

    expect(screen.getByText("Showing all models. 1 can't load on the active engine.")).toBeTruthy()
    expect(screen.getByText('Gemma 3n')).toBeTruthy()
    expect(screen.getByText('needs LiteRT-LM')).toBeTruthy()
    const loads = screen.getAllByRole('button', { name: 'Load' }) as HTMLButtonElement[]
    expect(loads.map((b) => b.disabled)).toEqual([false, false])
    await userEvent.click(loads[1])
    expect(requestLoad).toHaveBeenCalledWith(bundle)

    // The banner's own toggle still hides them for this visit.
    await userEvent.click(screen.getByRole('button', { name: 'Show compatible only' }))
    expect(screen.queryByText('Gemma 3n')).toBeNull()
  })

  // "Show all" reveals them the same way; a Laya model, which never runs on the selected engine, still has no Load
  // with no Laya engine installed.
  it('offers the Load of a row "Show all" reveals, but not of a Laya model with no Laya engine', async () => {
    state.models = [
      entry({ key: 'mlx-1', name: 'Mistral MLX', format: 'mlx', compatibleWithActiveEngine: false, incompatibleReason: 'needs MLX or vLLM' }),
      layaEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs the Laya engine' }),
    ]
    renderScreen()
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }))

    const loads = screen.getAllByRole('button', { name: 'Load' }) as HTMLButtonElement[]
    expect(loads.map((b) => [b.disabled, b.getAttribute('title')])).toEqual([
      [false, "The selected engine isn't expected to load this model. Load starts it there anyway, and shows the engine's error if it fails."],
      [true, 'Install the Laya engine (Engines) to load this model.'],
    ])
  })

  it('hides a .litertlm bundle the selected engine cannot run by default', () => {
    state.models = [
      entry(),
      entry({ key: 'litert-1', name: 'Gemma 3n', format: 'litertlm', path: '/models/gemma.litertlm', compatibleWithActiveEngine: false, incompatibleReason: 'needs LiteRT-LM' }),
    ]
    renderScreen()

    expect(screen.getByText("1 model is hidden — the active engine can't load it.")).toBeTruthy()
    expect(screen.queryByText('Gemma 3n')).toBeNull()
  })

  it('gives a Jev model the daemon\'s own reason instead', () => {
    state.models = [jevEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' })]
    renderScreen()
    expect(screen.getByRole('button', { name: 'Load' }).getAttribute('title')).toBe('Needs vLLM (Linux or WSL2)')
  })

  // A Laya model never loads on the active engine, so "switch to" would send the user the wrong way.
  it('tells a Laya model with no Laya engine to install one', () => {
    state.models = [layaEntry({ compatibleWithActiveEngine: false, incompatibleReason: 'Needs the Laya engine' })]
    renderScreen()
    expect(screen.getByRole('button', { name: 'Load' }).getAttribute('title'))
      .toBe('Install the Laya engine (Engines) to load this model.')
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
  // than computing a flag this call site could forget.
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

describe('ModelsScreen — inside the Android app', () => {
  it('offers importing model files, and says why, instead of a silently empty library', () => {
    state.sys = { bundledEnginesOnly: true }
    state.models = []
    renderScreen()
    expect(screen.getByText(/No models in the app yet/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Import model file/ })).toHaveLength(1)
  })

  it('keeps the import button above a non-empty library', () => {
    state.sys = { bundledEnginesOnly: true }
    renderScreen()
    expect(screen.getByText(/doesn.t let the app read model files in shared folders/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Import model file/ })).toBeTruthy()
  })

  it('shows no import control outside the app', () => {
    renderScreen()
    expect(screen.queryByRole('button', { name: /Import model file/ })).toBeNull()
  })
})

// Models opens on the Library, and download progress shows only under Discover: after reopening
// the app, a download a restart had left paused was out of sight. The Library says so in one line,
// only while a download is running, queued, paused or errored, and "Show" opens Discover.
describe('ModelsScreen — the Library says when downloads are waiting', () => {
  const dl = (id: string, status: DownloadRecord['status']) => ({ id, name: `${id}.gguf`, status, received: 0, total: 100 })
  const notice = () => screen.queryByRole('button', { name: 'Show downloads' })

  it('counts running (with queued), paused and failed downloads in one line', () => {
    state.downloads = [dl('a', 'downloading'), dl('b', 'queued'), dl('c', 'paused'), dl('d', 'error'), dl('e', 'done')]
    renderScreen()
    expect(screen.getByText('2 downloads running · 1 paused · 1 failed')).toBeTruthy()
    expect(notice()).toBeTruthy()
  })

  it('names the first count it shows: one paused download alone', () => {
    state.downloads = [dl('c', 'paused'), dl('e', 'cancelled')]
    renderScreen()
    expect(screen.getByText('1 download paused')).toBeTruthy()
  })

  it('shows nothing while every download is done or cancelled, or there are none', () => {
    state.downloads = [dl('e', 'done'), dl('f', 'cancelled')]
    const { unmount } = renderScreen()
    expect(notice()).toBeNull()
    unmount()
    state.downloads = undefined
    renderScreen()
    expect(notice()).toBeNull()
  })

  it('"Show" opens Discover, where the Downloads panel is', async () => {
    state.downloads = [dl('c', 'paused')]
    renderScreen()
    expect(screen.getByText(/GGUF models discovered in your folders/)).toBeTruthy()
    await userEvent.click(notice()!)
    expect(screen.getByText(/Find and download GGUF models from Hugging Face/)).toBeTruthy()
    expect(notice()).toBeNull()
  })

  it('shows on an empty library too', () => {
    state.models = []
    state.downloads = [dl('a', 'downloading')]
    renderScreen()
    expect(screen.getByText('1 download running')).toBeTruthy()
  })
})
