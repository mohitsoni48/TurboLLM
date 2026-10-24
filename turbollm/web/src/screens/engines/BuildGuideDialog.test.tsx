import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildGuideDialog } from './BuildGuideDialog'

// useStatus is driven by hand so a test can step engineBuild through a run: `push()` swaps the
// status the dialog sees (and when it was fetched) and re-renders every subscriber.
const h = vi.hoisted(() => ({
  status: null as unknown,
  dataUpdatedAt: 0,
  prereqRefetch: vi.fn(),
  installMutate: vi.fn(),
  listeners: new Set<() => void>(),
}))

vi.mock('../../lib/queries', async (importOriginal) => {
  const React = await import('react')
  return {
    ...(await importOriginal<typeof import('../../lib/queries')>()),
    useStatus: () => {
      const [, force] = React.useReducer((x: number) => x + 1, 0)
      React.useEffect(() => {
        h.listeners.add(force)
        return () => void h.listeners.delete(force)
      }, [])
      return { data: h.status, dataUpdatedAt: h.dataUpdatedAt }
    },
    useBuildPrereqs: () => ({
      isLoading: false,
      isFetching: false,
      refetch: h.prereqRefetch,
      data: {
        supported: true,
        os: 'linux',
        packageManager: 'apt-get',
        tools: [
          { id: 'git', name: 'Git', found: true, installUrl: 'x' },
          { id: 'cmake', name: 'CMake', found: false, installUrl: 'x', installCommands: [['apt-get', 'install', 'cmake']] },
          { id: 'cuda', name: 'CUDA', found: true, installUrl: 'x' },
        ],
      },
    }),
    useSettings: () => ({ query: { data: { build: { toolchainDirs: [] } }, refetch: vi.fn() }, save: { isPending: false, mutateAsync: vi.fn() } }),
    useBuild: () => ({
      start: { mutate: vi.fn() },
      cancel: { mutate: vi.fn() },
      cuda: { mutate: vi.fn() },
      installPrereq: { mutate: h.installMutate },
      refresh: vi.fn(),
    }),
    useSysInfo: () => ({ data: { os: 'linux' } }),
  }
})
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))
vi.mock('./AddEngineDialog', () => ({ AddEngineDialog: () => null }))

const build = (active: boolean, phase: string, engine: string, error: string | null = null) => ({
  engineBuild: { active, phase, engine, log: [`${engine} log`], error },
})

function push(status: unknown, at = Date.now()) {
  h.status = status
  h.dataUpdatedAt = at
  act(() => h.listeners.forEach((f) => f()))
}

function renderDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BuildGuideDialog open onOpenChange={() => {}} repoUrl="https://github.com/a/b" engineName="x" />
    </QueryClientProvider>,
  )
}

describe('BuildGuideDialog — a new run vs the previous run’s finished state', () => {
  beforeEach(() => {
    h.prereqRefetch.mockReset()
    h.installMutate.mockReset()
    // A git install already finished earlier: engineBuild keeps its terminal record.
    h.status = build(false, 'done', 'git')
    h.dataUpdatedAt = 1
  })

  it('does not take the last install’s "done" as the new one’s, and tracks the new run to its end', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /Install \(apt-get\)/ }))
    expect(h.installMutate).toHaveBeenCalledWith('cmake', expect.anything())
    // The cmake install hasn't even started — the stale "done" must not count as its result.
    expect(h.prereqRefetch).not.toHaveBeenCalled()
    expect(screen.queryByText('git log')).not.toBeInTheDocument()

    push(build(true, 'provisioning', 'cmake'))
    expect(screen.getByText('Installing cmake with your package manager…')).toBeInTheDocument()

    push(build(false, 'done', 'cmake'))
    expect(h.prereqRefetch).toHaveBeenCalledTimes(1)
  })

  it('still settles a run that finished between two polls (never seen active)', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /Install \(apt-get\)/ }))
    const [, opts] = h.installMutate.mock.calls[0] as [string, { onSuccess: () => void }]
    act(() => opts.onSuccess())
    // The next status fetched after the server accepted the request shows it already failed.
    push(build(false, 'error', 'cmake', 'Could not install cmake: boom'), Date.now() + 1000)
    expect(screen.getByText('Could not install cmake: boom')).toBeInTheDocument()
  })
})
