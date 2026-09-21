// turbollm/src/routines/model-swap.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withPinnedModel, type ModelSwapDeps } from './model-swap'
import type { Manager, StartOpts } from '../engines/manager'
import { ModelRouter } from '../gateway/model-router'
import { defaultConfig, type ConfigStore } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'

function fakeDeps(opts: { loadedKey: string | null; state?: string; activeRequests?: number }): { deps: ModelSwapDeps; loadCalls: string[] } {
  const loadCalls: string[] = []
  let current = opts.loadedKey
  const manager = {
    status: () => ({ state: opts.state ?? 'running', model: current ? { key: current } : null }),
    sessionStats: () => ({ activeRequests: opts.activeRequests ?? 0 }),
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async (key: string) => { loadCalls.push(key); current = key; return { target: 'http://127.0.0.1:8081' } },
  } as unknown as ModelRouter
  return { deps: { manager, modelRouter }, loadCalls }
}

test('pinned model already loaded -> run, no swap', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'a' })
  let ran = false
  const result = await withPinnedModel(deps, 'a', async () => { ran = true })
  assert.equal(result.outcome, 'ran')
  assert.equal(ran, true)
  assert.equal(loadCalls.length, 0)
})

test('different model loaded, engine idle -> swap, run, restore', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'b', activeRequests: 0 })
  const result = await withPinnedModel(deps, 'a', async () => {
    assert.equal(deps.manager.status().model?.key, 'a')
  })
  assert.equal(result.outcome, 'ran')
  assert.deepEqual(loadCalls, ['a', 'b']) // swap to a, then restore to b
  assert.equal(deps.manager.status().model?.key, 'b')
})

test('different model loaded and busy -> skip-busy, fn never called', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'b', activeRequests: 1 })
  let called = false
  const result = await withPinnedModel(deps, 'a', async () => { called = true })
  assert.equal(result.outcome, 'skip-busy')
  assert.equal(called, false)
  assert.equal(loadCalls.length, 0)
})

test('nothing loaded before -> swap in, run, nothing to restore', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: null, state: 'stopped' })
  const result = await withPinnedModel(deps, 'a', async () => {})
  assert.equal(result.outcome, 'ran')
  assert.deepEqual(loadCalls, ['a']) // only the swap-in — nothing to restore
})

test('restore still runs even if fn throws', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'b' })
  await assert.rejects(() => withPinnedModel(deps, 'a', async () => { throw new Error('task failed') }))
  assert.deepEqual(loadCalls, ['a', 'b'])
})

test('ComfyUI busy -> skip-comfyui-busy, fn never called (ADR-386, a temporary yield, not a load failure)', async () => {
  const manager = {
    status: () => ({ state: 'running', model: { key: 'b' } }),
    sessionStats: () => ({ activeRequests: 0 }),
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async () => ({ status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }),
  } as unknown as ModelRouter
  let called = false
  const result = await withPinnedModel({ manager, modelRouter }, 'a', async () => { called = true })
  assert.equal(result.outcome, 'skip-comfyui-busy')
  assert.equal(called, false)
})

test('a genuine load failure (not ComfyUI) still reports skip-load-failed with the real message', async () => {
  const manager = {
    status: () => ({ state: 'running', model: { key: 'b' } }),
    sessionStats: () => ({ activeRequests: 0 }),
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async () => ({ status: 500, message: 'unknown model architecture: bailingmoe3' }),
  } as unknown as ModelRouter
  const result = await withPinnedModel({ manager, modelRouter }, 'a', async () => {})
  assert.deepEqual(result, { outcome: 'skip-load-failed', message: 'unknown model architecture: bailingmoe3' })
})

// ── a Routine run RESTORES the loaded Jev model afterwards (ADR-434 "Correction to (i)(4)") ────
// A Routine run does not unload the Jev model for good: routines swap the pinned model in, run,
// and then reload whatever was loaded before — so a Routine firing while a Jev model is loaded
// briefly takes Workspace out of the playground and then brings it back. That is settled
// Routines design (spec 20 §5, ADR-060), so this pins it through the real ModelRouter, the
// shared StartOpts builder and the Jev launch flags. Nothing is spawned and no port is used —
// the Manager is a double.

const JEV_MODEL_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const CHAT_MODEL_KEY = 'qwen3-8b|mlx-4bit|8000000000'

function mlxEntry(key: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key, name: key, path: `/models/${key}`, dir: '/models',
    format: 'mlx', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'mlx', nativeCtx: 262144,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    ...extra,
  } as unknown as ModelEntry
}

const JEV_ENTRY = mlxEntry(JEV_MODEL_KEY, {
  jev: {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
  },
})
const CHAT_ENTRY = mlxEntry(CHAT_MODEL_KEY)

/** A primary Manager double that records every StartOpts it is asked to load and then reports
 *  that model as the one it is running. */
function recordingPrimary(initialKey: string): { manager: Manager; loads: StartOpts[] } {
  const loads: StartOpts[] = []
  let running: { key: string; name: string; quant: string; ctx: number; vision: boolean } | null =
    { key: initialKey, name: initialKey, quant: 'mlx', ctx: 4096, vision: false }
  const manager = {
    status: () => ({ state: 'running', err: null, port: 0, pid: 0, model: running, loadElapsedMs: 0 }),
    sessionStats: () => ({ activeRequests: 0 }),
    target: () => 'http://primary.invalid',
    touch: () => {},
    load: async (opts: StartOpts) => {
      loads.push(opts)
      running = { key: opts.model.key, name: opts.model.key, quant: 'mlx', ctx: 4096, vision: false }
    },
  } as unknown as Manager
  return { manager, loads }
}

function realRouter(manager: Manager): ModelRouter {
  const cfg = defaultConfig()
  cfg.gateway.autoSwap = true
  cfg.gateway.keepN = 1
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as unknown as ConfigStore
  const registry = {
    active: () => ({ id: 'eng1', name: 'vLLM', kind: 'vllm', binPath: 'vllm', capabilities: { kvTypes: [], flags: [] } }),
  } as unknown as Registry
  const models = [JEV_ENTRY, CHAT_ENTRY]
  const scanner = {
    list: () => ({ models, scanning: false, lastScanAt: '' }),
    get: (key: string) => models.find((m) => m.key === key),
  } as unknown as Scanner
  return new ModelRouter(store, registry, manager, scanner, undefined)
}

test('a routine pinned to a chat model swaps it in, runs, and restores the Jev model with its flags', async () => {
  const { manager, loads } = recordingPrimary(JEV_MODEL_KEY)
  const modelRouter = realRouter(manager)
  let keyWhileRunning: string | undefined

  const result = await withPinnedModel({ manager, modelRouter }, CHAT_MODEL_KEY, async () => {
    keyWhileRunning = manager.status().model?.key
  })

  assert.equal(result.outcome, 'ran')
  assert.equal(keyWhileRunning, CHAT_MODEL_KEY, 'the routine ran on its own pinned model')
  assert.deepEqual(loads.map((o) => o.model.key), [CHAT_MODEL_KEY, JEV_MODEL_KEY], 'swap in, then restore')
  assert.equal(manager.status().model?.key, JEV_MODEL_KEY, 'Workspace goes back to the playground')
  const restoreArgs = loads[1].extraArgs
  assert.ok(
    restoreArgs.includes('--convert') && restoreArgs.includes('classify'),
    `the restored Jev model keeps its launch flags, got ${JSON.stringify(restoreArgs)}`,
  )
})
