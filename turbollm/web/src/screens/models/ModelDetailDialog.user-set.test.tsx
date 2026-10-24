// The model dialog sends and saves only what the user set. It seeded its draft from the resolved profile and sent and
// saved all of it on every Load, Save, Save as… and Auto-tune ("Remember these settings" on by default), so a built-in
// default became the user's choice the first time anything was saved: context 8192, GPU layers 99 and the llama.cpp
// sampling 0.8/0.95/40/0.05 sat in a LiteRT-LM bundle's profile when the user had changed only its Backend, and a later
// change to Settings > Model Defaults stopped reaching every model loaded once from the dialog.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultLitertLm, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail, ModelPreset, UserSetProfile } from '../../lib/types'

const saveMutate = vi.fn()
const createPreset = vi.fn()
const applyPreset = vi.fn()
const benchStart = vi.fn()
const requestLoad = vi.fn()

function auto(): LoadProfile {
  return {
    ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvUnified: true, kvTypeK: 'f16', kvTypeV: 'f16',
    flashAttn: 'on', kvOffload: true, threads: 0, threadsBatch: 0, useMmproj: false, mmprojGpu: true,
    imageMaxTokens: 0, cacheReuse: 256, useJinja: true, chatTemplateFile: '', speculative: 'off',
    mtpHeadPath: '', draftModelPath: '',
    sampling: { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] },
    contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none', ropeFreqBase: 0, ropeFreqScale: 0,
    gpu: defaultGpu(), vllm: defaultVllm(), litertLm: defaultLitertLm(), extraArgs: [],
  }
}

function detailWith(saved: UserSetProfile, over: Partial<ModelDetail> = {}): ModelDetail {
  const profile = { ...auto(), ...saved, sampling: { ...auto().sampling, ...(saved.sampling ?? {}) } } as LoadProfile
  return {
    key: 'qwen3', name: 'Qwen3 0.6B', path: '/models/Qwen3-0.6B.litertlm', dir: '/models', format: 'litertlm',
    sizeBytes: 5e8, sizeLabel: '0.5 GB', arch: 'litertlm', quant: '?', nativeCtx: 32770, blockCount: 0,
    headCountKv: 0, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
    parseError: null, loaded: false, hasProfile: Object.keys(saved).length > 0, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '',
    profile, saved, autoProfile: auto(),
    vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' }, gpu: null, gpus: [], cores: 8,
    ...over,
  } as unknown as ModelDetail
}

const LITERT_ENGINES = { engines: [{ id: 'e1', name: 'LiteRT-LM', kind: 'litert-lm', capabilities: { kvTypes: [], flags: [] } }], activeEngineId: 'e1' }
const LLAMA_ENGINES = { engines: [{ id: 'e2', name: 'llama.cpp', kind: 'llama-server', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e2' }

// The dialog's effects key off the detail's identity: one object per test, never rebuilt on render.
let detail: ModelDetail = detailWith({})
let engines: typeof LITERT_ENGINES = LITERT_ENGINES
let presets: { presets: ModelPreset[]; pinnedId: string | null } = { presets: [], pinnedId: null }

vi.mock('../../lib/queries', () => ({
  useEngines: () => ({ data: engines }),
  useModelDetail: () => ({ data: detail }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, error: null },
    eject: { mutate: vi.fn(), isPending: false },
    save: { mutate: saveMutate, isPending: false },
    reset: { mutate: vi.fn(), isPending: false },
  }),
  useBenchActions: () => ({
    start: { mutate: benchStart, isPending: false, error: null },
    cancel: { mutate: vi.fn() },
    save: { mutate: vi.fn() },
  }),
  useBenchState: () => null,
  useStatus: () => ({ data: { engine: { state: 'running' } } }),
  useModelPresets: () => ({ data: presets }),
  useModelPresetMutations: () => ({
    apply: { mutate: applyPreset }, create: { mutate: createPreset, isPending: false },
    update: { mutate: vi.fn(), isPending: false }, remove: { mutate: vi.fn() },
  }),
  useModels: () => ({ data: { models: [{ key: 'qwen3', loaded: false }] } }),
}))
vi.mock('../../lib/model-loader', () => ({
  useModelLoader: () => ({ requestLoad, isPending: false, pendingKey: undefined, loadError: null }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

beforeEach(() => {
  for (const f of [saveMutate, createPreset, applyPreset, benchStart, requestLoad]) f.mockReset()
  detail = detailWith({})
  engines = LITERT_ENGINES
  presets = { presets: [], pinnedId: null }
})

async function open(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey={detail.key} onClose={vi.fn()} />
    </QueryClientProvider>,
  )
  await screen.findByText('Sampling')
}

function slider(label: string): HTMLInputElement {
  const row = screen.getByText(label).closest('div')!.parentElement!
  return row.querySelector('input[type="range"]') as HTMLInputElement
}

const saved = (): UserSetProfile => saveMutate.mock.calls.at(-1)![0].profile

describe('ModelDetailDialog: only what the user set is sent and saved', () => {
  it('changing only the Backend saves the backend and nothing else: no context, no sampling', async () => {
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'GPU' }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(saved()).toEqual({ litertLm: { backend: 'gpu' }, userSetOnly: true })
  })

  it('Load sends the same as overrides, and Remember saves it first', async () => {
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'CPU' }))
    await userEvent.click(screen.getByRole('button', { name: /load model/i }))
    expect(saved()).toEqual({ litertLm: { backend: 'cpu' }, userSetOnly: true })
    saveMutate.mock.calls.at(-1)![1].onSuccess()
    expect(requestLoad.mock.calls[0][1]).toEqual({ overrides: { litertLm: { backend: 'cpu' }, userSetOnly: true } })
  })

  it('keeps what was saved as the user\'s and adds the one sampling key moved, not the others', async () => {
    detail = detailWith({ ctx: 6000 })
    await open()
    fireEvent.change(slider('Temperature'), { target: { value: '0.5' } })
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(saved()).toEqual({ ctx: 6000, sampling: { temp: 0.5 }, userSetOnly: true })
  })

  it('a value moved back to the default it started at is still the user\'s', async () => {
    await open()
    fireEvent.change(slider('Temperature'), { target: { value: '1.2' } })
    fireEvent.change(slider('Temperature'), { target: { value: '0.8' } })
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(saved()).toEqual({ sampling: { temp: 0.8 }, userSetOnly: true })
  })

  it('a preset an earlier build stored whole applies, and only what it changed becomes the user\'s', async () => {
    // Stored whole by an earlier dialog: the defaults it was seeded with, and the one thing the user picked.
    const whole: ModelPreset = { id: 'p1', name: 'Old GPU pick', engineId: '', origin: 'manual', updatedAt: '', profile: { ...auto(), litertLm: { backend: 'gpu' } } }
    presets = { presets: [whole], pinnedId: null }
    applyPreset.mockImplementation((_id: string, opts: { onSuccess: () => void }) => opts.onSuccess())
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'No preset applied' }))
    await userEvent.click(screen.getByRole('button', { name: /^Old GPU pick/ }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(saved()).toEqual({ litertLm: { backend: 'gpu' }, userSetOnly: true })
  })

  it('a preset applies over the automatic profile, not over what the dialog held', async () => {
    detail = detailWith({ ctx: 6000 })
    const mine: ModelPreset = { id: 'p2', name: 'Cool', engineId: '', origin: 'manual', updatedAt: '', profile: { sampling: { temp: 0.3 }, userSetOnly: true } }
    presets = { presets: [mine], pinnedId: null }
    applyPreset.mockImplementation((_id: string, opts: { onSuccess: () => void }) => opts.onSuccess())
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'No preset applied' }))
    await userEvent.click(screen.getByRole('button', { name: /^Cool/ }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(saved()).toEqual({ sampling: { temp: 0.3 }, userSetOnly: true })
    expect(slider('Context length').value).toBe('8192')
  })

  it('Save as… stores only what the user set', async () => {
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'GPU' }))
    await userEvent.click(screen.getByTitle('Capture the current settings as a new preset'))
    await userEvent.type(screen.getByPlaceholderText('Preset name'), 'Mine')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(createPreset).toHaveBeenCalledTimes(1))
    expect(createPreset.mock.calls[0][0].profile).toEqual({ litertLm: { backend: 'gpu' }, userSetOnly: true })
  })

  it('Auto-tune starts from what the user set, not from the whole draft', async () => {
    engines = LLAMA_ENGINES as typeof LITERT_ENGINES
    detail = detailWith({ ctx: 16384 }, { format: 'gguf', gpu: { name: 'GPU', vramMb: 8000 }, gpus: [{ name: 'GPU', vramMb: 8000 }], blockCount: 28 } as Partial<ModelDetail>)
    await open()
    await userEvent.click(screen.getByRole('button', { name: /auto-tune/i }))
    expect(benchStart).toHaveBeenCalledTimes(1)
    expect(benchStart.mock.calls[0][0].base).toEqual({ ctx: 16384, userSetOnly: true })
  })
})
