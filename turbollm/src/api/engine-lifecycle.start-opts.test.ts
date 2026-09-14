// AC9 characterization pin (run 2026-09-13-autoload-last-model, plan T3). It freezes the StartOpts the
// manual Load path (`POST /api/v1/engine/start` -> `startEngine`) hands to `Manager.load` as of commit
// 4fa0f7b, for every engine kind, BEFORE its options-building moves into a shared builder. It is green
// on purpose and must stay byte-identical: later tasks re-check its SHA256, so a red run means the
// extraction changed behaviour, never that this file needs editing.
//
// Expected values come only from the leaf functions `startEngine` calls (resolveProfile and the per-engine
// arg builders), which the extraction does not touch, plus hardware-independent literal anchors.
// Embedding entries are out of scope: they route to loadExplicit (ADR-389, engine-lifecycle.embedding.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from './engine-lifecycle'
import { type Config, type Engine, defaultConfig } from '../config/config'
import type { Deps } from '../deps'
import type { StartOpts } from '../engines/manager'
import { koboldcppProfileToArgs } from '../engines/koboldcpp'
import { mlxSamplingArgs } from '../engines/mlx'
import { type LoadProfile, profileToArgs, resolveProfile, vllmProfileToArgs } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import { getSysInfo, primaryVendor } from '../sysinfo/sysinfo'

const GGUF_KEYS = ['engine', 'extraArgs', 'model', 'modelPath', 'preferredPort', 'profile', 'trigger']
const NON_GGUF_KEYS = ['engine', 'extraArgs', 'model', 'modelPath', 'preferredPort', 'profile', 'tensorParallelSize', 'trigger']

type SavedProfile = Record<string, unknown>

interface LoadScenario {
  cfg: Config
  engine: Engine
  model: ModelEntry
  saved?: SavedProfile
  body: EngineStartBody
}

test('llama-server, no saved profile: the default profile drives llama-server args', async () => {
  const s = scenario({ kind: 'llama-server', model: ggufModel() })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), GGUF_KEYS)
  assert.equal(captured.trigger, 'manual')
  assert.equal(captured.extraArgs[0], '-c')
})

test('llama-server, saved profile plus a ctx override: the override wins ctx, the saved port is kept', async () => {
  const s = scenario({
    kind: 'llama-server',
    model: ggufModel(),
    saved: { ctx: 16384, port: 9123 },
    body: { modelKey: 'model-a', profileOverrides: { ctx: 8192 } },
  })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), GGUF_KEYS)
  assert.deepEqual(captured.extraArgs.slice(0, 2), ['-c', '8192'])
  assert.equal(captured.model.ctx, 8192)
  assert.equal(captured.preferredPort, 9123)
})

test('koboldcpp, saved profile: KoboldCpp flag names are used, not llama-server ones', async () => {
  const s = scenario({ kind: 'koboldcpp', model: ggufModel(), saved: { ctx: 16384, port: 9125 } })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), GGUF_KEYS)
  assert.deepEqual(captured.extraArgs.slice(0, 2), ['--contextsize', '16384'])
  assert.ok(!captured.extraArgs.includes('-c'))
  assert.equal(captured.preferredPort, 9125)
})

test('llamafile, saved profile: llama-server flag names are used, not KoboldCpp ones', async () => {
  const s = scenario({ kind: 'llamafile', model: ggufModel(), saved: { ctx: 16384, port: 9126 } })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), GGUF_KEYS)
  assert.deepEqual(captured.extraArgs.slice(0, 2), ['-c', '16384'])
  assert.ok(!captured.extraArgs.includes('--contextsize'))
  assert.equal(captured.preferredPort, 9126)
})

test('vllm, saved profile: max-model-len, tensor-parallel size and pinned port all reach StartOpts', async () => {
  const s = scenario({
    kind: 'vllm',
    model: safetensorsModel(),
    saved: { port: 9124, gpu: { tensorParallelSize: 2 }, vllm: { maxModelLen: 16384 } },
  })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedNonGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), NON_GGUF_KEYS)
  assert.deepEqual(captured.extraArgs.slice(0, 2), ['--max-model-len', '16384'])
  assert.equal(captured.tensorParallelSize, 2)
  assert.equal(captured.preferredPort, 9124)
  assert.equal(captured.model.ctx, 32768)
})

test('vllm, no saved profile: tensorParallelSize and preferredPort are present but undefined', async () => {
  const s = scenario({ kind: 'vllm', model: safetensorsModel() })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedNonGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), NON_GGUF_KEYS)
  assert.equal(captured.tensorParallelSize, undefined)
  assert.ok('tensorParallelSize' in captured)
  assert.equal(captured.preferredPort, undefined)
})

test('mlx, saved profile: only the saved sampling defaults become args, ctx is the native ctx', async () => {
  const s = scenario({ kind: 'mlx', model: safetensorsModel(), saved: { sampling: { temp: 0.5 }, port: 9127 } })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, expectedNonGgufStartOpts(s))
  assert.deepEqual(Object.keys(captured).sort(), NON_GGUF_KEYS)
  assert.deepEqual(captured.extraArgs, ['--temp', '0.5'])
  assert.equal(captured.preferredPort, 9127)
  assert.equal(captured.model.ctx, 32768)
})

test('legacy path (explicit modelPath, no library entry): the body is passed through with a derived model', async () => {
  const s = scenario({
    kind: 'llama-server',
    body: { modelPath: 'D:\\models\\legacy.gguf', extraArgs: ['-c', '4096'], modelName: 'Legacy' },
  })

  const captured = await captureManualLoad(s)

  assert.deepEqual(captured, {
    engine: s.engine,
    model: { key: 'D:\\models\\legacy.gguf', name: 'Legacy', quant: '', ctx: 4096, vision: false },
    modelPath: 'D:\\models\\legacy.gguf',
    extraArgs: ['-c', '4096'],
  })
})

function scenario(input: { kind: string; model?: ModelEntry; saved?: SavedProfile; body?: EngineStartBody }): LoadScenario {
  const model = input.model ?? ggufModel()
  const cfg = defaultConfig()
  if (input.saved) {
    cfg.modelProfiles[model.key] = { 'eng-1': { profile: input.saved, updatedAt: '2026-09-13T00:00:00.000Z' } }
  }
  return {
    cfg,
    engine: testEngine(input.kind),
    model,
    saved: input.saved,
    body: input.body ?? { modelKey: model.key },
  }
}

async function captureManualLoad(s: LoadScenario): Promise<StartOpts> {
  const { d, primaryLoadCalls } = mkDeps(s)
  const res = await app(d).request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(s.body),
  })
  assert.equal(res.status, 202)
  // The load is fire-and-forget: give the swap-lock chain a turn to run.
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(primaryLoadCalls.length, 1)
  return primaryLoadCalls[0]
}

function expectedGgufStartOpts(s: LoadScenario): StartOpts {
  const profile = resolvedProfile(s)
  return {
    engine: s.engine,
    model: { key: s.model.key, name: s.model.name, quant: s.model.quant, ctx: profile.ctx, vision: s.model.vision },
    modelPath: s.model.path,
    extraArgs: expectedGgufArgs(s, profile),
    preferredPort: profile.port,
    profile,
    trigger: 'manual',
  }
}

function expectedNonGgufStartOpts(s: LoadScenario): StartOpts {
  const profile = resolvedProfile(s)
  const saved = savedLoadProfile(s)
  return {
    engine: s.engine,
    model: { key: s.model.key, name: s.model.name, quant: s.model.quant, ctx: s.model.nativeCtx, vision: s.model.vision },
    modelPath: s.model.path,
    extraArgs: s.engine.kind === 'mlx' ? mlxSamplingArgs(saved?.sampling) : vllmProfileToArgs(profile, s.model.nativeCtx),
    tensorParallelSize: saved?.gpu?.tensorParallelSize,
    preferredPort: saved?.port,
    profile,
    trigger: 'manual',
  }
}

function expectedGgufArgs(s: LoadScenario, profile: LoadProfile): string[] {
  const sys = getSysInfo()
  if (s.engine.kind === 'koboldcpp') return koboldcppProfileToArgs(profile, primaryVendor(sys), sys.gpus.length > 0)
  return profileToArgs(profile, s.model, s.engine.capabilities, sys.cores, sys, s.engine.binPath)
}

function resolvedProfile(s: LoadScenario): LoadProfile {
  return resolveProfile(s.model, getSysInfo(), savedLoadProfile(s), s.body.profileOverrides, s.cfg.modelDefaults)
}

/** Config stores saved profiles as `unknown`; `startEngine` applies the same cast to what it reads back. */
function savedLoadProfile(s: LoadScenario): Partial<LoadProfile> | undefined {
  return s.saved as Partial<LoadProfile> | undefined
}

function mkDeps(s: LoadScenario) {
  const primaryLoadCalls: StartOpts[] = []
  const manager = {
    load: (opts: StartOpts) => {
      primaryLoadCalls.push(opts)
      return Promise.resolve()
    },
  }
  const store = { snapshot: () => s.cfg, update: (fn: (c: Config) => void) => fn(s.cfg) }
  const scanner = { get: (k: string) => [s.model].find((m) => m.key === k) }
  const registry = { active: () => s.engine }
  const modelRouter = {
    withSwapLock: (fn: () => unknown) => Promise.resolve(fn()),
    markPrimaryLoaded: () => {},
  }
  const d = {
    store, scanner, manager, registry, modelRouter,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
    comfy: undefined,
  } as unknown as Deps
  return { d, primaryLoadCalls }
}

function app(d: Deps) {
  const a = new Hono()
  a.post('/start', async (c) => startEngine(c, d, await c.req.json<EngineStartBody>()))
  return a
}

function testEngine(kind: string): Engine {
  return {
    id: 'eng-1', name: 'test-engine', kind, binPath: 'llama-server', version: 'b1',
    capabilities: { kvTypes: [], flags: [] }, addedAt: 't',
  } as Engine
}

function safetensorsModel(): ModelEntry {
  return ggufModel({ format: 'mlx', nativeCtx: 32768, path: 'D:\\models\\model-a' })
}

function ggufModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'model-a', name: 'Model A', path: 'D:\\models\\model-a.gguf', dir: 'D:\\models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 4096,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    loaded: false, hasProfile: false, benchTps: null, mtime: '2026-09-13T00:00:00.000Z',
    ...overrides,
  }
}
