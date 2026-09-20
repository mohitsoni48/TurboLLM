// The "Prompt cache RAM (MiB)" control (--cache-ram) in a model's Advanced settings: shown only on
// engines that advertise the flag, blank by default so an untouched profile launches as before, and
// 0 is saved as a real value (it disables the prompt cache) rather than being dropped as "unset".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultVllm } from '../../lib/types'
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
    gpu: defaultGpu(), vllm: defaultVllm(), extraArgs: [],
  }
}

function detail(): ModelDetail {
  return {
    key: 'qwen-7b', name: 'qwen-7b', path: '/models/qwen-7b.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 5e9, sizeLabel: '5 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 32768, blockCount: 32,
    headCountKv: 8, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
    parseError: null, loaded: false, hasProfile: false, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '',
    profile: profile(), vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
    gpu: { name: 'Test GPU', vramMb: 16000 }, gpus: [{ name: 'Test GPU', vramMb: 16000 }], cores: 8,
  } as unknown as ModelDetail
}

function enginesAdvertising(flags: string[]) {
  return { engines: [{ id: 'e1', name: 'llama.cpp', kind: 'llama-server', capabilities: { kvTypes: ['f16'], flags } }], activeEngineId: 'e1' }
}

// Built ONCE at module scope: the dialog's effects key off object identity of `detail`, so a mock
// that rebuilds its fixtures on every render loops forever (see ModelDetailDialog.eject.test.tsx).
// `flags: []` would mean "unprobed, allow everything", so the "without" engine lists an unrelated flag.
const ENGINE_WITH_CACHE_RAM = enginesAdvertising(['-c', '--cache-ram'])
const ENGINE_WITHOUT_CACHE_RAM = enginesAdvertising(['-c'])
const FIXED_DETAIL = detail()
const FIXED_PRESETS = { presets: [], pinnedId: null }
let enginesState = ENGINE_WITH_CACHE_RAM

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
  enginesState = ENGINE_WITH_CACHE_RAM
})

async function openAdvancedSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey="qwen-7b" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
  await userEvent.click(await screen.findByRole('button', { name: /^advanced$/i }))
}

function savedProfile(): LoadProfile {
  return saveMutate.mock.calls[0][0].profile
}

describe('ModelDetailDialog: Prompt cache RAM (--cache-ram)', () => {
  it('is a blank field on an engine that advertises the flag, so nothing changes until it is set', async () => {
    await openAdvancedSettings()
    const field = await screen.findByPlaceholderText('8192')
    expect((field as HTMLInputElement).value).toBe('')
  })

  it('is hidden when the engine does not advertise --cache-ram', async () => {
    enginesState = ENGINE_WITHOUT_CACHE_RAM
    await openAdvancedSettings()
    expect(screen.queryByText(/prompt cache ram/i)).toBeNull()
  })

  it('saves 0 as a real value, not as "unset"', async () => {
    await openAdvancedSettings()
    await userEvent.type(await screen.findByPlaceholderText('8192'), '0')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(savedProfile().cacheRam).toBe(0)
  })

  it('leaves cacheRam out of the saved profile when it was never touched', async () => {
    await openAdvancedSettings()
    await screen.findByPlaceholderText('8192')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(savedProfile().cacheRam).toBeUndefined()
  })
})
