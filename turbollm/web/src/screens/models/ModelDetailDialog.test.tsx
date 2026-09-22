// Loading from the model detail dialog (ADR-434 (g), (i)(3)).
//
// Every load site goes through the one shared loader, so a Jev load asks before it takes
// Workspace over no matter which screen fired it. The dialog also says, read-only, how a Jev
// model will actually be launched — verified settings, or plain pooling.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultVllm } from '../../lib/types'
import type { JevInfo, LoadProfile, ModelDetail } from '../../lib/types'

const requestLoad = vi.fn()
const saveMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.())

function profile(): LoadProfile {
  return {
    ctx: 8192, ngl: 0, nCpuMoe: 0, parallel: 1, kvUnified: true, kvTypeK: 'f16', kvTypeV: 'f16',
    flashAttn: 'auto', kvOffload: true, threads: 0, threadsBatch: 0, useMmproj: false, mmprojGpu: false,
    imageMaxTokens: 0, cacheReuse: 0, useJinja: true, chatTemplateFile: '', speculative: 'off',
    mtpHeadPath: '', draftModelPath: '',
    sampling: { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] },
    contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none', ropeFreqBase: 0, ropeFreqScale: 0,
    gpu: defaultGpu(), vllm: defaultVllm(), extraArgs: [],
  }
}

function detail(over: Partial<ModelDetail> = {}): ModelDetail {
  return {
    key: 'jev-1', name: 'qwen3.5-4b-nli-v2', path: '/models/jev', dir: '/models', format: 'safetensors',
    sizeBytes: 8e9, sizeLabel: '8 GB', arch: 'qwen3_5', quant: 'F16', nativeCtx: 8192, blockCount: 32,
    headCountKv: 8, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
    parseError: null, loaded: false, hasProfile: false, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '',
    profile: profile(), vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
    gpu: { name: 'Test GPU', vramMb: 16000 }, gpus: [{ name: 'Test GPU', vramMb: 16000 }], cores: 8,
    ...over,
  } as unknown as ModelDetail
}

function jev(over: Partial<JevInfo> = {}): JevInfo {
  return {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: '{}',
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
    ...over,
  }
}

// Built ONCE at module scope, like the sibling eject suite: the dialog clones its draft in an
// effect keyed on `detail` identity, so a fixture rebuilt per render loops forever.
const VERIFIED = detail({ jev: jev() })
const UNVERIFIED = detail({ jev: jev({ verified: false, architecture: 'SomethingElseForSequenceClassification' }) })
const PLAIN = detail({ key: 'chat-1', name: 'Qwen3 8B', jev: undefined })
let activeDetail: ModelDetail = VERIFIED

const FIXED_ENGINES = { engines: [{ id: 'e1', name: 'vLLM', kind: 'vllm', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e1' }
const FIXED_PRESETS = { presets: [], pinnedId: null }

vi.mock('../../lib/queries', () => ({
  useEngines: () => ({ data: FIXED_ENGINES }),
  useModelDetail: () => ({ data: activeDetail }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, error: null },
    eject: { mutate: vi.fn(), isPending: false },
    save: { mutate: saveMutate, isPending: false },
    reset: { mutate: vi.fn(), isPending: false },
  }),
  useBenchActions: () => ({
    start: { mutate: vi.fn(), isPending: false, error: null },
    cancel: { mutate: vi.fn() },
    save: { mutate: vi.fn() },
  }),
  useBenchState: () => null,
  useStatus: () => ({ data: { engine: { state: 'running' } } }),
  useModelPresets: () => ({ data: FIXED_PRESETS }),
  useModelPresetMutations: () => ({
    apply: { mutate: vi.fn() }, create: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false }, remove: { mutate: vi.fn() },
  }),
  useModels: () => ({ data: { models: [] } }),
}))
// The dialog reads the shared loader, not its own mutation observer: it closes itself in the
// same click that fires a load, and a load started anywhere must busy this button.
let loaderState: { isPending: boolean; pendingKey?: string; loadError: { key: string; message: string } | null }
vi.mock('../../lib/model-loader', () => ({
  useModelLoader: () => ({ requestLoad, confirmLoad: vi.fn(), ...loaderState }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderDialog(d: ModelDetail) {
  activeDetail = d
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey={d.key} onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  loaderState = { isPending: false, pendingKey: undefined, loadError: null }
  requestLoad.mockClear()
  saveMutate.mockClear()
})

describe('ModelDetailDialog — loading through the shared loader', () => {
  it('loads a Jev model through the loader, jev field and all, with the draft overrides', async () => {
    renderDialog(VERIFIED)
    await userEvent.click(await screen.findByRole('button', { name: /load model/i }))
    expect(requestLoad).toHaveBeenCalledTimes(1)
    const [target, opts] = requestLoad.mock.calls[0]
    expect(target).toEqual(expect.objectContaining({ key: 'jev-1', name: 'qwen3.5-4b-nli-v2', jev: jev() }))
    expect(opts.overrides).toEqual(profile())
  })

  it('loads a plain model through the same loader, with nothing to confirm', async () => {
    renderDialog(PLAIN)
    await userEvent.click(await screen.findByRole('button', { name: /load model/i }))
    expect(requestLoad.mock.calls[0][0]).toEqual(expect.objectContaining({ key: 'chat-1', name: 'Qwen3 8B' }))
    expect(requestLoad.mock.calls[0][0].jev).toBeUndefined()
  })

  it('busies the button for a load another surface started', async () => {
    loaderState = { isPending: true, pendingKey: 'other-model', loadError: null }
    renderDialog(VERIFIED)
    expect((await screen.findByRole('button', { name: /load model/i })).hasAttribute('disabled')).toBe(true)
  })

  it('says why the last load of this model failed', async () => {
    loaderState = { isPending: false, loadError: { key: 'jev-1', message: 'vLLM is not installed.' }, pendingKey: undefined }
    renderDialog(VERIFIED)
    expect(await screen.findByText('vLLM is not installed.')).toBeTruthy()
  })

  it('never shows another model\'s failure', async () => {
    loaderState = { isPending: false, loadError: { key: 'chat-1', message: 'vLLM is not installed.' }, pendingKey: undefined }
    renderDialog(VERIFIED)
    await screen.findByRole('button', { name: /load model/i })
    expect(screen.queryByText('vLLM is not installed.')).toBeNull()
  })

  it('still saves before loading when "Remember these settings" is on', async () => {
    renderDialog(VERIFIED)
    await userEvent.click(await screen.findByRole('button', { name: /load model/i }))
    expect(saveMutate).toHaveBeenCalledTimes(1)
    expect(saveMutate.mock.invocationCallOrder[0]).toBeLessThan(requestLoad.mock.invocationCallOrder[0])
  })
})

describe('ModelDetailDialog — how a Jev model will launch', () => {
  it('names the verified launch settings and the architecture they are for', async () => {
    renderDialog(VERIFIED)
    expect(await screen.findByText(
      'Jev model — launched as a classifier with verified settings for Qwen3_5ForSequenceClassification.',
    )).toBeTruthy()
  })

  it('is honest that an unverified architecture falls back to plain pooling', async () => {
    renderDialog(UNVERIFIED)
    expect(await screen.findByText(
      "Jev model — Not verified: launched with plain --runner pooling; if vLLM can't load it, its own error is shown.",
    )).toBeTruthy()
  })

  it('says nothing of the sort about a chat model', async () => {
    renderDialog(PLAIN)
    await screen.findByRole('button', { name: /load model/i })
    expect(screen.queryByText(/Jev model —/)).toBeNull()
  })
})
