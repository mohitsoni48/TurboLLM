// "Install prebuilt" on the Prism/BeeLlama cards, and the release-aware Custom card (issue #276):
// a release engine that no catalog card owns (a fork with no releaseInstall entry, or a second
// variant of the same repo) shows its tag, a Release badge, Update and the update policy.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnginesScreen } from './EnginesScreen'
import { listReleaseAssets, track, updateEngine } from '../lib/api'
import type { CatalogEngine, Engine, EngineFit, EngineVariant } from '../lib/types'

const setPolicyMutate = vi.fn()

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
const fitFor = (catalog: CatalogEngine): EngineFit => ({
  engine: catalog, variants: [PRISM_VARIANT], compatible: [PRISM_VARIANT], recommended: false,
})

const RELEASE = {
  repo: 'someone/fork', tag: 'fork-b1', asset: 'fork-b1-win.zip', assetKey: 'fork-win.zip',
  publishedAt: '2026-10-01T00:00:00Z', prerelease: false, companions: [],
}
const RELEASE_ENGINE = engine({
  id: 'rel1', name: 'Fork CUDA (fork-b1)', binPath: '/e/build/someone-fork/llama-server',
  version: 'zzz-version', release: RELEASE,
})
const PLAIN_CUSTOM = engine({ id: 'c1', name: 'My fork', binPath: '/e/build/myfork/llama-server', version: 'b42' })

const state: {
  engines: Engine[]; catalog: CatalogEngine[]; fits: EngineFit[]
  updates: Record<string, unknown>; policies: Record<string, string>
} = { engines: [], catalog: [], fits: [], updates: {}, policies: {} }

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useEngines: () => ({ data: { engines: state.engines, activeEngineId: '', customDisabled: [] }, isError: false, refetch: vi.fn() }),
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
    useUpdatePolicyMutation: () => ({ mutate: setPolicyMutate, isPending: false }),
    useEngineMutations: () => {
      const noop = { mutate: vi.fn(), isPending: false }
      return { add: noop, rename: noop, remove: noop, disableCustom: noop, purge: noop, forgetCustomSource: noop, activate: noop, reprobe: noop, start: noop, stop: noop, restart: noop }
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
  listReleaseAssets: vi.fn().mockResolvedValue({
    repo: 'PrismML-Eng/llama.cpp', tag: 'prism-b1', publishedAt: '', prerelease: false, fellBack: false, assets: [],
  }),
}))

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><EnginesScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const cardOf = async (title: string) =>
  (await screen.findByText(title)).closest('.flex.flex-col.rounded-xl, .flex.flex-wrap.items-center.justify-between') as HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  state.engines = []
  state.catalog = [PRISM_CATALOG]
  state.fits = [fitFor(PRISM_CATALOG)]
  state.updates = {}
  state.policies = {}
})

describe('EnginesScreen: Install prebuilt', () => {
  it('an uninstalled Prism card offers both Install prebuilt and Build from source', async () => {
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).getByRole('button', { name: /Install prebuilt/ })).toBeTruthy()
    expect(within(card).getByRole('button', { name: /Build from source/ })).toBeTruthy()
  })

  it('Install prebuilt opens the dialog on the release step for the card repo', async () => {
    renderScreen()
    const card = await cardOf('Prism')
    await userEvent.click(within(card).getByRole('button', { name: /Install prebuilt/ }))
    expect(track).toHaveBeenCalledWith('engines', 'install_prebuilt_from_card')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Install from a GitHub release')).toBeTruthy()
    await waitFor(() => expect(listReleaseAssets).toHaveBeenCalledWith('PrismML-Eng/llama.cpp'))
  })

  it('an installed Prism card shows no Install prebuilt', async () => {
    const installed = { ...PRISM_CATALOG, installed: true, enabled: true }
    state.catalog = [installed]
    state.fits = [fitFor(installed)]
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).queryByRole('button', { name: /Install prebuilt/ })).toBeNull()
  })

  it('an incompatible card shows no Install prebuilt', async () => {
    state.fits = [{ ...fitFor(PRISM_CATALOG), compatible: [], incompatibleReason: 'No GPU' } as EngineFit]
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).queryByRole('button', { name: /Install prebuilt/ })).toBeNull()
  })

  it('a catalog entry without releaseInstall has no Install prebuilt', async () => {
    const plain = { ...PRISM_CATALOG, releaseInstall: undefined }
    state.catalog = [plain]
    state.fits = [fitFor(plain)]
    renderScreen()
    const card = await cardOf('Prism')
    expect(within(card).queryByRole('button', { name: /Install prebuilt/ })).toBeNull()
  })
})

describe('EnginesScreen: the release-aware Custom card', () => {
  it('shows a Release badge and the tag in place of the version', async () => {
    state.engines = [RELEASE_ENGINE]
    renderScreen()
    const card = await cardOf('Fork CUDA (fork-b1)')
    expect(within(card).getByText('Custom')).toBeTruthy()
    expect(within(card).getByText('Release')).toBeTruthy()
    expect(within(card).getByText('fork-b1')).toBeTruthy()
    expect(within(card).queryByText('zzz-version')).toBeNull()
  })

  it('hasUpdate shows Update, which calls updateEngine(id)', async () => {
    state.engines = [RELEASE_ENGINE]
    state.updates = { rel1: { installed: 'fork-b1', latest: 'fork-b2', hasUpdate: true, checkedAt: '', comparable: true } }
    renderScreen()
    const card = await cardOf('Fork CUDA (fork-b1)')
    await userEvent.click(within(card).getByRole('button', { name: /Update/ }))
    await waitFor(() => expect(vi.mocked(updateEngine).mock.calls[0]?.[0]).toBe('rel1'))
    expect(track).toHaveBeenCalledWith('engines', 'update_release_engine')
  })

  it('no update means no Update button', async () => {
    state.engines = [RELEASE_ENGINE]
    state.updates = { rel1: { installed: 'fork-b1', latest: 'fork-b1', hasUpdate: false, checkedAt: '', comparable: true } }
    renderScreen()
    const card = await cardOf('Fork CUDA (fork-b1)')
    expect(within(card).queryByRole('button', { name: /^Update/ })).toBeNull()
  })

  it('the menu carries the update-policy items; the default is Notify and Auto sets the policy', async () => {
    state.engines = [RELEASE_ENGINE]
    renderScreen()
    const card = await cardOf('Fork CUDA (fork-b1)')
    await userEvent.click(within(card).getByRole('button', { name: 'More actions for Fork CUDA (fork-b1)' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Off')).toBeTruthy()
    expect(within(menu).getByText('Notify')).toBeTruthy()
    await userEvent.click(within(menu).getByText('Auto'))
    expect(setPolicyMutate.mock.calls[0]?.[0]).toEqual({ id: 'rel1', policy: 'auto' })
  })

  it('a custom engine with no release is unchanged: no Release badge, no policy items, shows its version', async () => {
    state.engines = [PLAIN_CUSTOM]
    renderScreen()
    const card = await cardOf('My fork')
    expect(within(card).getByText('Custom')).toBeTruthy()
    expect(within(card).queryByText('Release')).toBeNull()
    expect(within(card).getByText('b42')).toBeTruthy()
    await userEvent.click(within(card).getByRole('button', { name: 'More actions for My fork' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByText('Notify')).toBeNull()
  })
})
