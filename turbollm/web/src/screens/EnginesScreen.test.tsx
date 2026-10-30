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
import type { CatalogEngine, Engine, EngineFit, EngineVariant, Status } from '../lib/types'

const installLayaMutate = vi.fn()
const installLitertLmMutate = vi.fn()
const updateLitertLmMutate = vi.fn()
const updateMlxMutate = vi.fn()
const getEngineUpdatesMock = vi.fn()
const activateMutate = vi.fn()

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

const state: { engines: Engine[]; activeEngineId: string; catalog: CatalogEngine[]; fits: EngineFit[]; updates: Record<string, unknown>; policies: Record<string, string>; status?: Status; sys?: Record<string, unknown> } = {
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
    useSysInfo: () => ({ data: state.sys ?? { os: 'win32/win32', cpu: '', cores: 0, ramMB: 0, gpus: [] } }),
    useStatus: () => ({ data: state.status }),
    useBuild: () => ({
      start: { mutate: vi.fn(), isPending: false }, cancel: { mutate: vi.fn() },
      cuda: { mutate: vi.fn() }, installPrereq: { mutate: vi.fn() }, refresh: vi.fn(),
    }),
    useGitBranches: () => ({ data: undefined, isLoading: false, error: null }),
    useUpdatePolicyMutation: () => ({ mutate: vi.fn() }),
    useEngineMutations: () => {
      const noop = { mutate: vi.fn(), isPending: false }
      return { add: noop, rename: noop, remove: noop, disableCustom: noop, purge: noop, deleteBuild: noop, forgetCustomSource: noop, activate: { mutate: activateMutate, isPending: false }, reprobe: noop, start: noop, stop: noop, restart: noop }
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
        updateMlx: { mutate: updateMlxMutate, isPending: false }, updateRapidMlx: noop, updateMlxVlm: noop,
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
  state.status = undefined
  state.sys = undefined
  activateMutate.mockClear()
  installLayaMutate.mockClear()
  installLitertLmMutate.mockClear()
  updateLitertLmMutate.mockClear()
  updateMlxMutate.mockClear()
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

// The "Running now" selector lit the active engine's light, and the status card under it named the model, whenever the
// primary ran one, even when another engine ran it (an install or Enable activates an engine without stopping the
// model): the screen read as the selected engine running a model it never loaded.
describe('EnginesScreen — the engine running the model, when it is not the active one', () => {
  const runningOn = (servingId: string, servingName: string) => ({
    engine: { id: LLAMA_LIVE_ENGINE.id, name: 'llama.cpp', kind: 'llama-server', state: 'running', servingId, servingKind: 'litert-lm', servingName },
    model: { key: 'gemma', name: 'Gemma 3n', quant: null, ctx: 4096, vision: false },
    downloads: { active: 0 },
  }) as unknown as Status
  const selectorLight = () =>
    screen.getByText(/^(Running now|Selected engine)$/).closest('div')!.querySelector('button[aria-haspopup="menu"] [aria-label]')!.getAttribute('aria-label')

  it('leaves the active engine unlit and names the engine running the model', () => {
    state.engines = [LLAMA_LIVE_ENGINE]
    state.activeEngineId = LLAMA_LIVE_ENGINE.id
    state.status = runningOn('litert-1', 'LiteRT-LM')
    renderScreen()

    expect(selectorLight()).toBe('Stopped')
    expect(screen.getByText(/Gemma 3n — on LiteRT-LM/)).toBeTruthy()
  })

  // "Running now" over the selected engine's name read as that engine running the model, light off or not.
  it('captions the selector "Selected engine", not "Running now", while another engine runs the model', () => {
    state.engines = [LLAMA_LIVE_ENGINE]
    state.activeEngineId = LLAMA_LIVE_ENGINE.id
    state.status = runningOn('litert-1', 'LiteRT-LM')
    renderScreen()

    expect(screen.getByText('Selected engine')).toBeTruthy()
    expect(screen.queryByText('Running now')).toBeNull()
  })

  it('lights the active engine and names no other one while it runs the model itself', () => {
    state.engines = [LLAMA_LIVE_ENGINE]
    state.activeEngineId = LLAMA_LIVE_ENGINE.id
    state.status = runningOn(LLAMA_LIVE_ENGINE.id, 'llama.cpp')
    renderScreen()

    expect(selectorLight()).toBe('Running')
    expect(screen.getByText('Running now')).toBeTruthy()
    expect(screen.getByText('Gemma 3n')).toBeTruthy()
    expect(screen.queryByText(/ — on /)).toBeNull()
  })
})

// In the packaged Android app the LiteRT-LM card said ".litertlm models load on it automatically" and offered no "Use",
// though a model loads only on the engine the user selected: the selector, which read "litert-lm-android", was the only
// way to pick it.
describe('EnginesScreen — the Android app\'s built-in engines', () => {
  const LLAMA_ANDROID = engine({ id: 'llama-a', name: 'llama-server-android', kind: 'llama-server', binPath: '/data/app/lib/arm64/libllama_server.so' })
  const LITERT_ANDROID = engine({ id: 'litert-a', name: 'litert-lm-android', kind: 'litert-lm', binPath: '/data/app/lib/arm64/liblitertlm_server.so', version: '0.8.0' })
  const androidApp = () => {
    state.sys = { os: 'android/android', cpu: '', cores: 8, ramMB: 8000, gpus: [], bundledEnginesOnly: true }
    state.engines = [LLAMA_ANDROID, LITERT_ANDROID]
  }
  const card = (title: string) => screen.getByText(title, { selector: 'span.font-semibold' }).closest('div.rounded-xl') as HTMLElement

  it('offers Use on the LiteRT-LM card and says it runs .litertlm models once it is selected', async () => {
    androidApp()
    state.activeEngineId = LLAMA_ANDROID.id
    renderScreen()

    const litert = card('LiteRT-LM')
    expect(within(litert).getByText('Runs .litertlm models once it is selected')).toBeTruthy()
    expect(screen.queryByText(/load on it automatically/)).toBeNull()
    await userEvent.click(within(litert).getByRole('button', { name: 'Use' }))
    expect(activateMutate).toHaveBeenCalledWith(LITERT_ANDROID.id, expect.anything())
  })

  it('shows the LiteRT-LM card In use while it is the selected engine', () => {
    androidApp()
    state.activeEngineId = LITERT_ANDROID.id
    renderScreen()

    const litert = card('LiteRT-LM')
    expect((within(litert).getByRole('button', { name: 'In use' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(card('llama.cpp')).getByRole('button', { name: 'Use' })).toBeTruthy()
  })

  it('names the built-in engines in the selector, not by their registered names', async () => {
    androidApp()
    state.activeEngineId = LITERT_ANDROID.id
    renderScreen()

    const trigger = screen.getByText('Running now').closest('div')!.querySelector('button[aria-haspopup="menu"]')!
    expect(trigger.textContent).toContain('LiteRT-LM')
    expect(screen.getByText('LiteRT-LM · CPU · GPU')).toBeTruthy()
    await userEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('llama.cpp (CPU)')).toBeTruthy()
    expect(within(menu).getByText('LiteRT-LM')).toBeTruthy()
    expect(screen.queryByText(/litert-lm-android|llama-server-android/)).toBeNull()
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

// ── every OTHER engine keeps the historical "Check for update" behavior (PR #271 review) ──
// The honest live re-check is scoped to LiteRT-LM only: changing what the shared action does
// for vLLM/MLX/SGLang/KoboldCpp/llamafile/TurboQuant belongs in its own change with coverage
// for those engines. Their cards must keep firing the update POST (the re-provision), not
// the live GET /engines/updates?refresh=1.
const MLX_LIVE_ENGINE = engine({ id: 'mlx-1', name: 'MLX (mlx-lm 0.31.2)', kind: 'mlx' })

const MLX_CATALOG: CatalogEngine = {
  id: 'mlx', name: 'MLX', kind: 'mlx', description: 'Native Apple Silicon',
  provision: 'pip', homepage: 'https://github.com/ml-explore/mlx-lm',
  platforms: ['darwin'], support: 'stable',
  installEndpoint: '/api/v1/engines/mlx', supportedHere: true, installed: true, enabled: true,
}

const MLX_VARIANT: EngineVariant = {
  id: 'mlx-mac-arm64', label: 'macOS (Apple Silicon)', repo: 'ml-explore/mlx-lm',
  requires: { platform: ['darwin'], arch: ['arm64'] }, stability: 'stable', hasPrebuilt: true,
}

const MLX_FIT: EngineFit = {
  engine: MLX_CATALOG,
  variants: [MLX_VARIANT],
  compatible: [MLX_VARIANT],
  recommended: false,
}

describe('EnginesScreen — non-LiteRT engines keep the update POST from "Check for update"', () => {
  it('the MLX card fires its update mutation, never the live re-check', async () => {
    state.engines = [MLX_LIVE_ENGINE]
    state.activeEngineId = 'mlx-1'
    state.catalog = [MLX_CATALOG]
    state.fits = [MLX_FIT]
    state.updates = {}
    getEngineUpdatesMock.mockResolvedValue({ updates: {}, policies: {} })
    renderScreen()
    // 'MLX' alone is not unique (the "Running now" dropdown's group label is also 'MLX'),
    // so the card is located through its catalog description.
    const card = (await screen.findByText('Native Apple Silicon')).closest('.flex.flex-col.rounded-xl')!
    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Actions for MLX' }))
    const menu = await screen.findByRole('menu')
    await userEvent.click(within(menu).getByText('Check for update'))
    expect(updateMlxMutate).toHaveBeenCalled()
    expect(getEngineUpdatesMock).not.toHaveBeenCalled()
  })
})
