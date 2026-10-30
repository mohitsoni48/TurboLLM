// Picking a preset pins it (POST /presets/:id/apply) and merges it into the dialog's draft. The
// daemon refuses the pin to a caller without a key when the preset's flags or files are not what
// the model loads with now (preset-routes.ts, launchFieldsRefusal), and the merge used to happen
// before the answer, with only the selection undone on the refusal: the dropdown read "No preset
// applied" while the draft held the preset's extraArgs, so the next Save and Load ("Remember
// these settings" is on by default) sent flags the user never typed, and were refused too.
//
// Drives the REAL dialog with the REAL preset and model mutations, mocking only the API under
// them, as ModelDetailDialog.load.test.tsx does. The other ModelDetailDialog tests stub the preset
// mutations wholesale and list no presets, so they never pick one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { ApiError } from '../../lib/api'
import { defaultGpu, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail, ModelPreset } from '../../lib/types'

const api = vi.hoisted(() => ({
  applyModelPreset: vi.fn(),
  loadModel: vi.fn(),
  saveModelProfile: vi.fn(),
  toastError: vi.fn(),
}))

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

// Built ONCE at module scope: the dialog clones its draft in an effect keyed on `detail`
// identity, so a fixture rebuilt per render loops forever.
const MODEL = {
  key: 'qwen-7b', name: 'Qwen 7B', path: '/models/qwen.gguf', dir: '/models', format: 'gguf',
  sizeBytes: 4e9, sizeLabel: '4 GB', arch: 'qwen2', quant: 'Q4_K_M', nativeCtx: 32768, blockCount: 28,
  headCountKv: 4, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
  mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
  parseError: null, loaded: false, hasProfile: true, benchTps: null, lastTps: null, liveTps: null,
  compatibleWithActiveEngine: true, mtime: '',
  profile: profile(), vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
  gpu: { name: 'Test GPU', vramMb: 16000 }, gpus: [{ name: 'Test GPU', vramMb: 16000 }], cores: 8,
} as unknown as ModelDetail

const FAST: ModelPreset = {
  id: 'p1', name: 'Fast (flags)', engineId: '', origin: 'manual', updatedAt: '',
  profile: { ...profile(), ctx: 4096, extraArgs: ['--override-kv', 'x=int:1'] },
}
const LONG: ModelPreset = { id: 'p0', name: 'Long context', engineId: '', origin: 'manual', updatedAt: '', profile: profile() }
let presets: { presets: ModelPreset[]; pinnedId: string | null } = { presets: [FAST], pinnedId: null }
const ENGINES = { engines: [{ id: 'e1', name: 'llama.cpp', kind: 'llamacpp', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e1' }

// Everything the dialog READS is stubbed; the preset and model mutations stay real.
vi.mock('../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queries')>()),
  useEngines: () => ({ data: ENGINES }),
  useModelDetail: (key: string | null) => ({ data: key ? MODEL : undefined }),
  useBenchActions: () => ({
    start: { mutate: vi.fn(), isPending: false, error: null },
    cancel: { mutate: vi.fn() },
    save: { mutate: vi.fn() },
  }),
  useBenchState: () => null,
  useStatus: () => ({ data: { engine: { state: 'running' } } }),
  useModelPresets: () => ({ data: presets }),
  useModels: () => ({ data: { models: [] } }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  applyModelPreset: (...a: unknown[]) => api.applyModelPreset(...a),
  loadModel: (...a: unknown[]) => api.loadModel(...a),
  saveModelProfile: (...a: unknown[]) => api.saveModelProfile(...a),
}))
vi.mock('../../lib/jev-api', () => ({ getActivity: async () => ({ items: [], engineGenerating: false }) }))
vi.mock('../../components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: (m: string) => api.toastError(m) },
}))

const FLAGS_REFUSAL = 'Setting extra command-line flags requires a valid API key.'

function openDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ModelDetailDialog modelKey={MODEL.key} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

async function pickFast(shown = 'No preset applied') {
  await userEvent.click(await screen.findByRole('button', { name: shown }))
  await userEvent.click(screen.getByRole('button', { name: /Fast \(flags\)/ }))
}

beforeEach(() => {
  api.applyModelPreset.mockReset()
  api.loadModel.mockReset().mockResolvedValue({ ok: true })
  api.saveModelProfile.mockReset().mockImplementation(async (_k: string, p: LoadProfile) => p)
  api.toastError.mockReset()
  presets = { presets: [FAST], pinnedId: null }
})

describe('ModelDetailDialog — picking a preset', () => {
  it('a pin refused for want of a key leaves the draft as it was, so Save and Load send none of the preset', async () => {
    api.applyModelPreset.mockRejectedValue(new ApiError('api_key_required', FLAGS_REFUSAL, 403))
    openDialog()
    await pickFast()
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith(FLAGS_REFUSAL))
    expect(api.applyModelPreset).toHaveBeenCalledWith('qwen-7b', 'p1')
    expect(screen.getByRole('button', { name: 'No preset applied' })).toBeTruthy()

    // Nothing of the preset, and nothing else either: the dialog sends only what the user set.
    const nothingSet = { userSetOnly: true }
    await userEvent.click(screen.getByTitle('Save without reloading'))
    await waitFor(() => expect(api.saveModelProfile).toHaveBeenCalledTimes(1))
    expect(api.saveModelProfile).toHaveBeenLastCalledWith('qwen-7b', nothingSet, 'e1')

    await userEvent.click(screen.getByRole('button', { name: /load model/i }))
    await waitFor(() => expect(api.loadModel).toHaveBeenCalledWith('qwen-7b', nothingSet))
    expect(api.saveModelProfile).toHaveBeenLastCalledWith('qwen-7b', nothingSet, 'e1')
  })

  it('a refused pin leaves the preset pinned before it in the dropdown', async () => {
    presets = { presets: [LONG, FAST], pinnedId: 'p0' }
    api.applyModelPreset.mockRejectedValue(new ApiError('api_key_required', FLAGS_REFUSAL, 403))
    openDialog()
    await pickFast('Long context')
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith(FLAGS_REFUSAL))
    expect(screen.getByRole('button', { name: 'Long context' })).toBeTruthy()
  })

  it('a pin that succeeds still puts the preset in the draft and the dropdown', async () => {
    api.applyModelPreset.mockResolvedValue(FAST)
    openDialog()
    await pickFast()
    expect(await screen.findByRole('button', { name: 'Fast (flags)' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /load model/i }))
    await waitFor(() => expect(api.loadModel).toHaveBeenCalledTimes(1))
    expect(api.loadModel.mock.calls[0][1]).toMatchObject({ ctx: 4096, extraArgs: ['--override-kv', 'x=int:1'] })
    expect(api.toastError).not.toHaveBeenCalled()
  })
})
