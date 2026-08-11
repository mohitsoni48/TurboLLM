import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import PayoffStep from './PayoffStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'

// Component-level coverage for the agent-picker + settings-save-before-navigate ordering
// (bug #3 this session) that the CPU-only Docker E2E harness can partially exercise, but
// not the "did save() actually resolve before navigating" ordering itself — that needs
// mocked, controllable promises, not a real daemon round trip.

const settingsMock = vi.hoisted(() => ({ data: undefined as { code?: { defaultAgent: string } } | undefined }))
const statusMock = vi.hoisted(() => ({ data: undefined as { terminalAvailable?: boolean } | undefined }))
const saveMock = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn().mockResolvedValue(undefined) }))
const completeOnboardingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const navigateMock = vi.hoisted(() => vi.fn())
const createConversationMock = vi.hoisted(() => vi.fn())

vi.mock('../../../lib/queries', () => ({
  useSettings: () => ({ query: settingsMock, save: saveMock }),
  useStatus: () => statusMock,
}))
vi.mock('../../../lib/chat-api', () => ({ createConversation: createConversationMock }))
vi.mock('../../../lib/onboarding/useOnboardingMachine', () => ({
  useOnboardingMachine: () => ({ completeOnboarding: completeOnboardingMock }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }))

const baseCtx: OnboardingCtx = {
  profile: 'developer',
  downloadDone: true,
  isT0: false,
  recommendationKind: 'entry',
  expectedModelKey: null,
  expectedDownloadId: null,
  loadCompletedOnce: true,
}

function renderPayoff(ctx: Partial<OnboardingCtx> = {}) {
  render(<PayoffStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={{ ...baseCtx, ...ctx }} />)
}

describe('PayoffStep — Developer hands off to the real Code launchpad, never fabricates a session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    statusMock.data = { terminalAvailable: true }
  })

  it('defaults to claude when a terminal backend is available — the founder-requested default', () => {
    renderPayoff()
    expect(screen.getByLabelText('Coding agent')).toHaveValue('claude')
  })

  it('is hidden entirely when this install has no terminal backend (ADR-239) — falls back to turbollm silently', async () => {
    statusMock.data = { terminalAvailable: false }
    renderPayoff()
    expect(screen.queryByLabelText('Coding agent')).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/code'))
    // No agent picker shown → effectiveAgent falls back to the first offered agent
    // (turbollm) — never silently sends 'claude' to a session that can't launch it.
    expect(saveMock.mutateAsync).not.toHaveBeenCalled() // already 'turbollm', nothing to change
  })

  it('is not shown at all for non-Developer profiles', () => {
    renderPayoff({ profile: 'casual' })
    expect(screen.queryByLabelText('Coding agent')).toBeNull()
    expect(screen.getByRole('button', { name: 'Start chatting' })).toBeInTheDocument()
  })

  it('saves the picked agent as the server default BEFORE navigating to Code, only when it actually changed', async () => {
    // settingsQ starts at 'turbollm'; picker defaults to 'claude' → a real change.
    const user = userEvent.setup()
    renderPayoff()
    const callOrder: string[] = []
    saveMock.mutateAsync.mockImplementation(async () => { callOrder.push('save') })
    navigateMock.mockImplementation(() => { callOrder.push('navigate') })

    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalled())

    expect(saveMock.mutateAsync).toHaveBeenCalledWith({ code: { defaultAgent: 'claude' } })
    expect(callOrder).toEqual(['save', 'navigate'])
  })

  it('does NOT call save() when the picked agent already matches the server default', async () => {
    settingsMock.data = { code: { defaultAgent: 'claude' } } // already claude, matching the picker's default
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    expect(saveMock.mutateAsync).not.toHaveBeenCalled()
  })

  it('respects an explicit agent selection over the default', async () => {
    const user = userEvent.setup()
    renderPayoff()
    await user.selectOptions(screen.getByLabelText('Coding agent'), 'turbollm')
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    // Already 'turbollm' server-side (beforeEach default) — no save needed.
    expect(saveMock.mutateAsync).not.toHaveBeenCalled()
  })

  it('never creates a Code session itself — hands off to the real launchpad instead, no repo or task guessed', async () => {
    // The exact bug reported live: this step used to call createCodeSession({repoRoot:
    // '.', task: '<canned string>'}) directly, guessing a repo path and a task nobody
    // asked for. It must not call any session-creation API at all — only navigate to
    // the real picker.
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/code'))
    // No session id in the destination — CodeHomeScreen (no :sessionId) is the real
    // repo/model/task picker, not a pre-made session.
    expect(navigateMock).not.toHaveBeenCalledWith(expect.stringContaining('/workspace/code/'))
  })

  it('completes onboarding and navigates straight to the Code launchpad in one click — no intermediate "done" screen', async () => {
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/code'))
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1)
    // Order matters: onboarding is marked complete before navigating away.
    expect(completeOnboardingMock.mock.invocationCallOrder[0]).toBeLessThan(navigateMock.mock.invocationCallOrder[0])
  })

  it('never completes onboarding or navigates when saving the picked agent fails — stays put with a retryable error', async () => {
    saveMock.mutateAsync.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
    expect(completeOnboardingMock).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
  })
})

describe('PayoffStep — non-developer profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    statusMock.data = { terminalAvailable: true }
    createConversationMock.mockResolvedValue({ id: 'conv-1' })
  })

  it('completes onboarding and navigates straight to the new conversation in one click', async () => {
    const user = userEvent.setup()
    renderPayoff({ profile: 'casual' })
    await user.click(screen.getByRole('button', { name: 'Start chatting' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/chat/conv-1'))
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1)
  })

  it('exploring models or visiting the site also completes onboarding first', async () => {
    const user = userEvent.setup()
    renderPayoff({ profile: 'casual' })
    await user.click(screen.getByRole('button', { name: 'Explore models' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/models'))
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1)
  })
})
