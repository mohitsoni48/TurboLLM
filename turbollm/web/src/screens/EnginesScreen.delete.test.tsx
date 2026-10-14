// Two Engines-screen behaviours around engines that are on disk but not what they seem:
//  - "Delete" on a Disabled catalog card. Disable unregisters the engine, and the purge route only
//    deletes a REGISTERED engine's files, so the old Delete always failed with "Could not find the
//    installed … engine". A source-built card is re-registered the way its Enable does it, then
//    purged; any other Disabled card says it must be enabled first instead of failing.
//  - The global "<x> built and added" toast after a prereq install from the build guide (cmake,
//    git…), which streams through the same engineBuild channel but builds nothing.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EnginesScreen } from './EnginesScreen'
import type { CatalogEngine, EngineFit, EngineVariant } from '../lib/types'

const h = vi.hoisted(() => ({
  catalog: [] as unknown[],
  status: undefined as unknown,
  add: vi.fn(),
  purge: vi.fn(),
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
    useEngines: () => ({ data: { engines: [], activeEngineId: '', customDisabled: [] }, isError: false, refetch: vi.fn() }),
    useEngineBackends: () => ({ data: { backends: [] } }),
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
      get: (_t, k) => (k === 'add' ? { mutate: h.add, isPending: false } : k === 'purge' ? { mutate: h.purge, isPending: false } : noop),
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
  h.status = undefined
  h.add.mockReset()
  h.purge.mockReset()
  h.toastSuccess.mockClear()
  h.toastError.mockClear()
})

describe('EnginesScreen — Delete on a Disabled catalog engine', () => {
  it('re-registers a source-built engine the way Enable does, then purges it', async () => {
    h.catalog = [PRISM_DISABLED]
    h.add.mockImplementation((_input, opts: { onSuccess: (eng: { id: string }) => void }) => opts.onSuccess({ id: 'prism-1' }))
    h.purge.mockImplementation((_id, opts: { onSuccess: () => void }) => opts.onSuccess())
    render(tree())
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Prism (llama.cpp fork)' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(h.toastError).not.toHaveBeenCalled()
    expect(screen.getByText(PRISM_DISABLED.sourceBinPath!)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(h.add.mock.calls[0][0]).toEqual({
      binPath: PRISM_DISABLED.sourceBinPath,
      name: 'Prism (llama.cpp fork)',
      sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp',
      sourceBranch: 'prism',
      sourceCommit: undefined,
      sourcePatchUrl: undefined,
    })
    expect(h.purge.mock.calls[0][0]).toBe('prism-1')
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Prism (llama.cpp fork) deleted'))
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

  it('still announces a real build', () => {
    h.status = run(true, 'compiling', 'ik_llama.cpp')
    const view = render(tree())
    h.status = run(false, 'done', 'ik_llama.cpp')
    view.rerender(tree())
    expect(h.toastSuccess).toHaveBeenCalledWith("ik_llama.cpp built and added — it's now your active engine.")
  })
})
