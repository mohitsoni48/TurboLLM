// GitHub #52 (b15hop): name a Code session when creating it, instead of living with the title cut
// from the first prompt. An optional "Session name" field on the launchpad is sent as `title`; left
// blank, nothing is sent and the session is named after the task exactly as before.
//
// Same approach as CodeHomeScreen.test.tsx: the REAL screen, with its heavy children and data hooks
// stubbed at their boundary. The composer stub also hands back its props, so a test can do what the
// composer does — pick a repo, type a task, submit — and observe the create call.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    useGitBranch: () => ({ data: undefined }),
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
  repo: { onChoose: (path: string) => void }
}

let latestComposer: ComposerProps | null = null
vi.mock('./CodeComposer', () => ({
  CodeComposer: (props: ComposerProps) => {
    latestComposer = props
    return null
  },
}))

async function renderLaunchpadReadyToSubmit() {
  const { CodeHomeScreen } = await import('./CodeHomeScreen')
  render(<MemoryRouter><CodeHomeScreen /></MemoryRouter>)
  await waitFor(() => expect(latestComposer).not.toBeNull())
  act(() => {
    latestComposer!.repo.onChoose('/work/repo')
    latestComposer!.onValueChange('Fix the login bug')
  })
}

function submit() {
  act(() => { latestComposer!.onSubmit() })
}

describe('CodeHomeScreen — optional session name', () => {
  it('sends the typed name as the session title, trimmed', async () => {
    await renderLaunchpadReadyToSubmit()

    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: '  Login fix  ' } })
    submit()

    await waitFor(() => expect(createCodeSessionMock).toHaveBeenCalledTimes(1))
    expect(createCodeSessionMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Login fix', task: 'Fix the login bug' }))
  })

  it('sends no title when the name is left blank, so the session is named after the task as before', async () => {
    await renderLaunchpadReadyToSubmit()

    submit()

    await waitFor(() => expect(createCodeSessionMock).toHaveBeenCalledTimes(1))
    expect(createCodeSessionMock.mock.calls[0][0].title).toBeUndefined()
  })

  it('sends no title when the name is only spaces', async () => {
    await renderLaunchpadReadyToSubmit()

    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: '   ' } })
    submit()

    await waitFor(() => expect(createCodeSessionMock).toHaveBeenCalledTimes(1))
    expect(createCodeSessionMock.mock.calls[0][0].title).toBeUndefined()
  })
})
