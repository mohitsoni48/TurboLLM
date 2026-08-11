import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import PayoffStep from './PayoffStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'

// Component-level coverage for the agent-picker + settings-save-before-navigate ordering
// (bug #3 this session) that the CPU-only Docker E2E harness can partially exercise, but
// not the "did save() actually resolve before navigating" ordering itself — that needs
// mocked, controllable promises, not a real daemon round trip.

const settingsMock = vi.hoisted(() => ({ data: undefined as { code?: { defaultAgent?: string } } | undefined }))
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

describe('PayoffStep — Developer coding-agent picker seeds from the real server default', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statusMock.data = { terminalAvailable: true }
  })

  it('defaults to claude on a fresh install with no stored agent preference yet — the founder-requested default', () => {
    settingsMock.data = { code: {} } // no defaultAgent recorded — genuinely fresh
    renderPayoff()
    expect(screen.getByLabelText('Coding agent')).toHaveValue('claude')
  })

  it('seeds from the actual stored preference on a returning install — does not always force claude', () => {
    // Found by an Opus release-review pass: the picker used to start hardcoded 'claude'
    // regardless of what the server already had, contradicting this file's own "never
    // clobbers a returning user's own preference" comment.
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    renderPayoff()
    expect(screen.getByLabelText('Coding agent')).toHaveValue('turbollm')
  })

  it('is hidden entirely when this install has no terminal backend (ADR-239) — falls back to turbollm silently', async () => {
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    statusMock.data = { terminalAvailable: false }
    renderPayoff()
    expect(screen.queryByLabelText('Coding agent')).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/code'))
    // No agent picker shown → effectiveAgent falls back to the first offered agent
    // (turbollm), which already matches the server default — nothing to save.
    expect(saveMock.mutateAsync).not.toHaveBeenCalled()
  })

  it('is not shown at all for non-Developer profiles', () => {
    settingsMock.data = { code: { defaultAgent: 'turbollm' } }
    renderPayoff({ profile: 'casual' })
    expect(screen.queryByLabelText('Coding agent')).toBeNull()
    expect(screen.getByRole('button', { name: 'Start chatting' })).toBeInTheDocument()
  })
})

describe('PayoffStep — Developer hands off to the real Code launchpad, never fabricates a session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statusMock.data = { terminalAvailable: true }
  })

  it('saves the seeded claude default as the server default BEFORE navigating, on a genuinely fresh install', async () => {
    settingsMock.data = { code: {} } // no defaultAgent yet → seeded 'claude' really is a change
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

  it('does NOT call save() when the seeded/stored agent already matches — no pointless write', async () => {
    settingsMock.data = { code: { defaultAgent: 'claude' } }
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    expect(saveMock.mutateAsync).not.toHaveBeenCalled()
  })

  it('respects an explicit agent selection over the seeded default, and saves it', async () => {
    settingsMock.data = { code: { defaultAgent: 'claude' } } // seeds picker to 'claude'
    const user = userEvent.setup()
    renderPayoff()
    expect(screen.getByLabelText('Coding agent')).toHaveValue('claude')
    await user.selectOptions(screen.getByLabelText('Coding agent'), 'turbollm')
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalled())
    expect(saveMock.mutateAsync).toHaveBeenCalledWith({ code: { defaultAgent: 'turbollm' } })
  })

  it('never creates a Code session itself — hands off to the real launchpad instead, no repo or task guessed', async () => {
    // The exact bug reported live: this step used to call createCodeSession({repoRoot:
    // '.', task: '<canned string>'}) directly, guessing a repo path and a task nobody
    // asked for. It must not call any session-creation API at all — only navigate to
    // the real picker.
    settingsMock.data = { code: { defaultAgent: 'claude' } }
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/code'))
    // No session id in the destination — CodeHomeScreen (no :sessionId) is the real
    // repo/model/task picker, not a pre-made session.
    expect(navigateMock).not.toHaveBeenCalledWith(expect.stringContaining('/workspace/code/'))
  })

  it('completes onboarding and navigates straight to the Code launchpad in one click — no intermediate "done" screen', async () => {
    settingsMock.data = { code: { defaultAgent: 'claude' } }
    const user = userEvent.setup()
    renderPayoff()
    await user.click(screen.getByRole('button', { name: 'Open Code' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/workspace/code'))
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1)
    // Order matters: onboarding is marked complete before navigating away.
    expect(completeOnboardingMock.mock.invocationCallOrder[0]).toBeLessThan(navigateMock.mock.invocationCallOrder[0])
  })

  it('never completes onboarding or navigates when saving the picked agent fails — stays put with a retryable error', async () => {
    settingsMock.data = { code: {} } // no defaultAgent yet → save is attempted
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

  it('exploring models completes onboarding first, then navigates', async () => {
    const user = userEvent.setup()
    renderPayoff({ profile: 'casual' })
    await user.click(screen.getByRole('button', { name: 'Explore models' }))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/models'))
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an error rather than silently no-opping when completing onboarding fails', async () => {
    // Found by an Opus release-review pass: this and "Visit turbollm.dev" had no error
    // handling at all — a rejected completeOnboarding() was an unhandled rejection and a
    // button that silently did nothing. Fresh render (not reusing the success-path
    // instance above) — the in-flight guard never resets after a successful click, same as
    // the primary "start" button's own `startedRef`, since a successful click normally
    // navigates the component away entirely.
    completeOnboardingMock.mockRejectedValueOnce(new Error('boom'))
    const user = userEvent.setup()
    renderPayoff({ profile: 'casual' })
    await user.click(screen.getByRole('button', { name: 'Explore models' }))
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('visiting the site opens the tab synchronously — before completeOnboarding is even called — so it is never popup-blocked', async () => {
    // Found by an Opus release-review pass: `window.open` only survives the popup blocker
    // inside the synchronous task derived from the click gesture — calling it AFTER an
    // `await completeOnboarding()` loses that gesture and gets silently blocked. This
    // regressed working behavior from the deleted DoneStep, which opened the tab
    // synchronously. Captured directly inside window.open's own mock (not via a shared
    // array racing an async boundary) — how many times completeOnboarding has been called
    // AT THE INSTANT open() runs is the real proof of ordering.
    let completeCallsWhenOpened = -1
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => {
      completeCallsWhenOpened = completeOnboardingMock.mock.calls.length
      return null
    })

    const user = userEvent.setup()
    renderPayoff({ profile: 'casual' })
    await user.click(screen.getByRole('button', { name: 'Visit turbollm.dev' }))

    expect(openMock).toHaveBeenCalledWith('https://turbollm.dev', '_blank', 'noopener,noreferrer')
    expect(completeCallsWhenOpened).toBe(0)
    await waitFor(() => expect(completeOnboardingMock).toHaveBeenCalledTimes(1))
    openMock.mockRestore()
  })
})
