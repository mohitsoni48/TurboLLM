// A Laya model loads on the Laya engine in its own pool slot (ModelRouter.loadExplicit), like an embedding model:
// clicking Load on it must neither replace the chat model in the primary nor need the Laya engine to be active.
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

function mkDeps(models: ModelEntry[], { activeEngine = true, layaInstalled = true } = {}) {
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
    active: () => (activeEngine ? { id: 'eng-1', kind: 'llama.cpp', name: 'llama.cpp', binPath: 'llama-server', capabilities: { flags: [] } } : undefined),
    layaEngine: () => (layaInstalled ? { id: 'laya-1', kind: 'laya', name: 'Laya', binPath: 'python', capabilities: { flags: [] } } : undefined),
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

const LAYA = { checkpoints: ['english', 'multilingual'] }

function post(d: Deps, body: object): Promise<Response> {
  return Promise.resolve(app(d).request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('loading a Laya model routes through modelRouter.loadExplicit, never the primary manager', async () => {
  const h = mkDeps([entry({ key: 'laya', format: 'mlx', laya: LAYA })])
  const res = await post(h.d, { modelKey: 'laya' })
  assert.equal(res.status, 202)
  assert.deepEqual(h.loadExplicitCalls, [{ key: 'laya', overrides: undefined }])
  assert.deepEqual(h.primaryLoadCalls, [])
  assert.deepEqual(h.benchCancelCalls, [], 'no kill switch: the primary engine is not going away')
})

test('loading a Laya model works with no active engine at all, once Laya is installed', async () => {
  const h = mkDeps([entry({ key: 'laya', format: 'mlx', laya: LAYA })], { activeEngine: false })
  const res = await post(h.d, { modelKey: 'laya' })
  assert.equal(res.status, 202)
  assert.deepEqual(h.loadExplicitCalls, [{ key: 'laya', overrides: undefined }])
})

test('loading a Laya model with no Laya engine installed is a 409 that says to install it', async () => {
  const h = mkDeps([entry({ key: 'laya', format: 'mlx', laya: LAYA })], { layaInstalled: false })
  const res = await post(h.d, { modelKey: 'laya' })
  assert.equal(res.status, 409)
  const body = await res.json() as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'engine_model_mismatch')
  assert.match(body.error.message, /Install Laya from Engines/)
  assert.deepEqual(h.loadExplicitCalls, [])
})
