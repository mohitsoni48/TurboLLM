// AC9 parity (run 2026-09-13-autoload-last-model, plan T6). For the same model, engine and saved profile, a
// boot resume and a manual Load (`POST /api/v1/engine/start`) must hand Manager.load the same StartOpts except
// `trigger`. This is the one test that joins both callers: it drives the REAL startEngine and the REAL
// runAutoLoad, both reading the real getSysInfo(), so the two paths can't quietly drift apart again (D10).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from '../api/engine-lifecycle'
import { type Config, type Engine, defaultConfig } from '../config/config'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import { getSysInfo } from '../sysinfo/sysinfo'
import { runAutoLoad, type AutoLoadDeps } from './auto-load'
import type { StartOpts } from './manager'

type SavedProfile = Record<string, unknown>

interface ParityCase {
  entry: ModelEntry
  engine: Engine
  saved?: SavedProfile
}

test('llama-server: a resumed GGUF load equals the manual Load except trigger', async () => {
  await assertResumeMatchesManualLoad({
    entry: ggufModel(), engine: testEngine('llama-server'), saved: { ctx: 16384, port: 9123 },
  })
})

test('koboldcpp: a resumed GGUF load equals the manual Load except trigger', async () => {
  await assertResumeMatchesManualLoad({
    entry: ggufModel(), engine: testEngine('koboldcpp'), saved: { ctx: 16384, port: 9125 },
  })
})

test('llamafile: a resumed GGUF load equals the manual Load except trigger', async () => {
  await assertResumeMatchesManualLoad({
    entry: ggufModel(), engine: testEngine('llamafile'), saved: { ctx: 16384, port: 9126 },
  })
})

test('mlx: a resumed model-directory load equals the manual Load except trigger', async () => {
  await assertResumeMatchesManualLoad({
    entry: safetensorsModel(), engine: testEngine('mlx'), saved: { sampling: { temp: 0.5 }, port: 9127 },
  })
})

test('vllm: a resumed model-directory load equals the manual Load except trigger', async () => {
  await assertResumeMatchesManualLoad({
    entry: safetensorsModel(),
    engine: testEngine('vllm'),
    saved: { port: 9124, gpu: { tensorParallelSize: 2 }, vllm: { maxModelLen: 16384 } },
  })
})

test('embedding model: resume and manual Load hand the same key to the router, never to Manager.load', async () => {
  const embedding: ParityCase = { entry: ggufModel({ embedding: true }), engine: testEngine('llama-server') }
  const manual = recordingEngineSide(embedding)
  const resume = recordingEngineSide(embedding)

  await driveManualLoad(embedding, manual)
  await driveResume(resume)

  assert.deepEqual(manual.primaryLoads, [])
  assert.deepEqual(resume.primaryLoads, [])
  assert.deepEqual(manual.loadExplicitCalls, [[embedding.entry.key, undefined]])
  assert.deepEqual(resume.loadExplicitCalls, [[embedding.entry.key]])
})

async function assertResumeMatchesManualLoad(parity: ParityCase): Promise<void> {
  const manual = await captureManualLoad(parity)
  const resume = await captureResumedLoad(parity)

  assert.equal(resume.trigger, 'resume')
  assert.equal(manual.trigger, 'manual')
  assert.deepEqual({ ...resume, trigger: 'manual' }, manual)
}

async function captureManualLoad(parity: ParityCase): Promise<StartOpts> {
  const side = recordingEngineSide(parity)
  await driveManualLoad(parity, side)
  assert.equal(side.primaryLoads.length, 1, 'the manual Load reached Manager.load once')
  return side.primaryLoads[0]
}

async function captureResumedLoad(parity: ParityCase): Promise<StartOpts> {
  const side = recordingEngineSide(parity)
  await driveResume(side)
  assert.equal(side.primaryLoads.length, 1, 'the resume reached Manager.load once')
  return side.primaryLoads[0]
}

async function driveManualLoad(parity: ParityCase, side: EngineSide): Promise<void> {
  const d = {
    ...side,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
    comfy: undefined,
  } as unknown as Deps
  const app = new Hono()
  app.post('/start', async (c) => startEngine(c, d, await c.req.json<EngineStartBody>()))
  const res = await app.request('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: parity.entry.key }),
  })
  assert.equal(res.status, 202)
  // The manual load is fire-and-forget: give the swap-lock chain a turn to run.
  await new Promise((r) => setTimeout(r, 10))
}

async function driveResume(side: EngineSide): Promise<void> {
  const printed: string[] = []
  const deps: AutoLoadDeps = {
    ...side,
    initialScan: Promise.resolve(),
    comfy: { isBlocked: () => false, freeComfyUIBeforeLoad: () => Promise.resolve() },
    sysInfo: getSysInfo,
    log: (line) => { printed.push(line) },
    warn: (line) => { printed.push(line) },
  }
  await runAutoLoad(deps)
  assert.deepEqual(printed, [], 'a resume that loads prints nothing')
}

type EngineSide = ReturnType<typeof recordingEngineSide>

/** One caller's collaborators, over its own store seeded from the case. `snapshot()` clones like the real
 *  ConfigStore, so neither caller can see the other's config writes. */
function recordingEngineSide(parity: ParityCase) {
  const data = seededConfig(parity)
  const primaryLoads: StartOpts[] = []
  const loadExplicitCalls: unknown[][] = []
  return {
    primaryLoads,
    loadExplicitCalls,
    store: { snapshot: () => structuredClone(data), update: (fn: (c: Config) => void) => { fn(data) } },
    scanner: { get: (key: string) => (key === parity.entry.key ? parity.entry : undefined) },
    registry: { active: () => parity.engine },
    manager: {
      load: (opts: StartOpts) => {
        primaryLoads.push(opts)
        return Promise.resolve()
      },
    },
    modelRouter: {
      withSwapLock: <T>(fn: () => Promise<T>) => fn(),
      markPrimaryLoaded: () => {},
      loadExplicit: (...args: unknown[]) => {
        loadExplicitCalls.push([...args])
        return Promise.resolve({ target: 'http://127.0.0.1:2' })
      },
    },
  }
}

function seededConfig({ entry, saved }: ParityCase): Config {
  const lastLoaded = { modelKey: entry.key, engineId: 'eng-1' }
  const cfg: Config = { ...defaultConfig(), autoLoadOnStart: true, lastLoaded }
  if (saved) {
    cfg.modelProfiles = { [entry.key]: { 'eng-1': { profile: saved, updatedAt: '2026-09-13T00:00:00.000Z' } } }
  }
  return cfg
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
