// Hiding a model by hand (owner's design): a Hide action in each model's menu in the Library; a hidden model leaves
// the Library list until the "Show hidden models" switch lists it again, marked, with an Unhide. Separate from the
// automatic hiding of models the selected engine can't run. The hidden set is the daemon's (GET /models `hidden`).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelsScreen } from './ModelsScreen'
import type { ModelEntry } from '../lib/types'

// The models list as the daemon answers it (`loading` until it has): `setModels` answers, re-rendering the screen as
// the query's cache update would.
const state: { models: ModelEntry[]; loading: boolean } = { models: [], loading: false }
const listeners = new Set<() => void>()
function setModels(models: ModelEntry[]) {
  state.models = models
  state.loading = false
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const setHidden = vi.fn()

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
  useStatus: () => ({ data: { engine: { state: 'stopped' }, model: null } }),
  useSysInfo: () => ({ data: undefined }),
  useShowAllEngineModels: () => false,
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
    key: 'gemma|Q4_K_M|1', name: 'gemma-3-270m', quant: 'Q4_K_M', arch: 'gemma3', dir: '/models',
    path: '/models/gemma.gguf', sizeBytes: 2.5e8, nativeCtx: 32768, loaded: false,
    compatibleWithActiveEngine: true, format: 'gguf', hasChatTemplate: true,
    ...over,
  } as ModelEntry
}
const GEMMA = entry()
const QWEN = entry({ key: 'qwen|Q8_0|2', name: 'qwen2.5-0.5b', quant: 'Q8_0', path: '/models/qwen.gguf' })

function renderScreen(path = '/models') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><ModelsScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const showHidden = () => screen.getByRole('switch', { name: /^Show hidden models/ })

beforeEach(() => {
  state.models = [GEMMA, QWEN]
  state.loading = false
  setHidden.mockReset()
  desktop = true
})

describe('ModelsScreen — hiding a model by hand', () => {
  it.each([[true], [false]])("hides a model from its row's menu (desktop %s)", async (isDesktop) => {
    desktop = isDesktop
    renderScreen()
    await userEvent.click(screen.getAllByRole('button', { name: 'Model actions' })[0])
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }))
    expect(setHidden).toHaveBeenCalledWith({ key: GEMMA.key, hidden: true }, expect.anything())
  })

  it('leaves a hidden model out of the list, and offers the switch with its count', () => {
    state.models = [{ ...GEMMA, hidden: true }, QWEN]
    renderScreen()
    expect(screen.queryByText('gemma-3-270m')).toBeNull()
    expect(screen.getByText('qwen2.5-0.5b')).toBeTruthy()
    expect(showHidden()).toHaveAccessibleName('Show hidden models (1)')
    expect(showHidden()).toHaveAttribute('aria-checked', 'false')
  })

  it.each([[true], [false]])('"Show hidden models" lists it again, marked, and its Unhide unhides it (desktop %s)', async (isDesktop) => {
    desktop = isDesktop
    state.models = [{ ...GEMMA, hidden: true }, QWEN]
    renderScreen()
    await userEvent.click(showHidden())
    expect(screen.getByText('gemma-3-270m')).toBeTruthy()
    expect(screen.getByText('hidden')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Unhide gemma-3-270m' }))
    expect(setHidden).toHaveBeenCalledWith({ key: GEMMA.key, hidden: false }, expect.anything())
  })

  it("names the action Unhide in a hidden model's menu", async () => {
    state.models = [{ ...GEMMA, hidden: true }]
    renderScreen()
    await userEvent.click(showHidden())
    await userEvent.click(screen.getByRole('button', { name: 'Model actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unhide' }))
    expect(setHidden).toHaveBeenCalledWith({ key: GEMMA.key, hidden: false }, expect.anything())
  })

  // A model picker's "Show hidden models" link lands here.
  it('opens with the switch on from ?hidden=1', () => {
    state.models = [{ ...GEMMA, hidden: true }, QWEN]
    renderScreen('/models?hidden=1')
    expect(showHidden()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('gemma-3-270m')).toBeTruthy()
  })

  // The switch shows only while a model is hidden. It stayed on once the last one was unhidden, so the next Hide left
  // the row listed (marked, with Unhide) under a switch that came back already on.
  it.each([['/models'], ['/models?hidden=1']])('turns the switch off once nothing is hidden, so the next model hidden leaves the list (%s)', async (path) => {
    // The daemon's answer to each Hide or Unhide, as useModelActions().setHidden marks the cached list.
    setHidden.mockImplementation((v: { key: string; hidden: boolean }) => {
      setModels(state.models.map((m) => (m.key === v.key ? { ...m, hidden: v.hidden } : m)))
    })
    state.models = [{ ...GEMMA, hidden: true }, { ...QWEN, hidden: true }]
    renderScreen(path)
    if (path === '/models') await userEvent.click(showHidden())
    expect(showHidden()).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Unhide gemma-3-270m' }))
    await userEvent.click(screen.getByRole('button', { name: 'Unhide qwen2.5-0.5b' }))
    expect(screen.queryByRole('switch', { name: /^Show hidden models/ })).toBeNull()
    await userEvent.click(screen.getAllByRole('button', { name: 'Model actions' })[0])
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }))
    expect(setHidden).toHaveBeenLastCalledWith({ key: GEMMA.key, hidden: true }, expect.anything())
    expect(screen.queryByText('gemma-3-270m')).toBeNull()
    expect(screen.getByText('qwen2.5-0.5b')).toBeTruthy()
    expect(showHidden()).toHaveAccessibleName('Show hidden models (1)')
    expect(showHidden()).toHaveAttribute('aria-checked', 'false')
  })

  // While the list loads nothing counts as hidden: the picker's link must still land on the hidden models.
  it('keeps ?hidden=1 on while the list loads, and lists the hidden models once it answers', () => {
    state.loading = true
    renderScreen('/models?hidden=1')
    act(() => setModels([{ ...GEMMA, hidden: true }, QWEN]))
    expect(showHidden()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('gemma-3-270m')).toBeTruthy()
  })

  it('keeps a hidden model listed while it is loaded, so it can be ejected', () => {
    state.models = [{ ...GEMMA, hidden: true, loaded: true }, QWEN]
    renderScreen()
    const row = screen.getByText('gemma-3-270m').closest('div.grid') as HTMLElement
    expect(within(row).getByText('hidden')).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Eject/ })).toBeTruthy()
  })

  it('says every model is hidden, rather than that nothing matches, when the user hid them all', () => {
    state.models = [{ ...GEMMA, hidden: true }, { ...QWEN, hidden: true }]
    renderScreen()
    expect(screen.getByText('All your models are hidden. Turn on "Show hidden models" to list them.')).toBeTruthy()
    expect(showHidden()).toHaveAccessibleName('Show hidden models (2)')
  })

  // The flag is the key's: the same file in two model folders is one hidden model, as the pickers count it.
  it('counts a hidden model in two folders once, as the pickers do', async () => {
    state.models = [{ ...GEMMA, hidden: true }, { ...GEMMA, hidden: true, dir: '/more', path: '/more/gemma.gguf' }, QWEN]
    renderScreen()
    expect(showHidden()).toHaveAccessibleName('Show hidden models (1)')
    await userEvent.click(showHidden())
    expect(screen.getByText('gemma-3-270m')).toBeTruthy()
  })

  it('offers no switch when nothing is hidden', () => {
    renderScreen()
    expect(screen.queryByRole('switch', { name: /^Show hidden models/ })).toBeNull()
  })

  // Separate from the engine's automatic hiding: "Show all" cannot reveal a model the user hid, so its banner leaves it
  // out of the count.
  it("counts a hidden model the engine can't run as the user's, not in the engine banner", () => {
    state.models = [
      { ...GEMMA, hidden: true, compatibleWithActiveEngine: false },
      entry({ key: 'lrt|INT4|3', name: 'gemma-3n', format: 'litertlm', compatibleWithActiveEngine: false }),
      QWEN,
    ]
    renderScreen()
    expect(screen.getByText("1 model is hidden — the active engine can't load it.")).toBeTruthy()
    expect(showHidden()).toHaveAccessibleName('Show hidden models (1)')
  })

  // They counted every model, so "Library (2)" and "All 2" stood over one listed row, and a Vision chip opened to an
  // empty list.
  it('leaves the models hidden by hand out of the counts of the Library tab, the All chip and the facet chips', async () => {
    state.models = [{ ...GEMMA, hidden: true, vision: true }, QWEN]
    renderScreen()
    expect(screen.getByRole('button', { name: 'Library (1)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All 1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Vision/ })).toBeNull()
    await userEvent.click(showHidden())
    expect(screen.getByRole('button', { name: 'Library (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Vision 1' })).toBeTruthy()
  })
})
