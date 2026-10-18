// The worktree's base branch is sent as `worktreeBase`, and the daemon refuses a base the repo
// cannot resolve (base_unavailable) rather than branching off the current checkout. The launchpad
// kept the base of the previously picked repo whenever the new one had no branch to offer (a
// detached HEAD) or was on a branch of the same name, so a stock pick could be refused, with no
// way back to "current checkout" short of a reload. The base now resets with every repo pick.
//
// Same approach as CodeHomeScreen.sessionName.test.tsx: the REAL screen, with its heavy children
// and data hooks stubbed at their boundary, and a composer stub that hands back its props.
import { act, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  createCodeSessionMock.mockClear()
  latestComposer = null
})

const createCodeSessionMock = vi.fn().mockResolvedValue({ sessionId: 's1', convId: 'c1' })

vi.mock('../../lib/code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-api')>()
  return { ...actual, createCodeSession: (...args: unknown[]) => createCodeSessionMock(...args) }
})

// Each repo's branch info, as GET /fs/git-branch reports it (branch '' = detached HEAD), already
// read: a repo picked again answers from the query cache straight away.
const GIT: Record<string, { isRepo: true; branch: string; branches: string[] }> = {
  '/work/a': { isRepo: true, branch: 'feature', branches: ['feature', 'main'] },
  '/work/b': { isRepo: true, branch: '', branches: ['main'] },
  '/work/c': { isRepo: true, branch: 'feature', branches: ['feature'] },
}

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' }, model: { key: 'qwen3-8b', name: 'Qwen3 8B' } } }),
    useModels: () => ({ data: { models: [] } }),
    useShowAllEngineModels: () => false,
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useGitBranch: (path: string | null) => ({ data: path ? GIT[path] : undefined }),
  }
})

vi.mock('../../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/link-queries')>()
  return { ...actual, useLinks: () => ({ data: [] }), useRemoteModels: () => ({ data: [] }) }
})

vi.mock('../../lib/code-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-queries')>()
  return { ...actual, useCodeStats: () => ({ data: undefined }) }
})

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))
vi.mock('../chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('../engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('./CodeActivityHeatmap', () => ({ CodeActivityHeatmap: () => null }))

interface ComposerProps {
  onSubmit: () => void
  onValueChange: (value: string) => void
  repo: {
    onChoose: (path: string) => void
    onWorktreeChange: (v: boolean) => void
    baseBranch: string
    onBaseBranchChange: (v: string) => void
  }
}

let latestComposer: ComposerProps | null = null
vi.mock('./CodeComposer', () => ({
  CodeComposer: (props: ComposerProps) => {
    latestComposer = props
    return null
  },
}))

async function renderLaunchpad() {
  const { CodeHomeScreen } = await import('./CodeHomeScreen')
  render(<MemoryRouter><CodeHomeScreen /></MemoryRouter>)
  await waitFor(() => expect(latestComposer).not.toBeNull())
  act(() => {
    latestComposer!.onValueChange('Fix the login bug')
    latestComposer!.repo.onWorktreeChange(true)
  })
}

async function submittedBase(): Promise<unknown> {
  act(() => { latestComposer!.onSubmit() })
  await waitFor(() => expect(createCodeSessionMock).toHaveBeenCalledTimes(1))
  return createCodeSessionMock.mock.calls[0][0].worktreeBase
}

describe('CodeHomeScreen — worktree base branch', () => {
  it('defaults to the picked repo\'s checked-out branch', async () => {
    await renderLaunchpad()
    act(() => { latestComposer!.repo.onChoose('/work/a') })
    expect(latestComposer!.repo.baseBranch).toBe('feature')
    expect(await submittedBase()).toBe('feature')
  })

  it('a repo with a detached HEAD branches off its current checkout, not the last repo\'s branch', async () => {
    await renderLaunchpad()
    act(() => { latestComposer!.repo.onChoose('/work/a') })
    act(() => { latestComposer!.repo.onChoose('/work/b') })
    expect(latestComposer!.repo.baseBranch).toBe('')
    expect(await submittedBase()).toBe('')
  })

  it('a base picked for one repo does not carry over to the next, even on a branch of the same name', async () => {
    await renderLaunchpad()
    act(() => { latestComposer!.repo.onChoose('/work/a') })
    act(() => { latestComposer!.repo.onBaseBranchChange('main') })
    expect(latestComposer!.repo.baseBranch).toBe('main')
    act(() => { latestComposer!.repo.onChoose('/work/c') })
    expect(latestComposer!.repo.baseBranch).toBe('feature')
    expect(await submittedBase()).toBe('feature')
  })
})
