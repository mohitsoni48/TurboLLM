// `GET /api/v1/models` tells the UI whether the active engine can load each model and, when it
// can't, why (ADR-434 (g): a Jev model shows "Needs vLLM (Linux or WSL2)" instead of vanishing).
// The reason comes from the one shared `modelIncompatibility()` rule.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import type { ModelEntry } from '../models/scanner'
import type { JevInfo } from '../models/jev'

const OPENJEV: JevInfo = {
  labels: ['contradiction', 'entailment', 'neutral'],
  nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
  architecture: 'Qwen3_5ForSequenceClassification',
  verified: true,
}

const JEV_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const GGUF_KEY = 'gemma 4 e4b|Q6_K|6217256480'

function entry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    key: GGUF_KEY, name: 'Gemma 4 E4B', path: '/models/gemma.gguf', dir: '/models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'gemma4', quant: 'Q6_K', nativeCtx: 4096,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    ...overrides,
  } as unknown as ModelEntry
}

const JEV_MODEL = entry({
  key: JEV_KEY, name: 'qwen3.5 4b nli v2', path: '/models/openjev/qwen3.5-4b-nli-v2', format: 'mlx', jev: OPENJEV,
})
const GGUF_MODEL = entry({})

type ModelRow = { key: string; compatibleWithActiveEngine: boolean; incompatibleReason: string | null; jev?: JevInfo }

function appWithActiveEngine(engineKind: string | null, models: ModelEntry[]) {
  const cfg: Record<string, unknown> = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
    modelProfiles: {},
    benchResults: {},
    modelDirs: [],
  }
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '/tmp/unused' },
    scanner: { list: () => ({ models, scanning: false, lastScanAt: '' }) },
    manager: { status: () => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null }) },
    modelRouter: { loadedModelKeys: () => new Set<string>() },
    db: { lastGenTpsByModel: () => new Map<string, number>() },
    registry: {
      active: () => (engineKind ? { id: 'eng-1', name: engineKind, kind: engineKind, binPath: 'engine' } : undefined),
    },
    downloads: { provenance: () => [] },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

async function listModels(engineKind: string | null, models: ModelEntry[]): Promise<ModelRow[]> {
  const res = await appWithActiveEngine(engineKind, models).request('/api/v1/models')
  assert.equal(res.status, 200)
  return ((await res.json()) as { models: ModelRow[] }).models
}

function compatOf(row: ModelRow) {
  return { compatibleWithActiveEngine: row.compatibleWithActiveEngine, incompatibleReason: row.incompatibleReason }
}

test('a Jev model under llama.cpp is listed as needing vLLM, with its jev descriptor', async () => {
  const [row] = await listModels('llama-server', [JEV_MODEL])

  assert.deepEqual(compatOf(row), { compatibleWithActiveEngine: false, incompatibleReason: 'Needs vLLM (Linux or WSL2)' })
  assert.deepEqual(row.jev, OPENJEV)
})

test('a Jev model under vLLM is compatible, with no reason', async () => {
  const [row] = await listModels('vllm', [JEV_MODEL])

  assert.deepEqual(compatOf(row), { compatibleWithActiveEngine: true, incompatibleReason: null })
})

test('a GGUF model under vLLM needs llama.cpp', async () => {
  const [row] = await listModels('vllm', [GGUF_MODEL])

  assert.deepEqual(compatOf(row), { compatibleWithActiveEngine: false, incompatibleReason: 'needs llama.cpp' })
})

test('with no active engine every model is compatible, with no reason', async () => {
  const rows = await listModels(null, [JEV_MODEL, GGUF_MODEL])

  assert.deepEqual(rows.map(compatOf), [
    { compatibleWithActiveEngine: true, incompatibleReason: null },
    { compatibleWithActiveEngine: true, incompatibleReason: null },
  ])
})

// `GET /api/v1/status` carries a local-only `jev` field so Workspace can
// follow a loaded Jev model. The double mirrors status-fail-reason.test.ts's status double.
function appWithPrimary(primaryKey: string | null) {
  const cfg: Record<string, unknown> = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
  }
  const library = new Map([JEV_MODEL, GGUF_MODEL].map((m) => [m.key, m]))
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '/tmp/unused' },
    manager: {
      status: () => ({ state: primaryKey ? 'running' : 'stopped', err: null, port: 0, pid: 0, model: null }),
      launchCommand: () => undefined,
      parallelSlots: () => 1,
      sessionStats: () => null,
      liveGeneration: () => null,
    },
    modelRouter: {
      aliveSlots: () => (primaryKey ? [{ modelKey: primaryKey, state: 'running', primary: true, lastUsedMs: 1 }] : []),
    },
    scanner: { get: (key: string) => library.get(key) },
    registry: { active: () => ({ id: 'eng-1', name: 'vLLM', kind: 'vllm', binPath: 'engine' }) },
    bench: { status: () => ({ state: 'idle' }) },
    downloads: { activeCount: () => 0 },
    provision: { get: () => undefined },
    build: { get: () => undefined },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

async function statusJev(primaryKey: string | null): Promise<unknown> {
  const res = await appWithPrimary(primaryKey).request('/api/v1/status')
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.ok('jev' in body, 'status must always carry the jev field')
  return body.jev
}

test('GET /api/v1/status reports jev:null when no Jev model is alive', async () => {
  assert.equal(await statusJev(null), null)
  assert.equal(await statusJev(GGUF_KEY), null)
})

test('GET /api/v1/status reports the loaded Jev model', async () => {
  assert.deepEqual(await statusJev(JEV_KEY), {
    key: JEV_KEY, name: 'qwen3.5 4b nli v2', labels: OPENJEV.labels, state: 'running', slot: 'primary',
  })
})

// `GET /api/v1/activity` (ADR-434 (i)(3)) is registered by registerApi itself, synchronously, so it
// can never fall behind the SPA fallback (ADR-421).
test('registerApi registers GET /api/v1/activity', async () => {
  const d = {
    store: { snapshot: () => ({}) },
    manager: { status: () => ({ state: 'stopped' }), sessionStats: () => ({ activeRequests: 0 }) },
    db: { getConversation: () => null, getAgentRun: () => null, getRoutine: () => null },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)

  const res = await app.request('/api/v1/activity')

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { items: [], engineGenerating: false })
})

// The HF repo-detail route overlays each checkpoint row with "is it already downloaded, and
// which local model is it?" (ADR-434 (h)) — beside, never instead of, the existing `files`
// overlay.
function appWithRepoDetail(detail: unknown, provenance: unknown[], models: ModelEntry[]) {
  const d = {
    store: { snapshot: () => ({}) },
    hf: { getRepo: async () => detail },
    downloads: { provenance: () => provenance },
    scanner: { list: () => ({ models, scanning: false, lastScanAt: '' }) },
    hashes: { get: () => undefined, ensure: () => {} },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

test('GET /api/v1/hf/models/:owner/:name annotates every checkpoint, leaving files untouched', async () => {
  const cp = (dir: string, sha: string) => ({
    dir,
    name: dir,
    sizeBytes: 9,
    jev: { architecture: 'Qwen3_5ForSequenceClassification', verified: true },
    files: [{ name: `${dir}/model.safetensors`, quant: 'mlx', sizeBytes: 9, parts: 1, mmproj: false, safetensors: true, sha256: sha, url: 'u' }],
  })
  const detail = {
    repo: 'AlexWortega/openjev', gated: false, license: 'mit', downloads: 1, likes: 1, card: '',
    files: [], safetensors: true,
    checkpoints: [cp('qwen3.5-4b-nli-v1', 'sha-v1'), cp('qwen3.5-4b-nli-v2', 'sha-v2')],
  }
  const dir = join('D:', 'models', 'openjev', 'qwen3.5-4b-nli-v2')
  const provenance = [{ repo: 'AlexWortega/openjev', filename: 'model.safetensors', sha256: 'sha-v2', dest: join(dir, 'model.safetensors'), at: '' }]
  const models = [entry({ key: 'v2-key', path: dir })]

  const res = await appWithRepoDetail(detail, provenance, models).request('/api/v1/hf/models/AlexWortega/openjev')

  assert.equal(res.status, 200)
  const body = (await res.json()) as { files: unknown[]; verifying: boolean; checkpoints: { dir: string; downloaded: boolean; localKey: string | null; jev: unknown }[] }
  assert.deepEqual(body.checkpoints.map((c) => [c.dir, c.downloaded, c.localKey]), [
    ['qwen3.5-4b-nli-v1', false, null],
    ['qwen3.5-4b-nli-v2', true, 'v2-key'],
  ])
  assert.deepEqual(body.checkpoints[1].jev, { architecture: 'Qwen3_5ForSequenceClassification', verified: true })
  assert.deepEqual(body.files, [])
  assert.equal(body.verifying, false)
})

test('a GGUF repo detail (no checkpoints) comes back exactly as before', async () => {
  const detail = {
    repo: 'bartowski/Qwen3-8B-GGUF', gated: false, license: '', downloads: 0, likes: 0, card: '',
    files: [{ name: 'qwen3-8b-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4, parts: 1, mmproj: false, url: 'u' }],
  }

  const res = await appWithRepoDetail(detail, [], []).request('/api/v1/hf/models/bartowski/Qwen3-8B-GGUF')

  const body = (await res.json()) as Record<string, unknown>
  assert.equal('checkpoints' in body, false)
  assert.deepEqual(body.files, [{ ...detail.files[0], downloaded: false, localKey: null }])
})
