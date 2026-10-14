// Release card actions (issue #276, N-1 / N-4): a disabled release can be deleted from its card
// (forget the remembered source, THEN remove the dir), and "Check for update" on a release card
// only checks and reports: it never applies an update.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnginesScreen } from './EnginesScreen'
import { customSourceKey } from '../lib/engine-groups'
import { discardReleaseInstall, getEngineUpdates, updateEngine } from '../lib/api'
import { toast } from '../components/ui/sonner'
import type { CatalogEngine, CustomEngineSource, Engine, EngineFit, EngineVariant, ReleaseProvenance } from '../lib/types'

const calls: string[] = []
const purgeMutate = vi.fn()
const forgetMutate = vi.fn((key: string, opts?: { onSuccess?: () => void }) => {
  calls.push(`forget:${key}`)
  opts?.onSuccess?.()
})

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

const PRISM_BIN = '/e/build/PrismML-Eng-llama.cpp-win-cuda/llama-server'
const RELEASE: ReleaseProvenance = {
  repo: 'PrismML-Eng/llama.cpp', tag: 'prism-b10770', asset: 'llama-prism-prism-b10770-win-cuda.zip',
  assetKey: 'llama-prism-win-cuda.zip', publishedAt: '2026-10-08T00:00:00Z', prerelease: false, companions: [],
}
const PRISM_ENGINE = engine({ id: 'relA', name: 'Prism CUDA 13.3 (prism-b10770)', binPath: PRISM_BIN, release: RELEASE })
const PRISM_OWNED: CatalogEngine = {
  ...PRISM_CATALOG, installed: true, enabled: true, releaseEngineId: 'relA', release: RELEASE, releaseBinPath: PRISM_BIN,
}
const PRISM_DISABLED: CatalogEngine = {
  ...PRISM_CATALOG, installed: true, enabled: false, release: RELEASE, releaseBinPath: PRISM_BIN,
}
const SOURCE_BUILT: CatalogEngine = { ...PRISM_CATALOG, installed: true, enabled: true, sourceBuilt: true, sourceEngineId: 'src1' }
const DISABLED_SOURCE: CustomEngineSource = {
  name: 'Prism CUDA 13.3 (prism-b10770)', binPath: PRISM_BIN, addedAt: '2026-10-09T00:00:00Z', binPathExists: true,
}

const state: {
  engines: Engine[]; customDisabled: CustomEngineSource[]; catalog: CatalogEngine[]; fits: EngineFit[]
  updates: Record<string, unknown>
} = { engines: [], customDisabled: [], catalog: [], fits: [], updates: {} }

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useEngines: () => ({ data: { engines: state.engines, activeEngineId: '', customDisabled: state.customDisabled }, isError: false, refetch: vi.fn() }),
    useEngineBackends: () => ({ data: { backends: [] } }),
    useEngineCatalog: () => ({ data: { engines: state.catalog }, isLoading: false }),
    useEngineRecommendation: () => ({
      data: { hardware: { platform: 'win32', arch: 'x64', gpuVendor: 'nvidia', hasGpu: true, vramMb: 16000 }, recommendation: { recommended: null, fits: state.fits } },
      isLoading: false,
    }),
    useEngineUpdates: () => ({ data: { updates: state.updates, policies: {} } }),
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
        add: noop, rename: noop, remove: noop, disableCustom: noop, activate: noop, reprobe: noop, start: noop, stop: noop, restart: noop,
        purge: { mutate: purgeMutate, isPending: false },
        forgetCustomSource: { mutate: forgetMutate, isPending: false },
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
  discardReleaseInstall: vi.fn(),
}))
vi.mock('../components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }),
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
  (await screen.findByText(title, { selector: 'span' })).closest('.flex.flex-col.rounded-xl') as HTMLElement
async function openPrismMenu() {
  await userEvent.click(within(await cardOf('Prism')).getByRole('button', { name: 'Actions for Prism' }))
  return await screen.findByRole('menu')
}
async function confirmDelete() {
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
}

function showDisabledRelease() {
  state.catalog = [PRISM_DISABLED]
  state.fits = [fitFor(PRISM_DISABLED)]
  state.customDisabled = [DISABLED_SOURCE]
}
function showOwnedRelease() {
  state.catalog = [PRISM_OWNED]
  state.fits = [fitFor(PRISM_OWNED)]
  state.engines = [PRISM_ENGINE]
}
const status = (over: Record<string, unknown>) => ({
  installed: 'prism-b10770', latest: 'prism-b10770-6684606', hasUpdate: false, checkedAt: '', comparable: true, ...over,
})
const checkResult = (over: Record<string, unknown>) => ({ updates: { relA: status(over) }, policies: {} })

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  vi.mocked(discardReleaseInstall).mockImplementation(async (bin) => {
    calls.push(`discard:${bin}`)
    return { ok: true }
  })
  state.engines = []
  state.customDisabled = []
  state.catalog = [PRISM_CATALOG]
  state.fits = [fitFor(PRISM_CATALOG)]
  state.updates = {}
})

describe('N-1: deleting a disabled release engine from its card', () => {
  it('the menu offers Enable and Delete only, with no update actions', async () => {
    showDisabledRelease()
    renderScreen()
    const menu = await openPrismMenu()
    expect(within(menu).getByText('Enable')).toBeTruthy()
    expect(within(menu).getByText('Delete')).toBeTruthy()
    expect(within(menu).queryByText('Check for update')).toBeNull()
    expect(within(menu).queryByText('Update now')).toBeNull()
  })

  it('names the remembered engine and its path; confirming forgets it, THEN removes the dir, and never purges', async () => {
    showDisabledRelease()
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Delete'))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete Prism CUDA 13.3 (prism-b10770)?')).toBeTruthy()
    expect(within(dialog).getByText(PRISM_BIN)).toBeTruthy()
    await confirmDelete()
    await waitFor(() => expect(calls).toEqual([`forget:${customSourceKey(DISABLED_SOURCE)}`, `discard:${PRISM_BIN}`]))
    expect(purgeMutate).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Prism CUDA 13.3 (prism-b10770) deleted'))
  })

  it('when removing the files fails, says the engine was forgotten but its files remain', async () => {
    showDisabledRelease()
    vi.mocked(discardReleaseInstall).mockRejectedValue(new Error('EBUSY'))
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Delete'))
    await confirmDelete()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Prism CUDA 13.3 (prism-b10770) removed, but its files could not be deleted: EBUSY',
    ))
  })

  it('a stale catalog (no remembered source at that path) toasts and opens nothing', async () => {
    showDisabledRelease()
    state.customDisabled = []
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Delete'))
    expect(toast.error).toHaveBeenCalledWith("Could not find Prism's files — refresh the page.")
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('Could not find the installed'))
  })

  it('regression: Delete on an enabled release card still purges releaseEngineId', async () => {
    showOwnedRelease()
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Delete'))
    await confirmDelete()
    expect(purgeMutate.mock.calls[0]?.[0]).toBe('relA')
    expect(forgetMutate).not.toHaveBeenCalled()
  })

  it('regression: Delete on a source-built card is unchanged', async () => {
    state.catalog = [SOURCE_BUILT]
    state.fits = [fitFor(SOURCE_BUILT)]
    state.engines = [engine({ id: 'src1', name: 'Prism src', binPath: '/e/build/prism/llama-server' })]
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Delete'))
    await confirmDelete()
    expect(purgeMutate.mock.calls[0]?.[0]).toBe('src1')
  })
})

describe('Q9: one update slot shared by the gallery and the custom release cards', () => {
  it('an update started from a custom release card blocks every other Update button', async () => {
    const customRelease = (id: string) =>
      engine({ id, name: `Custom ${id}`, binPath: `/e/build/${id}/llama-server`, release: RELEASE })
    state.engines = [customRelease('relB'), customRelease('relC')]
    state.updates = { relB: status({ hasUpdate: true }), relC: status({ hasUpdate: true }) }
    vi.mocked(updateEngine).mockReturnValue(new Promise(() => {}))
    renderScreen()
    const updateButtons = await screen.findAllByRole('button', { name: /Update/ })
    expect(updateButtons).toHaveLength(2)

    await userEvent.click(updateButtons[0]!)

    await waitFor(() => expect(updateEngine).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateEngine).mock.calls[0]?.[0]).toBe('relB')
    await waitFor(() => expect((screen.getAllByRole('button', { name: /Update/ })[1] as HTMLButtonElement).disabled).toBe(true))
  })
})

describe('N-4: "Check for update" on an enabled release card is honest', () => {
  it('up to date: checks live, reports the tag, and never applies an update', async () => {
    showOwnedRelease()
    vi.mocked(getEngineUpdates).mockResolvedValue(checkResult({}))
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Check for update'))
    await waitFor(() => expect(getEngineUpdates).toHaveBeenCalledWith(true))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Prism is up to date (prism-b10770-6684606)', expect.anything()))
    expect(updateEngine).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('Updating'), expect.anything())
  })

  it('an update exists: says so (installed to latest) and still does not apply it', async () => {
    showOwnedRelease()
    vi.mocked(getEngineUpdates).mockResolvedValue(checkResult({ hasUpdate: true, installed: 'a', latest: 'b' }))
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Check for update'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Update available for Prism: a → b', expect.anything()))
    expect(updateEngine).not.toHaveBeenCalled()
  })

  it('rate limited: points at the GitHub token (a release source is GitHub)', async () => {
    showOwnedRelease()
    vi.mocked(getEngineUpdates).mockResolvedValue(checkResult({ error: 'rate_limited', latest: null, comparable: false }))
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Check for update'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('GitHub rate limit reached — add a token in Settings → GitHub'), expect.anything(),
    ))
  })

  it('no status for the engine: says it could not check, without the re-provision path', async () => {
    showOwnedRelease()
    vi.mocked(getEngineUpdates).mockResolvedValue({ updates: {}, policies: {} })
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Check for update'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not check Prism.', expect.anything()))
    expect(updateEngine).not.toHaveBeenCalled()
  })

  it('a known update: "Update now" calls updateEngine(releaseEngineId) exactly once', async () => {
    showOwnedRelease()
    state.updates = { relA: status({ hasUpdate: true, latest: 'prism-b10800' }) }
    renderScreen()
    await userEvent.click(within(await openPrismMenu()).getByText('Update now'))
    await waitFor(() => expect(updateEngine).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateEngine).mock.calls[0]?.[0]).toBe('relA')
    expect(getEngineUpdates).not.toHaveBeenCalled()
  })
})
