import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelStep from './ModelStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'
import type { ModelEntry } from '../../../lib/types'

// ADR-434 (f) + "Correction to (i)(4)", QA gap G1: the payoff of this step sends the user into
// Chat or Code, and a loaded Jev model would redirect both to the playground. So "Use a model I
// already have" must never offer one. It reuses the chat-capable predicate the pickers use and
// keeps loading straight through `loadModel` (a non-Jev load needs no confirm).

const modelsMock = vi.hoisted(() => ({ data: undefined as { models: Array<Partial<ModelEntry>> } | undefined }))
const loadModelMock = vi.hoisted(() => vi.fn())
const trackMock = vi.hoisted(() => vi.fn())
const patchCtxMock = vi.hoisted(() => vi.fn())
const onContinueMock = vi.hoisted(() => vi.fn())

vi.mock('../../../lib/queries', () => ({
  useModels: () => modelsMock,
  useSysInfo: () => ({ isLoading: false, data: undefined }),
  useDownloadMutations: () => ({ enqueue: { mutateAsync: vi.fn() } }),
}))
vi.mock('../../../lib/onboarding-queries', () => ({
  useOnboardingRecommendation: () => ({ isLoading: false, data: undefined }),
}))
vi.mock('../../../lib/api', () => ({ loadModel: loadModelMock, track: trackMock }))
vi.mock('../../../lib/onboarding/useOnboardingMachine', () => ({
  useOnboardingMachine: () => ({ patchCtx: patchCtxMock }),
}))

const ctx: OnboardingCtx = {
  profile: 'developer',
  downloadDone: false,
  isT0: false,
  recommendationKind: 'entry',
  expectedModelKey: null,
  expectedDownloadId: null,
  loadCompletedOnce: false,
}

const chatModel: Partial<ModelEntry> = { key: 'qwen3-8b', name: 'Qwen3 8B', quant: 'Q4_K_M', sizeLabel: '4.7 GB' }
const jevModel: Partial<ModelEntry> = {
  key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', quant: 'BF16', sizeLabel: '8.0 GB',
  jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: 'Premise: {premise} Hypothesis: {hypothesis}', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}

function renderStep() {
  return render(
    <MemoryRouter>
      <ModelStep onContinue={onContinueMock} onSkip={vi.fn()} ctx={ctx} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  loadModelMock.mockResolvedValue(undefined)
})

describe('ModelStep — "Use a model I already have" offers chat models only', () => {
  it('lists the chat model and leaves the Jev model out of the select', () => {
    modelsMock.data = { models: [chatModel, jevModel] }
    renderStep()
    const options = within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Choose a model…', 'Qwen3 8B · Q4_K_M · 4.7 GB'])
  })

  it('still loads the chosen chat model straight through loadModel, remembering its key for the load step', async () => {
    modelsMock.data = { models: [chatModel, jevModel] }
    const user = userEvent.setup()
    renderStep()
    await user.selectOptions(screen.getByRole('combobox'), 'qwen3-8b')
    await user.click(screen.getByRole('button', { name: 'Use this model' }))
    await waitFor(() => expect(loadModelMock).toHaveBeenCalledWith('qwen3-8b'))
    expect(patchCtxMock).toHaveBeenCalledWith({ downloadDone: true, expectedModelKey: 'qwen3-8b' })
    expect(onContinueMock).toHaveBeenCalled()
  })

  it('shows no "use a model I already have" section at all when the only model on disk is a Jev model', () => {
    modelsMock.data = { models: [jevModel] }
    renderStep()
    expect(screen.queryByText('Use a model I already have')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText(/qwen3\.5 4b nli v2/)).not.toBeInTheDocument()
  })
})
