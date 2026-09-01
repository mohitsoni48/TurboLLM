// Regression coverage for the embedding-model manual-load fix: `startEngine`
// (`POST /api/v1/engine/start`, the Models page "Load" button) must give an embedding
// model its own pool slot via ModelRouter.loadExplicit rather than replacing whatever
// is in the primary manager — the same coexistence rule the auto-swap gateway path
// (ModelRouter.doLoad's `needsNewSlot = entry.embedding || ...`) already applies.
// Before this fix, manually loading an embedding model always called `d.manager.load()`
// directly, which killed a running chat model's engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from './engine-lifecycle'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'

function entry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    key: 'model-a', name: 'Model A', path: 'D:\\models\\model-a.gguf', dir: 'D:\\models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 4096,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false,
    ...overrides,
  } as unknown as ModelEntry
}

function mkDeps(models: ModelEntry[]) {
  const cfg: Record<string, unknown> = { modelProfiles: {}, lastLoaded: {} }
  const primaryLoadCalls: unknown[] = []
  const loadExplicitCalls: { key: string; overrides: unknown }[] = []
  const benchCancelCalls: number[] = []

  const manager = {
    status: () => ({ state: 'running', model: { key: 'chat-model' } }),
    load: (opts: unknown) => { primaryLoadCalls.push(opts); return Promise.resolve() },
    target: () => 'http://127.0.0.1:1',
    touch: () => {},
  }
  const store = { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) }
  const scanner = { get: (k: string) => models.find((m) => m.key === k) }
  const registry = {
    active: () => ({ id: 'eng-1', kind: 'llama.cpp', name: 'llama.cpp', binPath: 'llama-server', capabilities: { flags: [] } }),
  }
  const modelRouter = {
    loadExplicit: (key: string, overrides: unknown) => {
      loadExplicitCalls.push({ key, overrides })
      return Promise.resolve({ target: 'http://127.0.0.1:2' })
    },
    withSwapLock: (fn: () => unknown) => Promise.resolve(fn()),
    markPrimaryLoaded: () => {},
  }
  const d = {
    version: '1.12.0',
    store, scanner, manager, registry, modelRouter,
    bench: { cancel: () => { benchCancelCalls.push(1) }, waitIdle: () => Promise.resolve() },
    comfy: undefined,
  } as unknown as Deps

  return { d, primaryLoadCalls, loadExplicitCalls, benchCancelCalls }
}

function app(d: Deps) {
  const a = new Hono()
  a.post('/start', async (c) => startEngine(c, d, await c.req.json<EngineStartBody>()))
  return a
}

test('loading an embedding model routes through modelRouter.loadExplicit, not the primary manager', async () => {
  const h = mkDeps([entry({ key: 'bge-m3', embedding: true })])
  const res = await app(h.d).request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'bge-m3' }),
  })
  assert.equal(res.status, 202)
  assert.deepEqual(h.loadExplicitCalls, [{ key: 'bge-m3', overrides: undefined }])
  assert.deepEqual(h.primaryLoadCalls, [], 'the running chat model in the primary manager must not be touched')
  assert.deepEqual(h.benchCancelCalls, [], 'no kill switch: the primary engine (and its in-flight chats) is not going away')
})

test('loading an embedding model forwards profileOverrides to loadExplicit', async () => {
  const h = mkDeps([entry({ key: 'bge-m3', embedding: true })])
  await app(h.d).request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'bge-m3', profileOverrides: { ctx: 2048 } }),
  })
  assert.deepEqual(h.loadExplicitCalls, [{ key: 'bge-m3', overrides: { ctx: 2048 } }])
})

test('loading a regular chat model is unchanged: it still goes straight to the primary manager', async () => {
  const h = mkDeps([entry({ key: 'chat-model', embedding: false })])
  const res = await app(h.d).request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'chat-model' }),
  })
  assert.equal(res.status, 202)
  // fire-and-forget: give the swap-lock chain a turn to run.
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.primaryLoadCalls.length, 1)
  assert.deepEqual(h.loadExplicitCalls, [])
  assert.deepEqual(h.benchCancelCalls, [1], 'the kill switch still applies when the primary engine IS being replaced')
})
