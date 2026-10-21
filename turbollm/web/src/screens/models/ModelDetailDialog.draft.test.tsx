// The draft-model picker of the draft/dflash speculative modes listed every scanned model but the target, whatever its
// format or engine: under llama.cpp it offered a .litertlm bundle, an MLX folder or a Jev model, all hidden everywhere
// else, and llama.cpp then failed the load on the draft it was handed.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail } from '../../lib/types'

const h = vi.hoisted(() => ({ detail: null as unknown, models: null as unknown }))

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

function detail(p: LoadProfile, sourceRepo: string | null = null): ModelDetail {
  return {
    key: 'qwen-7b', name: 'qwen-7b', path: '/models/qwen-7b.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 5e9, sizeLabel: '5 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 32768, blockCount: 32,
    headCountKv: 8, moe: false, expertCount: 0, nextnLayers: 0, vision: false, audio: false,
    mmprojPath: null, hasChatTemplate: true, reasoningEffort: false, embedding: false, incomplete: false,
    parseError: null, loaded: false, hasProfile: false, benchTps: null, lastTps: null, liveTps: null,
    compatibleWithActiveEngine: true, mtime: '', sourceRepo,
    profile: p, vramFit: { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'fits' },
    gpu: { name: 'Test GPU', vramMb: 16000 }, gpus: [{ name: 'Test GPU', vramMb: 16000 }], cores: 8,
  } as unknown as ModelDetail
}

// Built ONCE at module scope: the dialog clones its draft in an effect keyed on `detail` identity,
// so a fixture rebuilt per render loops forever (see ModelDetailDialog.eject.test.tsx).
const DRAFT_MODE = detail(profile({ speculative: 'draft' }))
const GONE_DRAFT = detail(profile({ speculative: 'draft', draftModelPath: '/models/gone-draft.gguf' }))
const LITERT_DRAFT = detail(profile({ speculative: 'draft', draftModelPath: '/models/lrt/gemma-3n.litertlm' }))
const OTHER_REPO_DRAFT = detail(profile({ speculative: 'draft', draftModelPath: '/models/llama-1b.gguf' }), 'Qwen/Qwen3-GGUF')
// Flags [] means the probe captured none, so every speculative mode is offered (hasFlag).
const ENGINES = { engines: [{ id: 'e1', name: 'llama.cpp', kind: 'llama-server', capabilities: { kvTypes: ['f16'], flags: [] } }], activeEngineId: 'e1' }
const PRESETS = { presets: [], pinnedId: null }
const STATUS = { engine: { state: 'stopped' } }
const row = (over: Record<string, unknown>) => ({ loaded: false, embedding: false, compatibleWithActiveEngine: true, sourceRepo: null, ...over })
const MODELS = {
  models: [
    row({ key: 'qwen-7b', name: 'qwen-7b', quant: 'Q4_K_M', path: '/models/qwen-7b.gguf', dir: '/models', format: 'gguf' }),
    row({ key: 'qwen-0.6b', name: 'qwen-0.6b', quant: 'Q8_0', path: '/models/qwen-0.6b.gguf', dir: '/models', format: 'gguf' }),
    row({ key: 'gemma-3n', name: 'Gemma 3n', quant: 'INT4', path: '/models/lrt/gemma-3n.litertlm', dir: '/models/lrt', format: 'litertlm', compatibleWithActiveEngine: false }),
    row({ key: 'qwen-mlx', name: 'Qwen MLX', quant: '4bit', path: '/models/mlx/qwen', dir: '/models/mlx', format: 'mlx', compatibleWithActiveEngine: false }),
    row({ key: 'nli', name: 'qwen nli', quant: 'fp16', path: '/models/jev/nli', dir: '/models/jev', format: 'mlx', compatibleWithActiveEngine: false, jev: { labels: [], nliTemplate: null, architecture: 'Qwen3ForSequenceClassification', verified: true } }),
    row({ key: 'embed', name: 'nomic embed', quant: 'F16', path: '/models/nomic.gguf', dir: '/models', format: 'gguf', embedding: true }),
  ],
}

vi.mock('../../lib/queries', () => ({
  useEngines: () => ({ data: ENGINES }),
  useModelDetail: () => ({ data: h.detail }),
  useModelActions: () => ({
    load: { mutate: vi.fn(), isPending: false, error: null },
    eject: { mutate: vi.fn(), isPending: false },
    save: { mutate: vi.fn(), isPending: false },
    reset: { mutate: vi.fn(), isPending: false },
  }),
  useBenchActions: () => ({
    start: { mutate: vi.fn(), isPending: false, error: null },
    cancel: { mutate: vi.fn() },
    save: { mutate: vi.fn() },
  }),
  useBenchState: () => null,
  useStatus: () => ({ data: STATUS }),
  useModelPresets: () => ({ data: PRESETS }),
  useModelPresetMutations: () => ({
    apply: { mutate: vi.fn() }, create: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false }, remove: { mutate: vi.fn() },
  }),
  useModels: () => ({ data: h.models ?? MODELS }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

function renderDialog(d: ModelDetail, models: unknown = null) {
  h.detail = d
  h.models = models
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey="qwen-7b" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('ModelDetailDialog — the draft-model picker', () => {
  it('offers only a GGUF chat model the selected engine runs, not a .litertlm, MLX, Jev or embedding model', async () => {
    renderDialog(DRAFT_MODE)
    const label = await screen.findByText('Draft model')
    const select = within(label.parentElement!.parentElement!).getByRole('combobox')
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)
    expect(options).toEqual(['', '/models/qwen-0.6b.gguf'])
  })

  it('still shows a saved draft that is no longer in the library as its own option', async () => {
    renderDialog(GONE_DRAFT)
    const label = await screen.findByText('Draft model')
    const select = within(label.parentElement!.parentElement!).getByRole('combobox')
    expect((select as HTMLSelectElement).value).toBe('/models/gone-draft.gguf')
    expect(within(select).getByText('/models/gone-draft.gguf (not in the current library)')).toBeTruthy()
  })

  // Such a draft read "(not in the current library)" whatever the reason it was not listed.
  it('says a saved draft still in the library cannot be a draft, not that it left the library', async () => {
    renderDialog(LITERT_DRAFT)
    const label = await screen.findByText('Draft model')
    const select = within(label.parentElement!.parentElement!).getByRole('combobox')
    expect((select as HTMLSelectElement).value).toBe('/models/lrt/gemma-3n.litertlm')
    expect(within(select).getByText('/models/lrt/gemma-3n.litertlm (not usable as a draft)')).toBeTruthy()
    expect(within(select).queryByText(/not in the current library/)).toBeNull()
  })

  it('names a saved draft the same-repo list leaves out as the model it is', async () => {
    renderDialog(OTHER_REPO_DRAFT, {
      models: [
        ...MODELS.models,
        row({ key: 'qwen-1.7b', name: 'qwen-1.7b', quant: 'Q8_0', path: '/models/qwen-1.7b.gguf', dir: '/models', format: 'gguf', sourceRepo: 'Qwen/Qwen3-GGUF' }),
        row({ key: 'llama-1b', name: 'llama-1b', quant: 'Q8_0', path: '/models/llama-1b.gguf', dir: '/models', format: 'gguf' }),
      ],
    })
    const label = await screen.findByText('Draft model')
    const select = within(label.parentElement!.parentElement!).getByRole('combobox')
    expect(screen.getByText(/From Qwen\/Qwen3-GGUF/)).toBeTruthy()
    expect((select as HTMLSelectElement).value).toBe('/models/llama-1b.gguf')
    expect(within(select).getByText('llama-1b · Q8_0 — /models')).toBeTruthy()
    expect(within(select).queryByText(/not in the current library/)).toBeNull()
  })

  // Its placeholder alone read as an empty drop-down.
  it('says no model can be a draft when none qualifies, and nothing while one does', async () => {
    const { unmount } = renderDialog(DRAFT_MODE, { models: MODELS.models.filter((m) => (m as Record<string, unknown>).key !== 'qwen-0.6b') })
    expect(await screen.findByText('No models found. A draft is a GGUF chat model the selected engine runs.')).toBeTruthy()
    unmount()
    renderDialog(DRAFT_MODE)
    await screen.findByText('Draft model')
    expect(screen.queryByText(/No models found/)).toBeNull()
  })
})
