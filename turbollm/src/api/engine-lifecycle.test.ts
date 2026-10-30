// A load the user asks for by hand (`POST /api/v1/engine/start`) is started on the selected engine whatever the
// model's format, and fails with that engine's own error if it cannot load it: the one shared `manualLoadRefusal()`
// (compat.ts) refuses only a Laya model with no Laya engine, with 409 before anything is stopped or loaded. It used to
// ask `modelIncompatibility()` (ADR-434 (g), ADR-044), which refused every model the engine was not expected to run
// with advice to activate another engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from './engine-lifecycle'
import type { Deps } from '../deps'
import type { StartOpts } from '../engines/manager'
import type { LoadExplicitOpts } from '../gateway/model-router'
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
  /** The primary's loads (`manager.load`'s StartOpts) and the router's (loadExplicit's key and options). */
  const primaryLoads: StartOpts[] = []
  const routerLoads: Array<{ key: string; opts: LoadExplicitOpts | undefined }> = []
  const manager = {
    status: () => ({ state: 'running', model: { key: 'chat-model' } }),
    load: (opts: StartOpts) => { loads.push(opts); primaryLoads.push(opts); return Promise.resolve() },
  }
  const modelRouter = {
    loadExplicit: (key: string, _overrides?: unknown, opts?: LoadExplicitOpts) => {
      loads.push(key)
      routerLoads.push({ key, opts })
      return Promise.resolve({ target: 'http://127.0.0.1:2' })
    },
    withSwapLock: (fn: () => unknown) => Promise.resolve(fn()),
    markPrimaryLoaded: () => {},
    recordManualLoad: () => {},
  }
  const cfg = { modelProfiles: {}, lastLoaded: {} }
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { get: (k: string) => models.find((m) => m.key === k) },
    registry: {
      active: () => ({ id: 'eng-1', kind: engineKind, name: engineKind, binPath: 'x', capabilities: { flags: [] } }),
      layaEngine: () => undefined,
    },
    manager,
    modelRouter,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
    comfy: undefined,
  } as unknown as Deps
  return { d, loads, primaryLoads, routerLoads }
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

test('a Jev model on llama.cpp is started on llama.cpp, with no needs-vLLM refusal', async () => {
  const h = mkDeps('llama-server', [JEV_MODEL])

  const res = await start(h.d, { modelKey: JEV_MODEL.key })
  await settle()

  assert.equal(res.status, 202)
  assert.deepEqual(h.primaryLoads.map((o) => [o.engine.id, o.model.key, o.modelPath]), [['eng-1', JEV_MODEL.key, JEV_MODEL.path]])
})

test('a GGUF model on vLLM is started on vLLM with the options vLLM reads, not refused with the format message', async () => {
  const gguf = entry({ key: 'gemma-gguf' })
  const h = mkDeps('vllm', [gguf])

  const res = await start(h.d, { modelKey: 'gemma-gguf' })
  await settle()

  assert.equal(res.status, 202)
  assert.equal(h.primaryLoads.length, 1)
  const [opts] = h.primaryLoads
  assert.deepEqual([opts.engine.kind, opts.modelPath], ['vllm', gguf.path])
  // vLLM's own options (--max-num-batched-tokens), not llama.cpp's (-c, -ngl), which vLLM would refuse before reading
  // the file.
  assert.ok(opts.extraArgs.includes('--max-num-batched-tokens'), opts.extraArgs.join(' '))
  assert.equal(opts.extraArgs.includes('-c'), false, opts.extraArgs.join(' '))
})

test('a Laya model with no Laya engine installed is still refused before anything loads', async () => {
  const laya = entry({ key: 'laya-1', format: 'mlx', laya: {} as ModelEntry['laya'] })
  const h = mkDeps('llama-server', [laya])

  const res = await start(h.d, { modelKey: laya.key })
  await settle()

  assert.equal(res.status, 409)
  assert.deepEqual(res.body.error, {
    code: 'engine_model_mismatch',
    message: 'This is a Laya model — it runs only on the Laya engine. Install Laya from Engines to load it.',
  })
  assert.deepEqual(h.loads, [])
})

test('an embedding model the selected engine cannot run is handed to the router as a manual load', async () => {
  const embedding = entry({ key: 'embed-gguf', embedding: true })
  const h = mkDeps('vllm', [embedding])

  const res = await start(h.d, { modelKey: embedding.key })
  await settle()

  assert.equal(res.status, 202)
  assert.deepEqual(h.routerLoads, [{ key: embedding.key, opts: { manual: true } }])
})

// A model loads only on the engine the user selected. A .litertlm model went to the registered LiteRT-LM engine
// whenever another kind was active, so a Load (or an Engines Start, or the Turbo Link façade's load) under KoboldCpp
// started LiteRT-LM on its own, and the screens went on naming KoboldCpp as the engine running it.
test('a .litertlm model under KoboldCpp is started on KoboldCpp, never LiteRT-LM, though a LiteRT-LM engine is installed', async () => {
  const bundle = entry({ key: 'gemma-litert', format: 'litertlm', path: 'D:\\models\\gemma.litertlm' })
  const h = mkDeps('koboldcpp', [bundle])
  Object.assign((h.d as unknown as { registry: Record<string, unknown> }).registry, {
    litertLmEngine: () => ({ id: 'litert-1', kind: 'litert-lm', name: 'LiteRT-LM', binPath: 'y', capabilities: { flags: [] } }),
  })

  const res = await start(h.d, { modelKey: bundle.key })
  await settle()

  assert.equal(res.status, 202)
  assert.equal(h.primaryLoads.length, 1)
  const [opts] = h.primaryLoads
  assert.deepEqual([opts.engine.id, opts.engine.kind, opts.modelPath], ['eng-1', 'koboldcpp', bundle.path])
  // KoboldCpp's own flags, not the LiteRT-LM --config options.
  assert.equal(opts.litertLmConfig, undefined)
  assert.ok(opts.extraArgs.includes('--contextsize'), opts.extraArgs.join(' '))
})
