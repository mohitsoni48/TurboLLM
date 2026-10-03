// The Laya engine (huggingface.co/convaiinnovations/laya): wired into the catalog the same way
// rapid-mlx/sglang are, EXCEPT for one deliberate difference — it must never be offered as the
// "active" engine (a Laya model always loads on its own dedicated engine, whichever engine is
// active). This covers exactly that difference plus the catalog install wiring; everything else
// about the gallery predates this change and is covered elsewhere.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnginesScreen } from './EnginesScreen'
import type { CatalogEngine, Engine, EngineFit, EngineVariant } from '../lib/types'

const installLayaMutate = vi.fn()
const installLitertLmMutate = vi.fn()
const updateLitertLmMutate = vi.fn()
const getEngineUpdatesMock = vi.fn()

function engine(over: Partial<Engine> & { id: string; name: string }): Engine {
  return {
    binPath: '', version: '', capabilities: { kvTypes: [], flags: [] },
    ...over,
  }
}

const LAYA_LIVE_ENGINE = engine({ id: 'laya-1', name: 'Laya', kind: 'laya' })
const LLAMA_LIVE_ENGINE = engine({ id: 'llama-1', name: 'llama.cpp', kind: 'llama-server' })

const LAYA_CATALOG: CatalogEngine = {
  id: 'laya', name: 'Laya', kind: 'laya', description: 'Laya decision model',
  provision: 'pip', homepage: 'https://huggingface.co/convaiinnovations/laya',
  platforms: ['win32', 'darwin', 'linux'], support: 'stable',
  installEndpoint: '/api/v1/engines/laya', supportedHere: true, installed: false, enabled: false,
}

const LAYA_VARIANT: EngineVariant = {
  id: 'laya-default', label: 'Laya', repo: 'convaiinnovations/laya',
  requires: {}, stability: 'stable', hasPrebuilt: true,
}

const LAYA_FIT: EngineFit = {
  engine: LAYA_CATALOG,
  variants: [LAYA_VARIANT],
  compatible: [LAYA_VARIANT],
  recommended: false,
}

const state: { engines: Engine[]; activeEngineId: string; catalog: CatalogEngine[]; fits: EngineFit[]; updates: Record<string, unknown>; policies: Record<string, string> } = {
  engines: [], activeEngineId: '', catalog: [], fits: [], updates: {}, policies: {},
}

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useEngines: () => ({ data: { engines: state.engines, activeEngineId: state.activeEngineId, customDisabled: [] }, isError: false, refetch: vi.fn() }),
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
    useUpdatePolicyMutation: () => ({ mutate: vi.fn() }),
    useEngineMutations: () => {
      const noop = { mutate: vi.fn(), isPending: false }
      return { add: noop, rename: noop, remove: noop, disableCustom: noop, purge: noop, forgetCustomSource: noop, activate: noop, reprobe: noop, start: noop, stop: noop, restart: noop }
    },
    useBackendInstall: () => {
      const noop = { mutate: vi.fn(), isPending: false }
      return {
        backend: noop, mlx: noop, rapidMlx: noop, mlxVlm: noop, vllm: noop, sglang: noop, litertLm: noop,
        turboquant: noop, koboldcpp: noop, llamafile: noop,
        laya: { mutate: installLayaMutate, isPending: false },
        cancel: noop, remove: noop, enableBackend: noop,
        updateVllm: noop, updateSglang: noop,
        updateLitertLm: { mutate: updateLitertLmMutate, isPending: false },
        updateMlx: noop, updateRapidMlx: noop, updateMlxVlm: noop,
        updateLaya: noop, updateTurboquant: noop, updateKoboldcpp: noop, updateLlamafile: noop, updateBackend: noop,
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
  // Deferred through a closure so the hoisted vi.mock factory never touches the variable
  // before its const initialization (vitest hoists factories above every declaration).
  getEngineUpdates: (...args: Parameters<typeof getEngineUpdatesMock>) => getEngineUpdatesMock(...args),
}))

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><EnginesScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.engines = []
  state.activeEngineId = ''
  state.catalog = []
  state.fits = []
  state.updates = {}
  state.policies = {}
  installLayaMutate.mockClear()
  installLitertLmMutate.mockClear()
  updateLitertLmMutate.mockClear()
  getEngineUpdatesMock.mockReset()
})

describe('EnginesScreen — Laya is never offered as the active engine', () => {
  it('a registered Laya engine alone does not populate the "Running now" selector', () => {
    state.engines = [LAYA_LIVE_ENGINE]
    renderScreen()
    // Laya is the ONLY registered engine, so if it were offered here the selector would read
    // its group label ("Laya") instead of this empty-state copy.
    expect(screen.getByText('No engine installed')).toBeTruthy()
  })

  it('a registered Laya engine alongside a real one never appears as a pickable row', async () => {
    state.engines = [LLAMA_LIVE_ENGINE, LAYA_LIVE_ENGINE]
    state.activeEngineId = LLAMA_LIVE_ENGINE.id
    renderScreen()
    const trigger = screen.getByText('Running now').closest('div')!.querySelector('button[aria-haspopup="menu"]')!
    await userEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('llama.cpp')).toBeTruthy()
    expect(within(menu).queryByText('Laya')).toBeNull()
  })
})

describe('EnginesScreen — the Laya catalog card', () => {
  it('offers Install, wired to the laya install endpoint', async () => {
    state.catalog = [LAYA_CATALOG]
    state.fits = [LAYA_FIT]
    renderScreen()
    const card = (await screen.findByText('Laya')).closest('.flex.flex-col.rounded-xl')!
    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: /install/i }))
    expect(installLayaMutate).toHaveBeenCalled()
  })
})

// ── LiteRT-LM update actions ──────────────────────────────────────────────────
// "Check for update" must be a live status re-check (GET /engines/updates?refresh=1),
// never the update POST — that POST always lights the global "Downloading…" banner, which
// used to show for a no-op even when the engine was already at the latest release. Only a
// card that already knows an update exists fires the real update.
// Registry-style name (with the version suffix) so the "Running now" selector and the card
// title don't both read "LiteRT-LM" — findByText('LiteRT-LM') must stay unique to the card.
const LITERT_LIVE_ENGINE = engine({ id: 'litert-1', name: 'LiteRT-LM (litert-lm 0.17.1)', kind: 'litert-lm' })

const LITERT_CATALOG: CatalogEngine = {
  id: 'litert-lm', name: 'LiteRT-LM', kind: 'litert-lm', description: "Google's on-device LLM runtime",
  provision: 'pip', homepage: 'https://github.com/google-ai-edge/LiteRT-LM',
  platforms: ['win32', 'linux', 'darwin', 'android'], support: 'experimental',
  installEndpoint: '/api/v1/engines/litert-lm', supportedHere: true, installed: true, enabled: true,
}

const LITERT_VARIANT: EngineVariant = {
  id: 'litert-lm-win-x64', label: 'Windows (x64)', repo: 'google-ai-edge/LiteRT-LM',
  requires: { platform: ['win32'], arch: ['x64'] }, stability: 'experimental', hasPrebuilt: true,
}

const LITERT_FIT: EngineFit = {
  engine: LITERT_CATALOG,
  variants: [LITERT_VARIANT],
  compatible: [LITERT_VARIANT],
  recommended: false,
}

function latestStatus(hasUpdate: boolean) {
  return {
    installed: '0.17.1', latest: hasUpdate ? '0.18.0' : '0.17.1', hasUpdate,
    checkedAt: new Date().toISOString(), comparable: true,
  }
}

async function openLitertMenu() {
  const card = (await screen.findByText('LiteRT-LM')).closest('.flex.flex-col.rounded-xl')!
  await userEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Actions for LiteRT-LM' }))
  return await screen.findByRole('menu')
}

describe('EnginesScreen — LiteRT-LM check/update actions', () => {
  it('"Check for update" (no known update) does a live re-check, never the update POST', async () => {
    state.engines = [LITERT_LIVE_ENGINE]
    state.activeEngineId = 'litert-1'
    state.catalog = [LITERT_CATALOG]
    state.fits = [LITERT_FIT]
    state.updates = { 'litert-1': latestStatus(false) }
    getEngineUpdatesMock.mockResolvedValue({ updates: { 'litert-1': latestStatus(false) }, policies: {} })
    renderScreen()
    const menu = await openLitertMenu()
    await userEvent.click(within(menu).getByText('Check for update'))
    await vi.waitFor(() => expect(getEngineUpdatesMock).toHaveBeenCalledWith(true))
    expect(updateLitertLmMutate).not.toHaveBeenCalled()
  })

  it('"Update now" (a known update exists) fires the update mutation', async () => {
    state.engines = [LITERT_LIVE_ENGINE]
    state.activeEngineId = 'litert-1'
    state.catalog = [LITERT_CATALOG]
    state.fits = [LITERT_FIT]
    state.updates = { 'litert-1': latestStatus(true) }
    renderScreen()
    const menu = await openLitertMenu()
    await userEvent.click(within(menu).getByText('Update now'))
    expect(updateLitertLmMutate).toHaveBeenCalled()
    expect(getEngineUpdatesMock).not.toHaveBeenCalled()
  })
})
