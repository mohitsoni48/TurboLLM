// Two Engines-screen behaviours around engines that are on disk but not what they seem:
//  - "Delete" on a Disabled catalog card. Disable unregisters the engine, and the purge route only
//    deletes a REGISTERED engine's files, so the old Delete always failed with "Could not find the
//    installed … engine". A source-built card's build folder is deleted directly (DELETE
//    /engines/build), never re-registered first: that probed the binary, so a build that no longer
//    starts could not be deleted. Any other Disabled card says it must be enabled first instead.
//  - The global "<x> built and added" toast after a prereq install from the build guide (cmake,
//    git…), which streams through the same engineBuild channel but builds nothing.
//  - The card actions while a build from source runs: the daemon refuses an Enable, Disable or Delete
//    then, so they are disabled, but the menus (Rename, Auto-update) and Rebuild stay open; a CUDA
//    Toolkit download or a prereq install leaves them all open.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EnginesScreen } from './EnginesScreen'
import { ApiError } from '../lib/api'
import type { BackendInfo, CatalogEngine, Engine, EngineFit, EngineVariant } from '../lib/types'

const h = vi.hoisted(() => ({
  catalog: [] as unknown[],
  backends: [] as unknown[],
  engines: [] as unknown[],
  status: undefined as unknown,
  add: vi.fn(),
  purge: vi.fn(),
  deleteBuild: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  const noop = { mutate: vi.fn(), isPending: false }
  const fits = () =>
    (h.catalog as CatalogEngine[]).map((engine): EngineFit => ({ engine, variants: [VARIANT], compatible: [VARIANT], recommended: false }))
  return {
    ...actual,
    useEngines: () => ({ data: { engines: h.engines, activeEngineId: '', customDisabled: [] }, isError: false, refetch: vi.fn() }),
    useEngineBackends: () => ({ data: { backends: h.backends, gpus: [] } }),
    useEngineCatalog: () => ({ data: { engines: h.catalog }, isLoading: false, refetch: vi.fn() }),
    useEngineRecommendation: () => ({
      data: { hardware: { platform: 'linux', arch: 'x64', gpuVendor: 'nvidia', hasGpu: true, vramMb: 16000 }, recommendation: { recommended: null, fits: fits() } },
      isLoading: false,
    }),
    useEngineUpdates: () => ({ data: { updates: {}, policies: {} } }),
    useSysInfo: () => ({ data: { os: 'linux/x64', cpu: '', cores: 0, ramMB: 0, gpus: [] } }),
    useStatus: () => ({ data: h.status }),
    useBuild: () => ({ start: noop, cancel: noop, cuda: noop, installPrereq: noop, refresh: vi.fn() }),
    useGitBranches: () => ({ data: undefined, isLoading: false, error: null }),
    useUpdatePolicyMutation: () => noop,
    useEngineMutations: () => new Proxy({}, {
      get: (_t, k) =>
        k === 'add' ? { mutate: h.add, isPending: false }
          : k === 'purge' ? { mutate: h.purge, isPending: false }
            : k === 'deleteBuild' ? { mutate: h.deleteBuild, isPending: false }
              : noop,
    }),
    useBackendInstall: () => new Proxy({}, { get: () => noop }),
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
}))
vi.mock('../components/ui/sonner', () => ({
  toast: { success: (m: string) => h.toastSuccess(m), error: (m: string) => h.toastError(m), loading: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const VARIANT: EngineVariant = { id: 'v', label: 'default', repo: 'x', requires: {}, stability: 'stable', hasPrebuilt: true }

const VLLM_DISABLED: CatalogEngine = {
  id: 'vllm', name: 'vLLM', kind: 'vllm', description: '', provision: 'pip', homepage: 'https://github.com/vllm-project/vllm',
  platforms: ['linux'], support: 'stable', installEndpoint: '/api/v1/engines/vllm', supportedHere: true,
  installed: true, enabled: false,
}

const PRISM_DISABLED: CatalogEngine = {
  id: 'prism', name: 'Prism (llama.cpp fork)', kind: 'llama-server', description: '', provision: 'github-release',
  homepage: 'https://github.com/PrismML-Eng/llama.cpp', platforms: ['linux'], support: 'experimental',
  installEndpoint: '', supportedHere: true, installed: true, enabled: false, sourceBuilt: true, sourceBranch: 'prism',
  sourceBinPath: '/data/engines/build/prismml-eng-llama.cpp-prism/build/bin/llama-server',
}

const tree = () => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><EnginesScreen /></MemoryRouter>
  </QueryClientProvider>
)

beforeEach(() => {
  h.catalog = []
  h.backends = []
  h.engines = []
  h.status = undefined
  h.add.mockReset()
  h.purge.mockReset()
  h.deleteBuild.mockReset()
  h.toastSuccess.mockClear()
  h.toastError.mockClear()
})

describe('EnginesScreen — Delete on a Disabled catalog engine', () => {
  it('deletes a source-built engine\'s build folder directly, without re-registering (probing) it', async () => {
    h.catalog = [PRISM_DISABLED]
    h.deleteBuild.mockImplementation((_binPath, opts: { onSuccess: () => void }) => opts.onSuccess())
    render(tree())
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Prism (llama.cpp fork)' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(h.toastError).not.toHaveBeenCalled()
    expect(screen.getByText(PRISM_DISABLED.sourceBinPath!)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(h.deleteBuild.mock.calls.map((c) => c[0])).toEqual([PRISM_DISABLED.sourceBinPath])
    expect(h.add).not.toHaveBeenCalled()
    expect(h.purge).not.toHaveBeenCalled()
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Prism (llama.cpp fork) deleted'))
  })

  it('reports a refused build delete and registers nothing', async () => {
    h.catalog = [PRISM_DISABLED]
    h.deleteBuild.mockImplementation((_binPath, opts: { onError: (err: unknown) => void }) =>
      opts.onError(new ApiError('build_dir_taken', 'That build is in use by an engine — delete the engine instead.', 409)))
    render(tree())
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Prism (llama.cpp fork)' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('That build is in use by an engine — delete the engine instead.'))
    expect(h.add).not.toHaveBeenCalled()
    expect(h.toastSuccess).not.toHaveBeenCalled()
  })

  it('says to enable a Disabled pip engine first, rather than offering a Delete that cannot work', async () => {
    h.catalog = [VLLM_DISABLED]
    render(tree())
    await userEvent.click(screen.getByRole('button', { name: 'Actions for vLLM' }))
    const del = await screen.findByRole('menuitem', { name: 'Delete' })
    expect(del).toHaveAttribute('data-disabled')
    expect(screen.getByText('Enable it first to delete its files.')).toBeInTheDocument()
  })
})

describe('EnginesScreen — the build-settled toast', () => {
  const run = (active: boolean, phase: string, engine: string) => ({
    engine: { state: 'stopped' },
    engineBuild: { active, phase, engine, log: [], error: null },
  })

  it('does not claim a prereq install built an engine', () => {
    h.status = run(true, 'provisioning', 'cmake')
    const view = render(tree())
    h.status = run(false, 'done', 'cmake')
    view.rerender(tree())
    expect(h.toastSuccess).not.toHaveBeenCalled()
  })

  it('announces a real build the user named after a build tool', () => {
    h.status = { ...run(true, 'compiling', 'cmake'), engineBuild: { ...run(true, 'compiling', 'cmake').engineBuild, toolInstall: false } }
    const view = render(tree())
    h.status = { ...run(false, 'done', 'cmake'), engineBuild: { ...run(false, 'done', 'cmake').engineBuild, toolInstall: false } }
    view.rerender(tree())
    expect(h.toastSuccess).toHaveBeenCalledWith("cmake built and added — it's now your active engine.")
  })

  it('shows the error of a failed build the user named "CUDA Toolkit", but not of the CUDA Toolkit download', () => {
    const failed = (active: boolean, toolInstall: boolean) => ({
      engine: { state: 'stopped' },
      engineBuild: { active, phase: active ? 'compiling' : 'error', engine: 'CUDA Toolkit', log: [], error: active ? null : 'cmake exited with code 1', toolInstall },
    })
    h.status = failed(true, false)
    const view = render(tree())
    h.status = failed(false, false)
    view.rerender(tree())
    expect(h.toastError).toHaveBeenCalledWith('cmake exited with code 1')

    h.toastError.mockClear()
    h.status = failed(true, true)
    view.rerender(tree())
    h.status = failed(false, true)
    view.rerender(tree())
    expect(h.toastError).not.toHaveBeenCalled()
  })

  it('still announces a real build', () => {
    h.status = run(true, 'compiling', 'ik_llama.cpp')
    const view = render(tree())
    h.status = run(false, 'done', 'ik_llama.cpp')
    view.rerender(tree())
    expect(h.toastSuccess).toHaveBeenCalledWith("ik_llama.cpp built and added — it's now your active engine.")
  })
})

describe('EnginesScreen — card actions while engine work runs', () => {
  const LLAMA: CatalogEngine = {
    id: 'llama.cpp', name: 'llama.cpp', kind: 'llama-server', description: '', provision: 'github-release',
    homepage: 'https://github.com/ggml-org/llama.cpp', platforms: ['linux'], support: 'stable', installEndpoint: '',
    supportedHere: true, installed: true, enabled: true,
  }
  const CUDA_BACKEND: BackendInfo = { id: 'cuda', label: 'CUDA', installed: true, enabled: true, recommended: true, active: false, engineId: 'be' }
  // A registered engine no catalog card claims: its own card, with a visible Delete (a purge).
  const FORK: Engine = {
    id: 'fork', name: 'My fork', binPath: '/opt/fork/bin/llama-server', kind: 'llama-server', version: 'b1',
    capabilities: { kvTypes: [], flags: [] }, sourceRepo: 'https://github.com/me/fork',
  }
  const running = (engine: string, phase: string, toolInstall?: boolean) => ({
    engine: { state: 'stopped' },
    engineBuild: { active: true, phase, engine, log: [], error: null, toolInstall },
  })
  const off = (el: HTMLElement) => el.hasAttribute('data-disabled')
  // For each card and the backend row: which of their actions are disabled (true) and which are open.
  const actions = async () => {
    const button = (name: string) => screen.getByRole('button', { name })
    const fork = { disable: button('Disable').hasAttribute('disabled'), del: button('Delete').hasAttribute('disabled'),
      rebuild: button('Rebuild').hasAttribute('disabled'), menu: button('More actions for My fork').hasAttribute('disabled') }
    await userEvent.click(button('Actions for Prism (llama.cpp fork)'))
    const prism = { enable: off(await screen.findByRole('menuitem', { name: 'Enable' })),
      del: off(screen.getByRole('menuitem', { name: 'Delete' })), rebuild: off(screen.getByRole('menuitem', { name: /Rebuild/ })) }
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: /Manage GPU builds/ }))
    await userEvent.click(button('Actions for CUDA'))
    const cuda = { disable: off(await screen.findByRole('menuitem', { name: 'Disable' })),
      del: off(screen.getByRole('menuitem', { name: 'Delete' })),
      policy: off(screen.getByRole('menuitem', { name: 'Auto' })) }
    return { fork, prism, cuda }
  }

  it('disables Enable, Disable and Delete on the cards while a build from source runs, and keeps their menus open', async () => {
    h.catalog = [PRISM_DISABLED, LLAMA]
    h.backends = [CUDA_BACKEND]
    h.engines = [FORK]
    h.status = running('ik_llama.cpp', 'compiling')
    render(tree())
    expect(await actions()).toEqual({
      fork: { disable: true, del: true, rebuild: false, menu: false },
      prism: { enable: true, del: true, rebuild: false },
      cuda: { disable: true, del: true, policy: false },
    })
  })

  // A build's name is the user's to pick, and the tool installs' labels are ordinary words: a build named "cuda" was
  // taken for the build guide's CUDA install, so the actions stayed clickable and the daemon refused every click.
  it('disables them while a build from source the user named "cuda" runs, which the daemon says is no tool install', async () => {
    h.catalog = [PRISM_DISABLED, LLAMA]
    h.backends = [CUDA_BACKEND]
    h.engines = [FORK]
    h.status = running('cuda', 'compiling', false)
    render(tree())
    expect(await actions()).toEqual({
      fork: { disable: true, del: true, rebuild: false, menu: false },
      prism: { enable: true, del: true, rebuild: false },
      cuda: { disable: true, del: true, policy: false },
    })
  })

  for (const engine of ['CUDA Toolkit', 'cmake']) {
    it(`leaves them open during a ${engine} install, which the daemon lets them through`, async () => {
      h.catalog = [PRISM_DISABLED, LLAMA]
      h.backends = [CUDA_BACKEND]
      h.engines = [FORK]
      h.status = running(engine, 'provisioning')
      render(tree())
      expect(await actions()).toEqual({
        fork: { disable: false, del: false, rebuild: false, menu: false },
        prism: { enable: false, del: false, rebuild: false },
        cuda: { disable: false, del: false, policy: false },
      })
    })
  }
})
