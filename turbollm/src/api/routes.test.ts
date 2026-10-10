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

async function statusField(primaryKey: string | null, field: string): Promise<unknown> {
  const res = await appWithPrimary(primaryKey).request('/api/v1/status')
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.ok(field in body, `status must always carry the ${field} field`)
  return body[field]
}

async function statusJev(primaryKey: string | null): Promise<unknown> {
  return statusField(primaryKey, 'jev')
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

// ADR-444: `textClassification` is the one field the UI reads for "which text classification model is alive",
// beside the per-runtime `jev` and `laya` fields, which stay.
test('GET /api/v1/status reports textClassification:null when no text classification model is alive', async () => {
  assert.equal(await statusField(null, 'textClassification'), null)
  assert.equal(await statusField(GGUF_KEY, 'textClassification'), null)
})

test('GET /api/v1/status reports a loaded Jev model as the vLLM text classifier', async () => {
  assert.deepEqual(await statusField(JEV_KEY, 'textClassification'), {
    key: JEV_KEY, name: 'qwen3.5 4b nli v2', runtime: 'vllm', state: 'running', slot: 'primary', labels: OPENJEV.labels,
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

// ADR-444: Discover's "Text classification" category is `?category=text-classification` on the same search route.
function appWithHfSearch(hf: Record<string, unknown>) {
  const d = {
    store: { snapshot: () => ({}) },
    hf,
    registry: { active: () => ({ kind: 'llama-server' }) },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

test('GET /api/v1/hf/search?category=text-classification searches the category, whatever engine is active', async () => {
  const calls: unknown[][] = []
  const row = { repo: 'convaiinnovations/laya', downloads: 0, likes: 3503, updatedAt: '', gated: false, tags: [], textClassification: { runtime: 'laya' } }
  const hf = {
    searchTextClassification: async (...args: unknown[]) => (calls.push(args), [row]),
    searchModels: async () => { throw new Error('the category must not fall back to the engine-adapted search') },
    browseModels: async () => { throw new Error('the category must not fall back to browse') },
  }

  const res = await appWithHfSearch(hf).request('/api/v1/hf/search?q=laya&sort=downloads&category=text-classification')

  assert.equal(res.status, 200)
  assert.deepEqual(calls, [['laya', 'downloads']])
  const body = (await res.json()) as { results: { repo: string; localCount: number; textClassification: unknown }[] }
  assert.deepEqual(body.results.map((r) => [r.repo, r.localCount, r.textClassification]), [
    ['convaiinnovations/laya', 0, { runtime: 'laya' }],
  ])
})

test('GET /api/v1/hf/search browses the category when no query is typed', async () => {
  const calls: unknown[][] = []
  const hf = { searchTextClassification: async (...args: unknown[]) => (calls.push(args), []) }

  const res = await appWithHfSearch(hf).request('/api/v1/hf/search?category=text-classification')

  assert.equal(res.status, 200)
  assert.deepEqual(calls, [['', 'best-match']])
})

test('GET /api/v1/hf/search ignores an unknown category and searches as before', async () => {
  const calls: unknown[][] = []
  const hf = { searchModels: async (...args: unknown[]) => (calls.push(args), []) }

  const res = await appWithHfSearch(hf).request('/api/v1/hf/search?q=qwen&category=sentiment')

  assert.equal(res.status, 200)
  assert.deepEqual(calls, [['qwen', 'llama-server', 'best-match']])
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

/** Fetch a repo detail and return its `files` rows — the provenance-overlay tests
 *  below assert on the annotated `downloaded` flags. */
async function repoDetailFiles(
  detail: { repo: string },
  provenance: unknown[],
  models: ModelEntry[],
): Promise<{ downloaded: boolean }[]> {
  const res = await appWithRepoDetail(detail, provenance, models).request(`/api/v1/hf/models/${detail.repo}`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { files: { downloaded: boolean }[] }
  return body.files
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

// The files overlay's provenance fallback: `filename` is always a BASENAME (downloads.ts
// records the destination filename), while a repo that disambiguates same-named bundles
// across subfolders lists them by FULL path (hf.ts litertlmFiles). Rows listed by basename
// keep the legacy unconditional name match; full-path rows match by sha256 or by their
// path being the tail of the recorded dest (dest mirrors the repo's folder layout).
test('provenance fallback: unconditional by name, full-path rows resolve by sha256 or dest path', async () => {
  const bundle = (name: string, sha: string) => ({ name, quant: 'GPU', sizeBytes: 5, parts: 1, mmproj: false, litertlm: true, sha256: sha, url: 'u' })
  const detail = {
    repo: 'litert-community/x-litert-lm', gated: false, license: '', downloads: 0, likes: 0, card: '',
    litertlm: true,
    files: [bundle('gpu/model.litertlm', 'sha-gpu'), bundle('web/model.litertlm', 'sha-web')],
  }
  const repoDir = join('D:', 'models', 'litert-community', 'x-litert-lm')
  const gpuDest = join(repoDir, 'gpu', 'model.litertlm')
  const webDest = join(repoDir, 'web', 'model.litertlm')
  const models = [entry({ key: 'gpu-key', path: gpuDest }), entry({ key: 'web-key', path: webDest })]
  const rec = (over: object) => ({ repo: 'litert-community/x-litert-lm', filename: 'model.litertlm', dest: gpuDest, at: '', ...over })

  // No provenance hash: the dest path tells the two same-named bundles apart — only the
  // one that was actually downloaded is Downloaded, not both by basename.
  let files = await repoDetailFiles(detail, [rec({})], models)
  assert.deepEqual(files.map((f) => f.downloaded), [true, false])

  // Hash known and equal: the exact bundle, and still only that one.
  files = await repoDetailFiles(detail, [rec({ sha256: 'sha-gpu' })], models)
  assert.deepEqual(files.map((f) => f.downloaded), [true, false])

  // The repo re-uploaded the GPU bundle (new LFS oid, same path): the dest path keeps it
  // Downloaded — and the sibling still is not.
  files = await repoDetailFiles(detail, [rec({ sha256: 'sha-old-gpu' })], models)
  assert.deepEqual(files.map((f) => f.downloaded), [true, false])

  // Windows-style separators in the recorded dest resolve the same way.
  const winDest = 'D:\\models\\litert-community\\x-litert-lm\\web\\model.litertlm'
  files = await repoDetailFiles(detail, [rec({ dest: winDest })], [entry({ key: 'web-key', path: winDest })])
  assert.deepEqual(files.map((f) => f.downloaded), [false, true])

  // A flat dest (no subfolder recorded) cannot identify a full-path row by name, so
  // neither row claims it — sha256 stays the only way such a download matches.
  const flat = join(repoDir, 'model.litertlm')
  files = await repoDetailFiles(detail, [rec({ dest: flat })], [entry({ key: 'flat-key', path: flat })])
  assert.deepEqual(files.map((f) => f.downloaded), [false, false])

  // A basename-listed bundle keeps the legacy unconditional name match: a re-upload
  // (new LFS oid, same name) stays Downloaded.
  const flatDest = join(repoDir, 'model.litertlm')
  const flatDetail = { ...detail, files: [bundle('model.litertlm', 'sha-new')] }
  files = await repoDetailFiles(flatDetail, [rec({ filename: 'model.litertlm', sha256: 'sha-old', dest: flatDest })], [entry({ key: 'flat-bundle', path: flatDest })])
  assert.deepEqual(files.map((f) => f.downloaded), [true])

  // Same for a GGUF whose repo re-uploaded it: both hashes known and different, the
  // row stays Downloaded by name, exactly as before this PR.
  const reupload = {
    repo: 'bartowski/Qwen3-8B-GGUF', gated: false, license: '', downloads: 0, likes: 0, card: '',
    files: [{ name: 'qwen3-8b-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4, parts: 1, mmproj: false, sha256: 'new', url: 'u' }],
  }
  const reDest = join('D:', 'models', 'bartowski', 'Qwen3-8B-GGUF', 'qwen3-8b-Q4_K_M.gguf')
  files = await repoDetailFiles(
    reupload,
    [{ repo: 'bartowski/Qwen3-8B-GGUF', filename: 'qwen3-8b-Q4_K_M.gguf', sha256: 'old', dest: reDest, at: '' }],
    [entry({ key: 'gguf-key', path: reDest })],
  )
  assert.deepEqual(files.map((f) => f.downloaded), [true])

  // A basename-listed GGUF with no hash on either side keeps matching by name, as before.
  const ggufDetail = {
    repo: 'bartowski/Qwen3-8B-GGUF', gated: false, license: '', downloads: 0, likes: 0, card: '',
    files: [{ name: 'qwen3-8b-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4, parts: 1, mmproj: false, url: 'u' }],
  }
  const ggufDest = join('D:', 'models', 'bartowski', 'Qwen3-8B-GGUF', 'qwen3-8b-Q4_K_M.gguf')
  files = await repoDetailFiles(
    ggufDetail,
    [{ repo: 'bartowski/Qwen3-8B-GGUF', filename: 'qwen3-8b-Q4_K_M.gguf', dest: ggufDest, at: '' }],
    [entry({ key: 'gguf-key', path: ggufDest })],
  )
  assert.deepEqual(files.map((f) => f.downloaded), [true])
})
