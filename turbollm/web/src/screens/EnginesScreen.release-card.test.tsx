// The catalog card owns its release engine (issue #276, founder decision): once a prebuilt build
// is installed the Prism card shows it as installed, with a Release badge, its tag, Update,
// policy, Disable/Enable and Delete. Ownership comes ONLY from the backend's releaseEngineId /
// releaseBinPath; the web never matches by repo. "Running now" never points at llama.cpp.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnginesScreen, catalogIdFor } from './EnginesScreen'
import { getEngineUpdates, updateEngine } from '../lib/api'
import type { CatalogEngine, CustomEngineSource, Engine, EngineFit, EngineVariant, ReleaseProvenance } from '../lib/types'

const addMutate = vi.fn()
const purgeMutate = vi.fn()

function engine(over: Partial<Engine> & { id: string; name: string }): Engine {
  return { binPath: '', version: '', capabilities: { kvTypes: [], flags: [] }, ...over }
}

const PRISM_VARIANT: EngineVariant = {
  id: 'prism-src', label: 'Prism', repo: 'PrismML-Eng/llama.cpp', requires: {}, stability: 'experimental', hasPrebuilt: false,
}
const PRISM_CATALOG: CatalogEngine = {
  id: 'prism', name: 'Prism', kind: 'llama-server', description: 'Prism fork',
  provision: 'github-release', homepage: 'https://github.com/PrismML-Eng/llama.cpp',
  repo: 'PrismML-Eng/llama.cpp', platforms: ['win32', 'darwin', 'linux'], support: 'experimental',
  installEndpoint: '', releaseInstall: true, supportedHere: true, installed: false, enabled: false,
  defaultBranch: 'prism', variants: [PRISM_VARIANT],
}
const BEE_CATALOG: CatalogEngine = {
  ...PRISM_CATALOG, id: 'beellama', name: 'BeeLlama', repo: 'Anbeeld/beellama.cpp',
  homepage: 'https://github.com/Anbeeld/beellama.cpp', defaultBranch: 'main',
}
const fitFor = (catalog: CatalogEngine): EngineFit => ({
  engine: catalog, variants: [PRISM_VARIANT], compatible: [PRISM_VARIANT], recommended: false,
})

const PRISM_BIN = '/e/build/PrismML-Eng-llama.cpp-win-cuda/llama-server'
const prismRelease = (tag: string): ReleaseProvenance => ({
  repo: 'PrismML-Eng/llama.cpp', tag, asset: `llama-prism-${tag}-win-cuda.zip`, assetKey: 'llama-prism-win-cuda.zip',
  publishedAt: '2026-10-08T00:00:00Z', prerelease: false, companions: [],
})
const PRISM_ENGINE = engine({
  id: 'relA', name: 'Prism CUDA 13.3 (prism-b10770)', binPath: PRISM_BIN, version: 'zzz-v', release: prismRelease('prism-b10770'),
})
const PRISM_OWNED: CatalogEngine = {
  ...PRISM_CATALOG, installed: true, enabled: true,
  releaseEngineId: 'relA', release: prismRelease('prism-b10770'), releaseBinPath: PRISM_BIN,
}
const PRISM_DISABLED: CatalogEngine = {
  ...PRISM_CATALOG, installed: true, enabled: false,
  release: prismRelease('prism-b10770'), releaseBinPath: PRISM_BIN,
}
const DISABLED_SOURCE: CustomEngineSource = {
  name: 'Prism CUDA 13.3 (prism-b10770)', binPath: PRISM_BIN, addedAt: '2026-10-09T00:00:00Z', binPathExists: true,
}

const state: {
  engines: Engine[]; activeEngineId: string; customDisabled: CustomEngineSource[]
  catalog: CatalogEngine[]; fits: EngineFit[]
  updates: Record<string, unknown>; policies: Record<string, string>
} = { engines: [], activeEngineId: '', customDisabled: [], catalog: [], fits: [], updates: {}, policies: {} }

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useEngines: () => ({ data: { engines: state.engines, activeEngineId: state.activeEngineId, customDisabled: state.customDisabled }, isError: false, refetch: vi.fn() }),
    useEngineBackends: () => ({ data: { backends: [] } }),
    useEngineCatalog: () => ({ data: { engines: state.catalog }, isLoading: false }),
    useEngineRecommendation: () => ({
      data: { hardware: { platform: 'win32', arch: 'x64', gpuVendor: 'nvidia', hasGpu: true, vramMb: 16000 }, recommendation: { recommended: null, fits: state.fits } },
      isLoading: false,
    }),
    useEngineUpdates: () => ({ data: { updates: state.updates, policies: state.policies } }),
    useSysInfo: () => ({ data: { os: 'win32/win32', cpu: '', cores: 0, ramMB: 0, gpus: [] } }),
    useStatus: () => ({ data: undefined }),
    useBuild: () => ({
      start: { mutate: vi.fn(), isPending: false }, cancel: { mutate: vi.fn() },
      cuda: { mutate: vi.fn() }, installPrereq: { mutate: vi.fn() }, refresh: vi.fn(),
    }),
    useGitBranches: () => ({ data: undefined, isLoading: false, error: null }),
    useUpdatePolicyMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useEngineMutations: () => {
      const noop = { mutate: vi.fn(), isPending: false }
      return {
        add: { mutate: addMutate, isPending: false }, rename: noop, remove: noop, disableCustom: noop,
        purge: { mutate: purgeMutate, isPending: false }, forgetCustomSource: noop, activate: noop, reprobe: noop, start: noop, stop: noop, restart: noop,
      }
    },
    useBackendInstall: () => {
      const noop = { mutate: vi.fn(), isPending: false }
      return {
        backend: noop, mlx: noop, rapidMlx: noop, mlxVlm: noop, vllm: noop, sglang: noop, litertLm: noop,
        turboquant: noop, koboldcpp: noop, llamafile: noop, laya: noop,
        cancel: noop, remove: noop, enableBackend: noop,
        updateVllm: noop, updateSglang: noop, updateLitertLm: noop, updateMlx: noop, updateRapidMlx: noop,
        updateMlxVlm: noop, updateLaya: noop, updateTurboquant: noop, updateKoboldcpp: noop, updateLlamafile: noop, updateBackend: noop,
      }
    },
  }
})
vi.mock('../lib/link-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/link-queries')>()),
  useLinks: () => ({ data: [] }),
  useRemoteEngines: () => [],
}))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
  updateEngine: vi.fn().mockResolvedValue({ accepted: true }),
  getEngineUpdates: vi.fn(),
}))

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><EnginesScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const CARD = '.flex.flex-col.rounded-xl'
/** The Custom-card container for an engine name (the name also appears in the Running-now list). */
const customCardOf = (name: string): HTMLElement | undefined =>
  screen.queryAllByText(name)
    .map((el) => el.closest('div.px-4.py-3.rounded-xl') as HTMLElement | null)
    .find((el): el is HTMLElement => el !== null)
const cardOf = async (title: string) => (await screen.findByText(title, { selector: 'span' })).closest(CARD) as HTMLElement
async function openMenu(card: HTMLElement, label: string) {
  await userEvent.click(within(card).getByRole('button', { name: `Actions for ${label}` }))
  return await screen.findByRole('menu')
}

beforeEach(() => {
  vi.clearAllMocks()
  state.engines = []
  state.activeEngineId = ''
  state.customDisabled = []
  state.catalog = [PRISM_CATALOG]
  state.fits = [fitFor(PRISM_CATALOG)]
  state.updates = {}
  state.policies = {}
})

describe('catalogIdFor with release engines', () => {
  const cat = [{ id: 'prism', releaseEngineId: 'relA' }, { id: 'beellama', releaseEngineId: 'relB' }]

  it("returns the owning card's id for a release engine the card claims", () => {
    expect(catalogIdFor(engine({ id: 'relA', name: 'a', release: prismRelease('t') }), cat)).toBe('prism')
    expect(catalogIdFor(engine({ id: 'relB', name: 'b', release: { ...prismRelease('t'), repo: 'Anbeeld/beellama.cpp' } }), cat)).toBe('beellama')
  })

  it('returns custom for a release engine of a repo no card claims', () => {
    const fork = engine({ id: 'rel9', name: 'f', release: { ...prismRelease('t'), repo: 'someone/fork' } })
    expect(catalogIdFor(fork, cat)).toBe('custom')
  })

  it('N-2 coexistence 1: source build owns the card, so the release engine is custom', () => {
    expect(catalogIdFor(engine({ id: 'rel1', name: 'r', release: prismRelease('t') }), [{ id: 'prism' }])).toBe('custom')
  })

  it('N-2 coexistence 2: a second variant of the same repo is custom, the owned one is prism', () => {
    const owned = [{ id: 'prism', releaseEngineId: 'relA' }]
    expect(catalogIdFor(engine({ id: 'relB', name: 'b', release: prismRelease('t') }), owned)).toBe('custom')
    expect(catalogIdFor(engine({ id: 'relA', name: 'a', release: prismRelease('t') }), owned)).toBe('prism')
  })

  it('returns custom while the catalog has not loaded', () => {
    expect(catalogIdFor(engine({ id: 'rel1', name: 'r', release: prismRelease('t') }), undefined)).toBe('custom')
  })

  it('G-3: a release engine of ggml-org/llama.cpp never falls through to the llama.cpp card', () => {
    const rel = engine({ id: 'rel2', name: 'l', release: { ...prismRelease('t'), repo: 'ggml-org/llama.cpp' } })
    expect(catalogIdFor(rel, [{ id: 'llama.cpp' }])).toBe('custom')
    expect(catalogIdFor(engine({ id: 'plain', name: 'p', binPath: '/x/llama-server' }), [{ id: 'llama.cpp' }])).toBe('llama.cpp')
  })
})

describe('EnginesScreen: a catalog card that owns a release engine', () => {
  it('Prism not installed shows Install prebuilt and Build from source', async () => {
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).getByRole('button', { name: /Install prebuilt/ })).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Build from source/ })).toBeTruthy()
  })

  it('shows the Release badge and tag, no Install prebuilt, no Rebuild, and no separate Custom card', async () => {
    state.catalog = [PRISM_OWNED]
    state.fits = [fitFor(PRISM_OWNED)]
    state.engines = [PRISM_ENGINE]
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).getByText('Release')).toBeTruthy()
    expect(within(card).getByText('prism-b10770')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: /Install prebuilt/ })).toBeNull()
    const menu = await openMenu(card, 'Prism')
    expect(within(menu).queryByText(/Rebuild/)).toBeNull()
    expect(screen.queryByText('Custom')).toBeNull()
  })

  it('Delete names the registered engine and purges releaseEngineId', async () => {
    state.catalog = [PRISM_OWNED]
    state.fits = [fitFor(PRISM_OWNED)]
    state.engines = [PRISM_ENGINE]
    renderScreen()
    const menu = await openMenu(await cardOf('Prism'), 'Prism')
    await userEvent.click(within(menu).getByText('Delete'))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete Prism CUDA 13.3 (prism-b10770)?')).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(purgeMutate.mock.calls[0]?.[0]).toBe('relA')
  })

  it('hasUpdate gives Update now, which calls updateEngine(releaseEngineId) and no install endpoint', async () => {
    state.catalog = [PRISM_OWNED]
    state.fits = [fitFor(PRISM_OWNED)]
    state.engines = [PRISM_ENGINE]
    state.updates = { relA: { installed: 'prism-b10770', latest: 'prism-b10800', hasUpdate: true, checkedAt: '', comparable: true } }
    renderScreen()
    const menu = await openMenu(await cardOf('Prism'), 'Prism')
    await userEvent.click(within(menu).getByText('Update now'))
    await waitFor(() => expect(vi.mocked(updateEngine).mock.calls[0]?.[0]).toBe('relA'))
    expect(getEngineUpdates).not.toHaveBeenCalled()
  })

  it('a disabled release source shows Enable on the card (not a Custom card); Enable sends {name, binPath} only', async () => {
    state.catalog = [PRISM_DISABLED]
    state.fits = [fitFor(PRISM_DISABLED)]
    state.customDisabled = [DISABLED_SOURCE]
    renderScreen()
    const card = await cardOf('Prism')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    const menu = await openMenu(card, 'Prism')
    await userEvent.click(within(menu).getByText('Enable'))
    expect(addMutate.mock.calls[0]?.[0]).toEqual({ name: 'Prism CUDA 13.3 (prism-b10770)', binPath: PRISM_BIN })
  })

  it('N-2 coexistence 1: a release engine beside an owning source build is a Custom card; Prism is not marked Active', async () => {
    const srcOwned: CatalogEngine = { ...PRISM_CATALOG, installed: true, enabled: true, sourceBuilt: true, sourceEngineId: 'src1' }
    state.catalog = [srcOwned]
    state.fits = [fitFor(srcOwned)]
    state.engines = [
      engine({ id: 'src1', name: 'Prism src', binPath: '/e/build/prism/llama-server', sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp' }),
      engine({ id: 'rel1', name: 'Prism release', binPath: PRISM_BIN, release: prismRelease('prism-b10770') }),
    ]
    state.activeEngineId = 'rel1'
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).queryByText('Active')).toBeNull()
    expect(within(customCardOf('Prism release')!).getByText('Custom')).toBeTruthy()
  })

  it('N-2 coexistence 2: a second unclaimed variant is a Custom card with the Release badge; the owner stays unmarked', async () => {
    state.catalog = [PRISM_OWNED]
    state.fits = [fitFor(PRISM_OWNED)]
    state.engines = [PRISM_ENGINE, engine({ id: 'relB', name: 'Prism Vulkan', binPath: '/e/build/prism-vk/llama-server', release: prismRelease('prism-b10770') })]
    state.activeEngineId = 'relB'
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).queryByText('Active')).toBeNull()
    expect(within(customCardOf('Prism Vulkan')!).getByText('Release')).toBeTruthy()
  })

  it('the second catalog card keeps its own fields (BeeLlama is not claimed by Prism)', async () => {
    state.catalog = [PRISM_OWNED, BEE_CATALOG]
    state.fits = [fitFor(PRISM_OWNED), fitFor(BEE_CATALOG)]
    state.engines = [PRISM_ENGINE]
    renderScreen()
    const bee = await cardOf('BeeLlama')
    expect(within(bee).getByRole('button', { name: /Install prebuilt/ })).toBeTruthy()
  })

  it('B-13: cards offering Install prebuilt do not claim there is no install endpoint', async () => {
    state.catalog = [PRISM_CATALOG, BEE_CATALOG]
    state.fits = [fitFor(PRISM_CATALOG), fitFor(BEE_CATALOG)]
    renderScreen()
    for (const name of ['Prism', 'BeeLlama']) {
      const card = await cardOf(name)
      expect(within(card).getByRole('button', { name: /Install prebuilt/ })).toBeTruthy()
      expect(within(card).queryByText(/No install endpoint/)).toBeNull()
    }
  })
})
