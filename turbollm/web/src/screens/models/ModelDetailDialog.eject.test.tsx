// Regression coverage for the eject-targets-the-wrong-engine bug (ADR-389 follow-up):
// "Stop & benchmark" used to call actions.eject.mutate() with NO model identity, so the
// backend always stopped whatever the primary manager happened to be running — not
// necessarily THIS dialog's model. Fixed by passing detail.key explicitly, the same
// contract change already covered for the Models page row eject
// (ModelsScreen.fleet.test.tsx) and the underlying stopEngine() API call
// (api.engine-lifecycle.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail } from '../../lib/types'

const ejectMutate = vi.fn()

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

function detail(): ModelDetail {
  return {
    key: 'bge-m3', name: 'bge-m3', path: '/models/bge-m3.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 1e9, sizeLabel: '1 GB', arch: 'bert', quant: 'Q8_0', nativeCtx: 8192, blockCount: 32,
    headCountKv: 8, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: true, incomplete: false,
    parseError: null, loaded: true, hasProfile: false, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '',
    profile: profile(), vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
    gpu: { name: 'Test GPU', vramMb: 16000 }, gpus: [{ name: 'Test GPU', vramMb: 16000 }], cores: 8,
  } as unknown as ModelDetail
}

// Built ONCE at module scope: the dialog's own effects key off `[detail]`/`[pinnedId]`
// object/primitive identity (structuredClone-ing the profile into local draft state on
// every new `detail` reference), so a mock that rebuilds the fixture on every render
// re-triggers those effects forever — an infinite render loop that OOMs the test worker.
const FIXED_ENGINES = { engines: [{ id: 'e1', name: 'llama.cpp', kind: 'llama-server', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e1' }
const FIXED_DETAIL = detail()
const FIXED_PRESETS = { presets: [], pinnedId: null }
const FIXED_MODELS = { models: [] }

vi.mock('../../lib/queries', () => ({
  useEngines: () => ({ data: FIXED_ENGINES }),
  useModelDetail: () => ({ data: FIXED_DETAIL }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, error: null },
    eject: { mutate: ejectMutate, isPending: false },
    save: { mutate: vi.fn(), isPending: false },
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
  useModels: () => ({ data: FIXED_MODELS }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

beforeEach(() => { ejectMutate.mockClear() })

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey="bge-m3" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('ModelDetailDialog — "Stop & benchmark" eject targeting', () => {
  it('passes THIS dialog\'s model key, not a bare eject', async () => {
    renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: /stop & benchmark/i }))
    expect(ejectMutate).toHaveBeenCalledWith('bge-m3')
  })
})
