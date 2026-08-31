// turbollm/src/routines/model-swap.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withPinnedModel, type ModelSwapDeps } from './model-swap'
import type { Manager } from '../engines/manager'
import type { ModelRouter } from '../gateway/model-router'

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
