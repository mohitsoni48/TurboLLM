// `GET /api/v1/models` tells the UI whether the active engine can load each model and, when it
// can't, why (ADR-434 (g): a Jev model shows "Needs vLLM (Linux or WSL2)" instead of vanishing).
// The reason comes from the one shared `modelIncompatibility()` rule.
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
