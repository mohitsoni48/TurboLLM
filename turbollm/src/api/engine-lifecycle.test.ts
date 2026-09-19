// The manual load guard (`POST /api/v1/engine/start`) asks the one shared
// `modelIncompatibility()` whether the active engine can load a model (ADR-434 (g), ADR-044).
// A refused load must answer 409 before anything is stopped or loaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from './engine-lifecycle'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import type { JevInfo } from '../models/jev'

const OPENJEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

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

const JEV_MODEL = entry({
  key: 'qwen3.5 4b nli v2|mlx-fp16|9012345678', name: 'qwen3.5 4b nli v2', format: 'mlx', jev: OPENJEV,
})

function mkDeps(engineKind: string, models: ModelEntry[]) {
  const loads: unknown[] = []
  const manager = {
    status: () => ({ state: 'running', model: { key: 'chat-model' } }),
    load: (opts: unknown) => { loads.push(opts); return Promise.resolve() },
  }
  const modelRouter = {
    loadExplicit: (key: string) => { loads.push(key); return Promise.resolve({ target: 'http://127.0.0.1:2' }) },
    withSwapLock: (fn: () => unknown) => Promise.resolve(fn()),
    markPrimaryLoaded: () => {},
  }
  const cfg = { modelProfiles: {}, lastLoaded: {} }
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { get: (k: string) => models.find((m) => m.key === k) },
    registry: { active: () => ({ id: 'eng-1', kind: engineKind, name: engineKind, binPath: 'x', capabilities: { flags: [] } }) },
    manager,
    modelRouter,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
    comfy: undefined,
  } as unknown as Deps
  return { d, loads }
}

async function start(d: Deps, body: EngineStartBody) {
  const app = new Hono()
  app.post('/start', async (c) => startEngine(c, d, await c.req.json<EngineStartBody>()))
  const res = await app.request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

test('a Jev model on llama.cpp is refused with the needs-vLLM message and nothing loads', async () => {
  const h = mkDeps('llama-server', [JEV_MODEL])

  const res = await start(h.d, { modelKey: JEV_MODEL.key })
  await settle()

  assert.equal(res.status, 409)
  assert.deepEqual(res.body.error, {
    code: 'engine_model_mismatch',
    message: 'This is a Jev model — it runs only on vLLM (Linux or WSL2). Activate a vLLM engine to load it.',
  })
  assert.deepEqual(h.loads, [])
})

test('a GGUF model on vLLM is still refused with the same format message as before', async () => {
  const h = mkDeps('vllm', [entry({ key: 'gemma-gguf' })])

  const res = await start(h.d, { modelKey: 'gemma-gguf' })
  await settle()

  assert.equal(res.status, 409)
  assert.deepEqual(res.body.error, {
    code: 'engine_model_mismatch',
    message: 'The active engine is vLLM — pick a safetensors / HF model, or switch to a llama.cpp engine for GGUF.',
  })
  assert.deepEqual(h.loads, [])
})
