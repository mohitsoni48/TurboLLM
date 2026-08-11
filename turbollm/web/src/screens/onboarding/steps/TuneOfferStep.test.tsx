import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import TuneOfferStep from './TuneOfferStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'
import type { Status } from '../../../lib/types'

// Component-level coverage for the "Run auto-tuner did nothing" bug (#5 this session) and
// its "your model is ready" reload-before-Continue fix — both depend on ENGINE STATE
// TRANSITIONS the CPU-only Docker E2E harness structurally cannot produce (T0 hardware
// never even renders this step — see registry.test.ts). Mocked, controllable status here
// instead of a real daemon round trip.

const statusMock = vi.hoisted(() => ({ data: undefined as Partial<Status> | undefined }))
const startBenchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ accepted: true }))
const stopEngineMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))
const loadModelMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))
const trackMock = vi.hoisted(() => vi.fn())

vi.mock('../../../lib/queries', () => ({ useStatus: () => statusMock }))
vi.mock('../../../lib/api', () => ({
  startBench: startBenchMock,
  stopEngine: stopEngineMock,
  loadModel: loadModelMock,
  track: trackMock,
}))

const baseCtx: OnboardingCtx = {
  profile: 'developer',
  downloadDone: true,
  isT0: false,
  recommendationKind: 'entry',
  expectedModelKey: null,
  expectedDownloadId: null,
  loadCompletedOnce: true,
}

function statusWith(engineState: Status['engine']['state'], extra: Partial<Status> = {}): Partial<Status> {
  return {
    engine: { id: 'e1', name: 'stub', state: engineState } as Status['engine'],
    model: engineState === 'running' ? ({ key: 'model-a' } as Status['model']) : null,
    bench: { running: false } as Status['bench'],
    ...extra,
  }
}

function renderStep() {
  const onContinue = vi.fn()
  const onSkip = vi.fn()
  const utils = render(<TuneOfferStep onContinue={onContinue} onSkip={onSkip} ctx={baseCtx} />)
  return { onContinue, onSkip, ...utils }
}

describe('TuneOfferStep — stop-then-bench sequencing (no more silent 409)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a loaded/running engine is stopped FIRST, not started directly — the real bug: bare startBench() 409s while a model is loaded', async () => {
    statusMock.data = statusWith('running')
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('button', { name: /Run auto-tuner/ }))
    expect(stopEngineMock).toHaveBeenCalledTimes(1)
    expect(startBenchMock).not.toHaveBeenCalled()
  })

  it('starts the sweep once the engine actually reports stopped, using the model key captured before the stop', async () => {
    statusMock.data = statusWith('running')
    const user = userEvent.setup()
    const { rerender } = renderStep()
    await user.click(screen.getByRole('button', { name: /Run auto-tuner/ }))
    expect(screen.getByText('Stopping the current model…')).toBeInTheDocument()

    // The engine reports stopped on a later poll — status.model also clears, matching
    // what a real stop does.
    statusMock.data = statusWith('stopped')
    rerender(<TuneOfferStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={baseCtx} />)

    await waitFor(() => expect(startBenchMock).toHaveBeenCalledWith('model-a'))
  })

  it('an already-stopped engine starts the sweep directly — no pointless stop call', async () => {
    statusMock.data = { ...statusWith('stopped'), model: { key: 'model-b' } as Status['model'] }
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('button', { name: /Run auto-tuner/ }))
    expect(startBenchMock).toHaveBeenCalledWith('model-b')
    expect(stopEngineMock).not.toHaveBeenCalled()
  })

  it('a stopEngine failure surfaces a real error and un-sticks the button, instead of hanging on "Stopping…" forever', async () => {
    stopEngineMock.mockRejectedValueOnce(new Error('engine busy'))
    statusMock.data = statusWith('running')
    const user = userEvent.setup()
    renderStep()
    await user.click(screen.getByRole('button', { name: /Run auto-tuner/ }))
    await waitFor(() => expect(screen.getByText('engine busy')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Run auto-tuner/ })).toBeEnabled()
  })

  it('Continue reloads the model before advancing when bench left the engine stopped — Payoff\'s "your model is ready" premise', async () => {
    // Simulates having already run a sweep: engine is stopped, no model loaded, but the
    // component captured the pre-sweep key via its ref when Run was clicked.
    statusMock.data = statusWith('running')
    const user = userEvent.setup()
    const { rerender } = renderStep()
    await user.click(screen.getByRole('button', { name: /Run auto-tuner/ }))
    statusMock.data = statusWith('stopped')
    rerender(<TuneOfferStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={baseCtx} />)
    await waitFor(() => expect(startBenchMock).toHaveBeenCalled())

    // Bench finishes — still stopped, still no model — then the user clicks Continue.
    statusMock.data = { ...statusWith('stopped'), bench: { running: false, done: true } as Status['bench'] }
    const onContinue = vi.fn()
    rerender(<TuneOfferStep onContinue={onContinue} onSkip={vi.fn()} ctx={baseCtx} />)

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(loadModelMock).toHaveBeenCalledWith('model-a'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('Continue skips the reload and just advances when the model is still loaded (e.g. the user never ran a sweep)', async () => {
    statusMock.data = statusWith('running')
    const user = userEvent.setup()
    const { onContinue } = renderStep()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(loadModelMock).not.toHaveBeenCalled()
    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})
