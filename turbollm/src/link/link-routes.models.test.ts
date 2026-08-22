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

function mkDeps(keys: ApiKey[], models: ModelEntry[], loadedKey: string | null = null): Deps {
  const cfg: Record<string, unknown> = {
    apiKeys: keys, links: [], daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc' , experimental: { turboLink: true } },
  }
  return {
    version: '1.11.2',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) },
    scanner: { list: () => ({ models, scanning: false, lastScanAt: '' }) },
    manager: { status: () => ({ model: loadedKey ? { key: loadedKey } : null }) },
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
