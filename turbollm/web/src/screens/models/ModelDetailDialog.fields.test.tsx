// Three controls in the model detail dialog that said one thing and did another:
//  - the auto-tune result's Save also sent a bench cancel (Radix's Close reports the dialog
//    closing, which this dialog mapped to Cancel) — and the daemon's cancel drops the result the
//    save needs;
//  - a fractional field with min > 0 (RoPE freq scale) clamped on every keystroke, so "0.25"
//    could not be typed;
//  - the GPU-layers slider stopped at blockCount, one short of llama.cpp's real layer count (the
//    output layer), so it could not express "everything on the GPU" and called blockCount "All".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail } from '../../lib/types'

const h = vi.hoisted(() => ({
  detail: null as unknown,
  bench: null as unknown,
  saveProfile: vi.fn(),
  benchSave: vi.fn(),
  benchCancel: vi.fn(),
}))

function profile(over: Partial<LoadProfile> = {}): LoadProfile {
  return {
    ctx: 8192, ngl: 0, nCpuMoe: 0, parallel: 1, kvUnified: true, kvTypeK: 'f16', kvTypeV: 'f16',
    flashAttn: 'auto', kvOffload: true, threads: 0, threadsBatch: 0, useMmproj: false, mmprojGpu: false,
    imageMaxTokens: 0, cacheReuse: 0, useJinja: true, chatTemplateFile: '', speculative: 'off',
    mtpHeadPath: '', draftModelPath: '',
    sampling: { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] },
    contextOverflow: 'shift', nKeep: 0, ropeScalingType: 'none', ropeFreqBase: 0, ropeFreqScale: 0,
    gpu: defaultGpu(), vllm: defaultVllm(), extraArgs: [],
    ...over,
  }
}

function detail(p: LoadProfile): ModelDetail {
  return {
    key: 'qwen-7b', name: 'qwen-7b', path: '/models/qwen-7b.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 5e9, sizeLabel: '5 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 32768, blockCount: 32,
    headCountKv: 8, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
    parseError: null, loaded: false, hasProfile: false, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '',
    profile: p, vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
    gpu: { name: 'Test GPU', vramMb: 16000 }, gpus: [{ name: 'Test GPU', vramMb: 16000 }], cores: 8,
  } as unknown as ModelDetail
}

// Built ONCE at module scope: the dialog clones its draft in an effect keyed on `detail` identity,
// so a fixture rebuilt per render loops forever (see ModelDetailDialog.eject.test.tsx).
const PLAIN = detail(profile())
const LINEAR_ROPE = detail(profile({ ropeScalingType: 'linear' }))
const NGL = { 32: detail(profile({ ngl: 32 })), 33: detail(profile({ ngl: 33 })), 99: detail(profile({ ngl: 99 })) }
const ENGINES = { engines: [{ id: 'e1', name: 'llama.cpp', kind: 'llama-server', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e1' }
const PRESETS = { presets: [], pinnedId: null }
const MODELS = { models: [{ key: 'qwen-7b', loaded: false }] }
const STATUS = { engine: { state: 'stopped' } }
const TUNED = {
  running: false, done: true, modelKey: 'qwen-7b', bestTps: 42,
  result: { params: { ctx: 8192, ngl: 33, nCpuMoe: 0, parallel: 1, kvTypeK: 'f16', flashAttn: 'auto' }, tps: 42, vramMb: 1000 },
}

vi.mock('../../lib/queries', () => ({
  useEngines: () => ({ data: ENGINES }),
  useModelDetail: () => ({ data: h.detail }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, error: null },
    eject: { mutate: vi.fn(), isPending: false },
    save: { mutate: h.saveProfile, isPending: false },
    reset: { mutate: vi.fn(), isPending: false },
  }),
  useBenchActions: () => ({
    start: { mutate: vi.fn(), isPending: false, error: null },
    cancel: { mutate: h.benchCancel },
    save: { mutate: h.benchSave },
  }),
  useBenchState: () => h.bench,
  useStatus: () => ({ data: STATUS }),
  useModelPresets: () => ({ data: PRESETS }),
  useModelPresetMutations: () => ({
    apply: { mutate: vi.fn() }, create: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false }, remove: { mutate: vi.fn() },
  }),
  useModels: () => ({ data: MODELS }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderDialog(d: ModelDetail) {
  h.detail = d
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey="qwen-7b" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  h.bench = null
  h.saveProfile.mockClear()
  h.benchSave.mockClear()
  h.benchCancel.mockClear()
})

describe('ModelDetailDialog — the auto-tune result', () => {
  it('Save saves the tuned config and does not also cancel the run', async () => {
    h.bench = TUNED
    renderDialog(PLAIN)
    await screen.findByText('Auto-tune complete')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(h.benchSave).toHaveBeenCalledTimes(1)
    expect(h.benchCancel).not.toHaveBeenCalled()
  })

  it('Cancel discards it once', async () => {
    h.bench = TUNED
    renderDialog(PLAIN)
    await screen.findByText('Auto-tune complete')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.benchCancel).toHaveBeenCalledTimes(1)
    expect(h.benchSave).not.toHaveBeenCalled()
  })

  it('Escape still means Cancel', async () => {
    h.bench = TUNED
    renderDialog(PLAIN)
    await screen.findByText('Auto-tune complete')
    await userEvent.keyboard('{Escape}')
    expect(h.benchCancel).toHaveBeenCalledTimes(1)
  })
})

describe('ModelDetailDialog — a fractional field with a minimum above 0', () => {
  it('takes "0.25" typed left to right as 0.25', async () => {
    renderDialog(LINEAR_ROPE)
    await userEvent.click(await screen.findByRole('button', { name: /^advanced$/i }))
    const scale = screen.getAllByPlaceholderText('model native')[1] as HTMLInputElement
    await userEvent.type(scale, '0.25')
    expect(scale.value).toBe('0.25')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(h.saveProfile.mock.calls[0][0].profile.ropeFreqScale).toBe(0.25)
  })

  it('still applies the minimum once the field is left', async () => {
    renderDialog(LINEAR_ROPE)
    await userEvent.click(await screen.findByRole('button', { name: /^advanced$/i }))
    const scale = screen.getAllByPlaceholderText('model native')[1] as HTMLInputElement
    await userEvent.type(scale, '0.001')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(h.saveProfile.mock.calls[0][0].profile.ropeFreqScale).toBe(0.01)
  })
})

describe('ModelDetailDialog — the GPU-layers slider', () => {
  const slider = () => {
    const row = screen.getByText('GPU layers').parentElement!.parentElement!
    return { row, input: within(row).getByRole('slider') }
  }

  it('reaches blockCount + 1 (the output layer), and only that is "All"', async () => {
    renderDialog(NGL[32])
    await screen.findByText('GPU layers')
    const { row, input } = slider()
    expect(input).toHaveAttribute('max', '33')
    expect(within(row).getByText('32')).toBeInTheDocument()
    expect(within(row).getByText('33 total layers.')).toBeInTheDocument()
  })

  it('reads "All" for a tuned blockCount + 1', async () => {
    renderDialog(NGL[33])
    await screen.findByText('GPU layers')
    expect(within(slider().row).getByText('All')).toBeInTheDocument()
  })

  it('still reads "All" for a larger saved value (the default 99)', async () => {
    renderDialog(NGL[99])
    await screen.findByText('GPU layers')
    expect(within(slider().row).getByText('All')).toBeInTheDocument()
  })
})
