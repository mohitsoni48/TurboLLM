import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import type { ModelEntry } from '../models/scanner'

function entry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    key: 'qwen3-35b', name: 'Qwen3 35B', path: 'D:\\models\\qwen3-35b.gguf', dir: 'D:\\models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 32768,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false,
    ...overrides,
  } as unknown as ModelEntry
}

/** `engineKind`: the kind of the host's selected engine; null for none. */
function mkDeps(keys: ApiKey[], models: ModelEntry[], loadedKey: string | null = null, engineKind: string | null = 'llama-server'): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: keys, links: [], daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc', experimental: { turboLink: true } },
  }
  return {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { list: () => ({ models, scanning: false, lastScanAt: '' }) },
    manager: { status: () => ({ model: loadedKey ? { key: loadedKey } : null }) },
    registry: {
      active: () => (engineKind ? { id: 'eng-1', kind: engineKind, name: engineKind, binPath: 'x', capabilities: { flags: [] } } : undefined),
      layaEngine: () => undefined,
    },
  } as unknown as Deps
}

function key(raw: string, caps?: string[], models?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never, models } } : {}),
  }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

test('lists local models with their loaded state', async () => {
  const models = [entry({ key: 'qwen3-35b' }), entry({ key: 'gemma-27b' })]
  const d = mkDeps([key('tllm-a', ['models:use'])], models, 'gemma-27b')
  const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  assert.equal(res.status, 200)
  const body = await res.json() as { machineName: string; models: Array<{ key: string; loaded: boolean }> }
  assert.equal(body.models.length, 2)
  const qwen = body.models.find((m) => m.key === 'qwen3-35b')!
  const gemma = body.models.find((m) => m.key === 'gemma-27b')!
  assert.equal(qwen.loaded, false)
  assert.equal(gemma.loaded, true)
})

test('a narrowed grant hides every model outside the allowlist', async () => {
  const models = [entry({ key: 'qwen3-35b' }), entry({ key: 'gemma-27b' })]
  const d = mkDeps([key('tllm-a', ['models:use'], ['qwen3-35b'])], models)
  const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  const body = await res.json() as { models: Array<{ key: string }> }
  assert.deepEqual(body.models.map((m) => m.key), ['qwen3-35b'])
})

test('the allowlist filter is exact — a similarly-named model is NOT exposed', async () => {
  const models = [entry({ key: 'qwen3-35b' }), entry({ key: 'qwen3-35b-instruct' })]
  const d = mkDeps([key('tllm-a', ['models:use'], ['qwen3-35b'])], models)
  const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  const body = await res.json() as { models: Array<{ key: string }> }
  assert.deepEqual(body.models.map((m) => m.key), ['qwen3-35b'])
})

test('a token without models:use gets 403, not an empty list', async () => {
  const models = [entry({ key: 'qwen3-35b' })]
  const d = mkDeps([key('tllm-a', ['models:wake'])], models)
  const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  assert.equal(res.status, 403)
})

test('the payload carries no filesystem paths', async () => {
  const models = [entry({ key: 'qwen3-35b', path: 'D:\\models\\qwen3-35b.gguf' })]
  const d = mkDeps([key('tllm-a', ['models:use'])], models)
  const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
  const text = await res.text()
  assert.ok(!text.includes(':\\'))
  assert.ok(!text.includes('D:\\models\\qwen3-35b.gguf'))
})

// The host hides a model its selected engine cannot run (its Models screen and the pickers), unless its owner shows
// every engine's models (Settings → Models). The façade listed every model to a peer, which has no such setting and no
// compatibility field to filter by, with Load offered: a .litertlm bundle under KoboldCpp, a GGUF on vLLM.
test('a model the host\'s selected engine cannot run is left out, unless the host shows every engine\'s models', async () => {
  const models = [entry({ key: 'qwen3-35b' }), entry({ key: 'gemma-3n', format: 'litertlm' }), entry({ key: 'qwen3-hf', format: 'mlx' })]
  const list = async (d: Deps) => {
    const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
    return ((await res.json()) as { models: Array<{ key: string }> }).models.map((m) => m.key)
  }
  const keys = () => [key('tllm-a', ['models:use', 'models:load'])]

  const kobold = mkDeps(keys(), models, null, 'koboldcpp')
  assert.deepEqual(await list(kobold), ['qwen3-35b'])
  assert.deepEqual(await list(mkDeps(keys(), models, null, 'vllm')), ['qwen3-hf'])
  // No engine selected: every model, as the host's own list shows.
  assert.deepEqual(await list(mkDeps(keys(), models, null, null)), ['qwen3-35b', 'gemma-3n', 'qwen3-hf'])

  kobold.store.update((c) => { c.showAllEngineModels = true })
  assert.deepEqual(await list(kobold), ['qwen3-35b', 'gemma-3n', 'qwen3-hf'])
})

test('the list takes the config snapshot and registry lookups once per request, not once per model', async () => {
  // Each snapshot (and each registry lookup, which takes one) is a structuredClone of the whole config, and every
  // linked peer polls this list every 15 s; per row, that is two clones per model on every poll.
  const count = async (n: number) => {
    const models = Array.from({ length: n }, (_, i) =>
      entry({ key: `m${i}`, ...(i % 3 === 1 ? { laya: true } : i % 3 === 2 ? { format: 'litertlm' } : {}) } as Partial<ModelEntry>))
    const d = mkDeps([key('tllm-a', ['models:use'])], models)
    const calls = { snapshot: 0, active: 0, laya: 0 }
    const { store, registry } = d as unknown as {
      store: { snapshot: () => unknown }
      registry: { active: () => unknown; layaEngine: () => unknown }
    }
    const [snapshot, active, layaEngine] = [store.snapshot, registry.active, registry.layaEngine]
    store.snapshot = () => (calls.snapshot++, snapshot())
    registry.active = () => (calls.active++, active())
    registry.layaEngine = () => (calls.laya++, layaEngine())
    const res = await app(d).request('/api/link/v1/models', { headers: { 'X-TurboLLM-Auth': 'tllm-a' } })
    assert.equal(res.status, 200)
    return calls
  }
  const one = await count(3)
  const many = await count(30)
  assert.deepEqual(many, one)
  assert.ok(one.active <= 1 && one.laya <= 1, JSON.stringify(one))
})
