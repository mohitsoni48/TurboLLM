import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelStep from './ModelStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'
import type { Engine, ModelEntry } from '../../../lib/types'
import { LITERT_SMALLEST_PICK } from '../../../lib/onboarding-pick'

// ADR-434 (f) and its correction to (i)(4): the payoff of this step sends the user into
// Chat or Code, and a loaded Jev model would redirect both to the playground. So "Use a model I
// already have" must never offer one. It reuses the chat-capable predicate the pickers use and
// keeps loading straight through `loadModel` (a non-Jev load needs no confirm).

const modelsMock = vi.hoisted(() => ({ data: undefined as { models: Array<Partial<ModelEntry>> } | undefined }))
const loadModelMock = vi.hoisted(() => vi.fn())
const trackMock = vi.hoisted(() => vi.fn())
const patchCtxMock = vi.hoisted(() => vi.fn())
const onContinueMock = vi.hoisted(() => vi.fn())
const showAllMock = vi.hoisted(() => ({ value: false }))
const enqueueMock = vi.hoisted(() => vi.fn())
const recommendationMock = vi.hoisted(() => ({ isLoading: false, data: undefined as unknown }))
const sysMock = vi.hoisted(() => ({ data: undefined as unknown }))
const enginesMock = vi.hoisted(() => ({ isLoading: false, data: undefined as { engines: unknown[]; activeEngineId: string } | undefined }))
const enginesOptions = vi.hoisted(() => [] as unknown[])

vi.mock('../../../lib/queries', () => ({
  useModels: () => modelsMock,
  useShowAllEngineModels: () => showAllMock.value,
  useSysInfo: () => ({ isLoading: false, data: sysMock.data }),
  useEngines: (options: unknown) => {
    enginesOptions.push(options)
    return enginesMock
  },
  useDownloadMutations: () => ({ enqueue: { mutateAsync: enqueueMock } }),
}))
vi.mock('../../../lib/onboarding-queries', () => ({
  useOnboardingRecommendation: () => recommendationMock,
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

const chatModel: Partial<ModelEntry> = { key: 'qwen3-8b', name: 'Qwen3 8B', quant: 'Q4_K_M', sizeLabel: '4.7 GB', compatibleWithActiveEngine: true }
const jevModel: Partial<ModelEntry> = {
  key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', quant: 'BF16', sizeLabel: '8.0 GB', compatibleWithActiveEngine: true,
  jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: 'Premise: {premise} Hypothesis: {hypothesis}', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}

function renderStep(over: Partial<OnboardingCtx> = {}) {
  return render(
    <MemoryRouter>
      <ModelStep onContinue={onContinueMock} onSkip={vi.fn()} ctx={{ ...ctx, ...over }} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  loadModelMock.mockResolvedValue(undefined)
  showAllMock.value = false
  recommendationMock.data = undefined
  sysMock.data = undefined
  enginesMock.isLoading = false
  enginesMock.data = undefined
  enginesOptions.length = 0
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
    expect(patchCtxMock).toHaveBeenCalledWith({ downloadDone: true, expectedModelKey: 'qwen3-8b', expectedDownloadId: null })
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

// Only what the selected engine can run, as every other picker offers: a .litertlm bundle under llama.cpp was offered,
// and its load then failed. Settings → Models' "Show models for every engine" lists it again.
describe('ModelStep — "Use a model I already have" offers what the selected engine can run', () => {
  const bundle: Partial<ModelEntry> = {
    key: 'gemma-litert', name: 'Gemma 3n', quant: 'INT4', sizeLabel: '3.1 GB', format: 'litertlm', compatibleWithActiveEngine: false,
  }
  const options = () => within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent)

  it('leaves out a model the selected engine cannot run', () => {
    modelsMock.data = { models: [chatModel, bundle] }
    renderStep()
    expect(options()).toEqual(['Choose a model…', 'Qwen3 8B · Q4_K_M · 4.7 GB'])
  })

  it('lists it with "Show models for every engine" on', () => {
    showAllMock.value = true
    modelsMock.data = { models: [chatModel, bundle] }
    renderStep()
    expect(options()).toEqual(['Choose a model…', 'Qwen3 8B · Q4_K_M · 4.7 GB', 'Gemma 3n · INT4 · 3.1 GB'])
  })
})

// Hidden by hand (Models → Library "Hide"): no picker offers it, onboarding's included.
describe('ModelStep — "Use a model I already have" leaves out a model the user hid', () => {
  it('lists the shown model only, and the hidden one once it is loaded', () => {
    const hidden: Partial<ModelEntry> = { key: 'gemma-270m', name: 'Gemma 270M', quant: 'Q4_K_M', sizeLabel: '0.3 GB', compatibleWithActiveEngine: true, hidden: true }
    modelsMock.data = { models: [chatModel, hidden] }
    const { unmount } = renderStep()
    const options = () => within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent)
    expect(options()).toEqual(['Choose a model…', 'Qwen3 8B · Q4_K_M · 4.7 GB'])
    unmount()
    modelsMock.data = { models: [chatModel, { ...hidden, loaded: true }] }
    renderStep()
    expect(options()).toEqual(['Choose a model…', 'Qwen3 8B · Q4_K_M · 4.7 GB', 'Gemma 270M · Q4_K_M · 0.3 GB'])
  })
})

// "Download this" for a model a row already holds (a restart left it paused, or it is still
// downloading from an earlier visit) queues nothing new: the daemon answers that row in
// `existing`, and the Load step must follow it. Reading only the rows created, it followed
// nothing and froze on "Downloading".
describe('ModelStep — "Download this" follows the download that already holds the file', () => {
  const FILE = 'gemma-4-E4B-it-Q4_K_M.gguf'
  const row = (id: string, name: string, status: string) => ({ id, name, status })

  beforeEach(() => {
    modelsMock.data = { models: [] }
    recommendationMock.data = {
      recommendation: { kind: 'entry', entry: { id: 'T0-A', role: 'general', repo: 'unsloth/gemma-4-E4B-it-GGUF', file: FILE, bytes: 4_977_171_584 }, speculative: 'off' },
      isT0: true,
    }
  })

  it('stamps the existing row of the picked file when nothing new was queued', async () => {
    const held = row('dl-held', FILE, 'queued')
    enqueueMock.mockResolvedValueOnce({ downloads: [], existing: [held], resumed: [held] })
    renderStep()
    await userEvent.click(screen.getByRole('button', { name: 'Download this' }))
    await waitFor(() => expect(onContinueMock).toHaveBeenCalled())
    expect(enqueueMock).toHaveBeenCalledWith({ repo: 'unsloth/gemma-4-E4B-it-GGUF', rfilename: FILE, excludeMmproj: true })
    expect(patchCtxMock).toHaveBeenCalledWith({ expectedDownloadId: 'dl-held' })
  })

  it('still stamps a newly created row first', async () => {
    enqueueMock.mockResolvedValueOnce({ downloads: [row('dl-new', FILE, 'queued')], existing: [], resumed: [] })
    renderStep()
    await userEvent.click(screen.getByRole('button', { name: 'Download this' }))
    await waitFor(() => expect(patchCtxMock).toHaveBeenCalledWith({ expectedDownloadId: 'dl-new' }))
  })

  // The followed id is kept across leaving onboarding, so a model picked in Discover instead
  // must clear it, as "Use this model" does: kept, "Resume setup" waited for and loaded the file
  // "Download this" started earlier, not the one downloaded in Discover.
  it('"Pick a different model" stops following an earlier "Download this"', async () => {
    renderStep()
    await userEvent.click(screen.getByRole('button', { name: 'Pick a different model →' }))
    expect(patchCtxMock).toHaveBeenCalledWith({ expectedDownloadId: null })
    expect(onContinueMock).toHaveBeenCalled()
  })

  it('"Open Discover" (Pro) stops following an earlier "Download this"', async () => {
    renderStep({ profile: 'pro' })
    await userEvent.click(screen.getByRole('button', { name: /Open Discover/ }))
    expect(patchCtxMock).toHaveBeenCalledWith({ expectedDownloadId: null })
    expect(onContinueMock).toHaveBeenCalled()
  })
})

// ADR-462 (W-4, QG-2): a phone on LiteRT-LM is offered a model LiteRT-LM reads, never a GGUF. On a fresh install the
// step can open before the reconciler has activated a row, so on Android it waits for one (refetching every second, at
// most 20 s) and then falls back to the fresh-install default's format.
describe('ModelStep — the pick follows the active engine\'s format', () => {
  const PHONE_4GB = { os: 'android/arm64', ramMB: 3891, gpus: [] }
  const DESKTOP = { os: 'win32/x64', ramMB: 65536, gpus: [{ name: 'RTX', vramMb: 16384 }] }
  const row = (over: Partial<Engine> & { id: string }): Engine =>
    ({ name: over.id, binPath: '', version: '', capabilities: { kvTypes: [], flags: [] }, ...over })
  const SDK_LITERT = row({ id: 'lit', kind: 'turbollm-sdk', formats: ['litertlm'] })
  const SERVER = row({ id: 'srv', kind: 'llama-server', formats: ['gguf'] })
  const GGUF_FILE = 'gemma-4-E4B-it-Q4_K_M.gguf'
  const offeredFile = () => screen.queryByText(/ · .+\.(gguf|litertlm) · /)?.textContent ?? ''

  beforeEach(() => {
    modelsMock.data = { models: [] }
    recommendationMock.data = {
      recommendation: { kind: 'entry', entry: { id: 'T0-A', role: 'general', repo: 'unsloth/gemma-4-E4B-it-GGUF', file: GGUF_FILE, bytes: 4_977_171_584 }, speculative: 'off' },
      isT0: true,
    }
  })

  it('enqueues the LiteRT pick when the LiteRT-LM row is active', async () => {
    sysMock.data = PHONE_4GB
    enginesMock.data = { engines: [SERVER, SDK_LITERT], activeEngineId: 'lit' }
    enqueueMock.mockResolvedValueOnce({ downloads: [], existing: [], resumed: [] })
    renderStep()
    await userEvent.click(screen.getByRole('button', { name: 'Download this' }))
    expect(enqueueMock).toHaveBeenCalledWith({ repo: LITERT_SMALLEST_PICK.repo, rfilename: LITERT_SMALLEST_PICK.file, excludeMmproj: true })
  })

  it('on Android waits while no engine is active, refetching every second, then offers a .litertlm once LiteRT-LM is', () => {
    sysMock.data = PHONE_4GB
    enginesMock.data = { engines: [SERVER, SDK_LITERT], activeEngineId: '' }
    const { rerender } = renderStep()

    expect(screen.getByText('Checking your hardware…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download this' })).toBeNull()
    const { refetchInterval } = enginesOptions.at(-1) as { refetchInterval: (q: unknown) => number | false }
    expect(refetchInterval({ state: { data: enginesMock.data } })).toBe(1000)

    enginesMock.data = { engines: [SERVER, SDK_LITERT], activeEngineId: 'lit' }
    rerender(<MemoryRouter><ModelStep onContinue={onContinueMock} onSkip={vi.fn()} ctx={ctx} /></MemoryRouter>)
    expect(offeredFile()).toMatch(/\.litertlm · /)
    expect((enginesOptions.at(-1) as { refetchInterval: (q: unknown) => number | false }).refetchInterval({ state: { data: enginesMock.data } })).toBe(false)
  })

  it('on Android with no engine active after 20 s offers the LiteRT pick, never a .gguf', () => {
    vi.useFakeTimers()
    try {
      sysMock.data = PHONE_4GB
      enginesMock.data = { engines: [SERVER, SDK_LITERT], activeEngineId: '' }
      renderStep()
      act(() => { vi.advanceTimersByTime(19_000) })
      expect(screen.getByText('Checking your hardware…')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1_500) })
      expect(offeredFile()).toContain(LITERT_SMALLEST_PICK.file)
      expect(offeredFile()).not.toMatch(/\.gguf/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('on a desktop with no engine active offers today\'s pick at once', () => {
    sysMock.data = DESKTOP
    enginesMock.data = { engines: [], activeEngineId: '' }
    renderStep()
    expect(screen.queryByText('Checking your hardware…')).toBeNull()
    expect(offeredFile()).toContain(GGUF_FILE)
  })
})
