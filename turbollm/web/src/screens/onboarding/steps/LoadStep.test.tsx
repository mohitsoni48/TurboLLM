import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import LoadStep from './LoadStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'

// Component-level coverage for the load-failure RECOVERY path.
//
// Two things are pinned here, and both were found the hard way:
//
// 1. Retry must actually re-issue the load. A 2026-08-21 review raised the
//    theory that the duplicate-load guard (`ctx.expectedModelKey === matchedEntry.key`)
//    also fires on a retry, making the button a no-op. It does not — the ONLY
//    writer of `loadFailed` is the `.catch()` of the very `loadModel()` call
//    that guard skips, so the failure screen is unreachable whenever the guard
//    is active. That argument is subtle enough to be worth an executable test
//    rather than a comment, because reading the file alone produced the wrong
//    answer once already.
//
// 2. `onboarding_recovery` must report the OUTCOME of the retry, never the
//    click. An earlier draft reported success the moment the request was
//    accepted, which would have made the event a near-constant 'ok' — exactly
//    the class of defect the telemetry audit existed to remove.

const downloadsMock = vi.hoisted(() => ({ data: undefined as { downloads: unknown[] } | undefined, isSuccess: true }))
const modelsMock = vi.hoisted(() => ({ data: undefined as { models: unknown[] } | undefined }))
const statusMock = vi.hoisted(() => ({ data: undefined as { model?: { key: string } | null } | undefined, isSuccess: true }))
const resumeMock = vi.hoisted(() => ({ isPending: false, mutate: vi.fn() }))
const loadModelMock = vi.hoisted(() => vi.fn())
const trackMock = vi.hoisted(() => vi.fn())
const trackRecoveryMock = vi.hoisted(() => vi.fn())
const trackRecoveryTextMock = vi.hoisted(() => vi.fn())
const advanceMock = vi.hoisted(() => vi.fn())
const patchCtxMock = vi.hoisted(() => vi.fn())

vi.mock('../../../lib/queries', () => ({
  useDownloads: () => downloadsMock,
  useModels: () => modelsMock,
  useStatus: () => statusMock,
  useDownloadMutations: () => ({ resume: resumeMock }),
}))
vi.mock('../../../lib/api', () => ({
  loadModel: loadModelMock,
  track: trackMock,
  trackRecovery: trackRecoveryMock,
  trackRecoveryText: trackRecoveryTextMock,
}))
vi.mock('../../../lib/onboarding/useOnboardingMachine', () => ({
  useOnboardingMachine: () => ({ advance: advanceMock, patchCtx: patchCtxMock, goToStep: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const MODEL_KEY = 'llama-3-8b-q4'
const MODEL_FILE = 'llama-3-8b-q4.gguf'
const MODEL_PATH = `C:/models/${MODEL_FILE}`

/** A finished download whose `dest` matches the scanned model below, which is what
 *  makes `matchedEntry` resolve and the load effect fire at all. */
function finishedDownload(over: Record<string, unknown> = {}) {
  return { id: 'dl-1', status: 'done', dest: MODEL_PATH, createdAt: '2026-08-20T10:00:00.000Z', received: 100, total: 100, error: null, ...over }
}

const baseCtx: OnboardingCtx = {
  profile: 'developer',
  downloadDone: true,
  isT0: false,
  recommendationKind: 'entry',
  // null on purpose: this is the ONLY state in which the failure screen is
  // reachable, because a set `expectedModelKey` matching the download means
  // ModelStep already loaded it successfully before navigating here.
  expectedModelKey: null,
  expectedDownloadId: null,
  loadCompletedOnce: false,
} as OnboardingCtx

function renderStep(ctx: Partial<OnboardingCtx> = {}) {
  return render(<LoadStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={{ ...baseCtx, ...ctx }} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  downloadsMock.data = { downloads: [finishedDownload()] }
  downloadsMock.isSuccess = true
  modelsMock.data = { models: [{ key: MODEL_KEY, name: MODEL_FILE, path: MODEL_PATH }] }
  statusMock.data = { model: null }
  statusMock.isSuccess = true
  resumeMock.isPending = false
})

describe('LoadStep recovery', () => {
  it('shows the failure screen when the load rejects', async () => {
    loadModelMock.mockRejectedValueOnce(new Error('engine exited'))
    renderStep()
    expect(await screen.findByText(/didn't finish/i)).toBeTruthy()
    expect(loadModelMock).toHaveBeenCalledWith(MODEL_KEY)
  })

  it('Retry re-issues the load — the duplicate-load guard must not swallow it', async () => {
    loadModelMock.mockRejectedValueOnce(new Error('engine exited'))
    renderStep()
    await screen.findByText(/didn't finish/i)
    expect(loadModelMock).toHaveBeenCalledTimes(1)

    loadModelMock.mockResolvedValueOnce(undefined)
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(loadModelMock).toHaveBeenCalledTimes(2))
    expect(loadModelMock).toHaveBeenLastCalledWith(MODEL_KEY)
  })

  it('reports onboarding_recovery ok only once the model actually comes up', async () => {
    loadModelMock.mockRejectedValueOnce(new Error('engine exited'))
    const { rerender } = renderStep()
    await screen.findByText(/didn't finish/i)

    loadModelMock.mockResolvedValueOnce(undefined)
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    // The click alone proves nothing — the remedy has not been judged yet.
    expect(trackRecoveryMock).not.toHaveBeenCalled()

    // Now the daemon reports the expected model loaded.
    statusMock.data = { model: { key: MODEL_KEY } }
    rerender(<LoadStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={baseCtx} />)

    await waitFor(() => expect(trackRecoveryMock).toHaveBeenCalledTimes(1))
    expect(trackRecoveryMock).toHaveBeenCalledWith('other', 'retry', 'ok')
  })

  it('reports onboarding_recovery fail when the retry fails again', async () => {
    loadModelMock.mockRejectedValueOnce(new Error('engine exited'))
    renderStep()
    await screen.findByText(/didn't finish/i)

    loadModelMock.mockRejectedValueOnce(new Error('engine exited again'))
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(trackRecoveryMock).toHaveBeenCalledTimes(1))
    expect(trackRecoveryMock).toHaveBeenCalledWith('other', 'retry', 'fail')
  })

  it('reports nothing when no recovery was attempted, and the settle effect is what suppresses it', async () => {
    // Not vacuous: this fails if the settle effect ever reports without a pending
    // attempt, which is the shape of the bug where a plain successful load would
    // manufacture a recovery row.
    loadModelMock.mockResolvedValueOnce(undefined)
    statusMock.data = { model: { key: MODEL_KEY } }
    renderStep()
    await waitFor(() => expect(advanceMock).toHaveBeenCalled())
    expect(trackRecoveryMock).not.toHaveBeenCalled()
    expect(trackRecoveryTextMock).not.toHaveBeenCalled()
  })

  it('reports a download resume that finishes between polls, never having shown an intermediate status', async () => {
    // useDownloads stops polling at 'done', so a fast resume can go error -> done
    // with nothing observed in between. Gating success on first seeing the record
    // leave 'error' dropped exactly the fastest successful retries.
    downloadsMock.data = { downloads: [finishedDownload({ status: 'error', error: '404 fetching release asset' })] }
    modelsMock.data = { models: [] }
    const { rerender } = renderStep()

    await userEvent.click(await screen.findByRole('button', { name: /retry/i }))
    expect(resumeMock.mutate).toHaveBeenCalled()
    expect(trackRecoveryTextMock).not.toHaveBeenCalled()

    downloadsMock.data = { downloads: [finishedDownload({ status: 'done' })] }
    rerender(<LoadStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={baseCtx} />)

    await waitFor(() => expect(trackRecoveryTextMock).toHaveBeenCalledTimes(1))
    expect(trackRecoveryTextMock).toHaveBeenCalledWith('404 fetching release asset', 'resume', 'ok')
  })
})
