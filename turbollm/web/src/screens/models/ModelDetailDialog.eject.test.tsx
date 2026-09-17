// Regression coverage for the eject-targets-the-wrong-engine bug (ADR-389 follow-up):
// "Stop & benchmark" used to call actions.eject.mutate() with NO model identity, so the
// backend always stopped whatever the primary manager happened to be running — not
// necessarily THIS dialog's model. Fixed by passing detail.key explicitly, the same
// contract change already covered for the Models page row eject
// (ModelsScreen.fleet.test.tsx) and the underlying stopEngine() API call
// (api.engine-lifecycle.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelDetailDialog } from './ModelDetailDialog'
import { defaultGpu, defaultVllm } from '../../lib/types'
import type { LoadProfile, ModelDetail } from '../../lib/types'

const ejectMutate = vi.fn()
const benchStartMutate = vi.fn()
// Mutable, unlike the other FIXED_* fixtures below: the "wedges forever" regression test
// needs to simulate the model list catching up (loaded: true -> false) AFTER the eject
// click, which a frozen fixture can't express.
let modelsState: { models: { key: string; loaded: boolean }[] } | undefined = { models: [{ key: 'bge-m3', loaded: true }] }

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
    start: { mutate: benchStartMutate, isPending: false, error: null },
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
  useModels: () => ({ data: modelsState }),
}))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
}))

beforeEach(() => {
  ejectMutate.mockClear()
  benchStartMutate.mockClear()
  modelsState = { models: [{ key: 'bge-m3', loaded: true }] }
})

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A FRESH element each call, not a single reused reference: React bails out of
  // re-rendering entirely when `rerender()` is given the exact same element object twice
  // with no state/context update scheduled (the mocked hooks here are plain side-effect-free
  // function calls, so nothing else triggers one) — the component's body, and therefore its
  // effects, would silently never run again.
  const buildTree = () => (
    <QueryClientProvider client={qc}>
      <ModelDetailDialog modelKey="bge-m3" onClose={vi.fn()} />
    </QueryClientProvider>
  )
  const result = render(buildTree())
  return { ...result, rerenderSameTree: () => result.rerender(buildTree()) }
}

describe('ModelDetailDialog — "Stop & benchmark" eject targeting', () => {
  it('passes THIS dialog\'s model key, not a bare eject', async () => {
    renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: /stop & benchmark/i }))
    expect(ejectMutate).toHaveBeenCalledWith('bge-m3')
  })

  // Regression: the deferred sweep used to wait on the PRIMARY manager's engine state
  // reaching 'stopped' — correct back when eject always targeted the primary, but once
  // eject correctly targets THIS model's own pool slot instead, ejecting a model that was
  // never the primary (e.g. an embedding model in an extra slot) leaves the primary's
  // state exactly as it was, so that wait condition never becomes true and the sweep
  // never starts — "Stop & benchmark" wedges in `pending` forever with no error.
  it('starts the deferred sweep once THIS model stops showing as loaded, not primary engine state', async () => {
    const { rerenderSameTree } = renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: /stop & benchmark/i }))
    expect(benchStartMutate).not.toHaveBeenCalled()

    // The ejected model's own slot has now drained — simulate the model list catching up
    // (this is what `useModels()`'s own polling would eventually report), independent of
    // the primary engine, which was never touched.
    modelsState = { models: [{ key: 'bge-m3', loaded: false }] }
    rerenderSameTree()

    await waitFor(() => expect(benchStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'bge-m3' }),
    ))
  })

  // Regression (second Opus review pass, v1.13.4): `?? false` treated "the models list
  // hasn't loaded yet" (a cold query cache, `modelsQ.data === undefined`) the same as
  // "confirmed no longer loaded" — firing the deferred sweep on the SAME tick as the eject,
  // before the model could possibly have actually stopped. Unresolved must mean "don't know
  // yet, don't fire" (`?? true`, i.e. still-loaded-until-proven-otherwise), not "safe to go."
  it('does NOT start the sweep while the models list is still unresolved (cold cache)', async () => {
    modelsState = undefined
    renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: /stop & benchmark/i }))
    expect(benchStartMutate).not.toHaveBeenCalled()
  })
})
