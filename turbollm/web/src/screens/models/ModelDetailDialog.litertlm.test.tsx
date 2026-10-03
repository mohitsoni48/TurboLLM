// A .litertlm model on the LiteRT-LM engine gets its own load panel (backend, context, threads) rather than only the
// generic Sampling block, and choosing GPU is saved on the profile so it can be forced where no GPU is detected.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultLitertLm, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail } from '../../lib/types'

const saveMutate = vi.fn()

function profile(): LoadProfile {
  return {
    ctx: 8192, ngl: 0, nCpuMoe: 0, parallel: 1, kvUnified: true, kvTypeK: 'f16', kvTypeV: 'f16',
    flashAttn: 'auto', kvOffload: true, threads: 0, threadsBatch: 0, useMmproj: false, mmprojGpu: false,
    imageMaxTokens: 0, cacheReuse: 0, useJinja: true, chatTemplateFile: '', speculative: 'off',
    mtpHeadPath: '', draftModelPath: '',
    sampling: { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] },
    contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none', ropeFreqBase: 0, ropeFreqScale: 0,
    gpu: defaultGpu(), vllm: defaultVllm(), litertLm: defaultLitertLm(), extraArgs: [],
  }
}

function detail(): ModelDetail {
  return {
    key: 'qwen-7b', name: 'qwen-7b', path: '/models/qwen-7b-ekv4096.litertlm', dir: '/models', format: 'litertlm',
    sizeBytes: 5e9, sizeLabel: '5 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 4096, blockCount: 0,
    headCountKv: 8, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
    parseError: null, loaded: false, hasProfile: false, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '',
    profile: profile(), vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
    gpu: null, gpus: [], cores: 8,
  } as unknown as ModelDetail
}

const LITERT_ENGINES = { engines: [{ id: 'e1', name: 'LiteRT-LM', kind: 'litert-lm', capabilities: { kvTypes: [], flags: [] } }], activeEngineId: 'e1' }

// Built ONCE at module scope: the dialog's effects key off object identity of `detail`, so a mock
// that rebuilds its fixtures on every render loops forever (see ModelDetailDialog.eject.test.tsx).
// `flags: []` would mean "unprobed, allow everything", so the "without" engine lists an unrelated flag.
const FIXED_DETAIL = detail()
const FIXED_PRESETS = { presets: [], pinnedId: null }
let enginesState = LITERT_ENGINES

vi.mock('../../lib/queries', () => ({
  useEngines: () => ({ data: enginesState }),
  useModelDetail: () => ({ data: FIXED_DETAIL }),
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
  useModels: () => ({ data: { models: [{ key: 'qwen-7b', loaded: false }] } }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

beforeEach(() => {
  saveMutate.mockClear()
  enginesState = LITERT_ENGINES
})

async function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey="qwen-7b" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
  await screen.findByText('Backend')
}

function savedProfile(): LoadProfile {
  return saveMutate.mock.calls[0][0].profile
}

describe('ModelDetailDialog: LiteRT-LM load panel', () => {
  it('shows backend, context and CPU threads — not only sampling — and hides llama.cpp-only knobs', async () => {
    await openDialog()
    expect(screen.getByText('Context length')).toBeTruthy()
    expect(screen.getByText('CPU threads')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CPU' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GPU' })).toBeTruthy()
    expect(screen.queryByText('Flash attention')).toBeNull()
    expect(screen.queryByText('Batch size')).toBeNull()
    expect(screen.getByText('Sampling')).toBeTruthy()
  })

  it('warns that the first load is slow', async () => {
    await openDialog()
    expect(screen.getByText(/a minute or more/i)).toBeTruthy()
  })

  it('saves the chosen backend on the profile, even with no GPU detected', async () => {
    await openDialog()
    await userEvent.click(screen.getByRole('button', { name: 'GPU' }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(savedProfile().litertLm?.backend).toBe('gpu')
  })
})
