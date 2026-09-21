// A load fired from the model detail dialog outlives the click that fired it (ADR-434 (i)(3),
// QA E31(c) "a load that fails -> error toast").
//
// The dialog closes itself in the same click that starts a load. This drives the REAL dialog,
// the REAL shared loader and the REAL mutations, mocking only the API underneath, and closes it
// the way ModelsScreen, ChatScreen and both Code screens do: the parent clears its key, the
// dialog stays mounted, and only the sheet unmounts. The sibling ModelDetailDialog.test.tsx
// mocks the loader and the mutations wholesale, so it cannot see any of this.
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { ApiError } from '../../lib/api'
import { defaultGpu, defaultVllm } from '../../lib/types'
import { useJevLoadStore } from '../../stores/jev-load'
import type { JevInfo, LoadProfile, ModelDetail } from '../../lib/types'

const api = vi.hoisted(() => ({
  loadModel: vi.fn(),
  saveModelProfile: vi.fn(),
  getActivity: vi.fn(),
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

const VERIFIED_JEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: '{}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

// Built ONCE at module scope: the dialog clones its draft in an effect keyed on `detail`
// identity, so a fixture rebuilt per render loops forever.
const JEV_MODEL = detail({ jev: VERIFIED_JEV })
const CHAT_MODEL = detail({ key: 'chat-1', name: 'Qwen3 8B', jev: undefined })
let activeDetail: ModelDetail = JEV_MODEL

const FIXED_ENGINES = { engines: [{ id: 'e1', name: 'vLLM', kind: 'vllm', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e1' }
const FIXED_PRESETS = { presets: [], pinnedId: null }
const NOTHING_RUNNING = { items: [], engineGenerating: false }

// Everything the dialog READS is stubbed; `useModelActions` stays real, and the detail query
// answers nothing once the key is cleared, exactly as the real disabled query would.
vi.mock('../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queries')>()),
  useEngines: () => ({ data: FIXED_ENGINES }),
  useModelDetail: (key: string | null) => ({ data: key ? activeDetail : undefined }),
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
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  loadModel: (...a: unknown[]) => api.loadModel(...a),
  saveModelProfile: (...a: unknown[]) => api.saveModelProfile(...a),
}))
vi.mock('../../lib/jev-api', () => ({ getActivity: () => api.getActivity() }))
vi.mock('../../components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: (m: string) => api.toastError(m) },
}))

/** Mirrors ModelsScreen, ChatScreen and the two Code screens: the parent owns the key and the
 *  dialog is always mounted, so closing unmounts the sheet and nothing else. */
function Screen({ initialKey, onClose }: { initialKey: string; onClose: () => void }) {
  const [openKey, setOpenKey] = useState<string | null>(initialKey)
  return <ModelDetailDialog modelKey={openKey} onClose={() => { onClose(); setOpenKey(null) }} />
}

async function openDialogFor(model: ModelDetail) {
  activeDetail = model
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <Screen initialKey={model.key} onClose={onClose} />
    </QueryClientProvider>,
  )
  await screen.findByRole('button', { name: /load model/i })
  return onClose
}

const loadButton = () => screen.queryByRole('button', { name: /load model/i })

/** Presses Load, and proves the sheet really went away, so no test below can pass against a
 *  dialog that never closed. */
async function pressLoadAndSeeTheSheetClose() {
  await userEvent.click(screen.getByRole('button', { name: /load model/i }))
  await waitFor(() => expect(loadButton()).toBeNull())
}

async function turnRememberOff() {
  await userEvent.click(screen.getByRole('checkbox', { name: /remember these settings/i }))
}

const engineRefusal = () => new ApiError('engine_failed', 'Out of VRAM', 500)

beforeEach(() => {
  api.loadModel.mockReset().mockResolvedValue({ ok: true })
  api.saveModelProfile.mockReset().mockResolvedValue(profile())
  api.getActivity.mockReset().mockResolvedValue(NOTHING_RUNNING)
  api.toastError.mockReset()
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null, pendingLoadKey: null, loadError: null })
})

describe('ModelDetailDialog — a failed load, reported after the dialog closed', () => {
  it('tells the user a chat model failed to load', async () => {
    api.loadModel.mockRejectedValue(engineRefusal())
    const onClose = await openDialogFor(CHAT_MODEL)
    await turnRememberOff()
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith('Could not load model: Out of VRAM'))
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(api.toastError.mock.invocationCallOrder[0])
  })

  it('tells the user a Jev model failed to load (QA E31(c))', async () => {
    api.loadModel.mockRejectedValue(engineRefusal())
    const onClose = await openDialogFor(JEV_MODEL)
    await turnRememberOff()
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith('Could not load model: Out of VRAM'))
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(api.toastError.mock.invocationCallOrder[0])
  })

  it('tells the user a Jev model failed to load on the default, remembering path', async () => {
    api.loadModel.mockRejectedValue(engineRefusal())
    await openDialogFor(JEV_MODEL)
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(api.toastError).toHaveBeenCalledWith('Could not load model: Out of VRAM'))
  })

  it('gives back the "is ready" toast a failed Jev load had claimed', async () => {
    let refuseTheLoad: (e: ApiError) => void = () => {}
    api.loadModel.mockReturnValue(new Promise((_, reject) => { refuseTheLoad = reject }))
    await openDialogFor(JEV_MODEL)
    await turnRememberOff()
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-1'))
    await act(async () => { refuseTheLoad(engineRefusal()) })
    await waitFor(() => expect(useJevLoadStore.getState().pendingJevKey).toBeNull())
  })
})

describe('ModelDetailDialog — "Remember these settings", then load, after the dialog closed', () => {
  it('saves the draft, then requests the load with the same overrides', async () => {
    const onClose = await openDialogFor(CHAT_MODEL)
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(api.loadModel).toHaveBeenCalledWith('chat-1', profile()))
    expect(api.saveModelProfile).toHaveBeenCalledWith('chat-1', profile(), 'e1')
    expect(api.saveModelProfile.mock.invocationCallOrder[0]).toBeLessThan(api.loadModel.mock.invocationCallOrder[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still requests the load when the save is refused', async () => {
    api.saveModelProfile.mockRejectedValue(new ApiError('save_failed', 'Disk full', 500))
    await openDialogFor(CHAT_MODEL)
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(api.loadModel).toHaveBeenCalledWith('chat-1', profile()))
  })

  it('requests a Jev load with the same overrides once the save is done', async () => {
    await openDialogFor(JEV_MODEL)
    await pressLoadAndSeeTheSheetClose()
    await waitFor(() => expect(api.loadModel).toHaveBeenCalledWith('jev-1', profile()))
    expect(api.saveModelProfile.mock.invocationCallOrder[0]).toBeLessThan(api.loadModel.mock.invocationCallOrder[0])
  })
})
