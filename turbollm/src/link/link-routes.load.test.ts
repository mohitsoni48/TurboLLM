import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash, randomUUID } from 'node:crypto'
import { registerLinkApi } from './link-routes'
import { ModelRouter } from '../gateway/model-router'
import type { Deps } from '../deps'
import type { ApiKey } from '../config/config'
import type { ModelEntry } from '../models/scanner'
import { LinkClient } from './link-client'

/** A model whose on-disk path is a WINDOWS absolute path on purpose: every response this
 *  suite touches is asserted not to contain it (see the "no host filesystem detail" tests). */
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

function key(raw: string, caps?: string[], models?: string[]): ApiKey {
  return {
    id: randomUUID(), name: 'laptop', hash: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12), createdAt: 'c', lastUsedAt: null,
    ...(caps ? { grant: { capabilities: caps as never, models } } : {}),
  }
}

interface Harness {
  d: Deps
  /** Every `manager.load()` the façade caused, in order, with the model key it targeted. */
  loads: string[]
  /** Resolves the currently in-flight `manager.load()`. */
  finishLoad: () => void
  /** Mutable counter so callers observe stops made after the harness was built. */
  stops: { n: number }
}

function mkDeps(
  keys: ApiKey[],
  models: ModelEntry[],
  opts?: { blockLoad?: boolean; comfyBlocked?: boolean; noEngine?: boolean },
): Harness {
  const cfg: Record<string, unknown> = {
    apiKeys: keys,
    links: [],
    daemon: { lanBind: true, requireApiKey: true, machineId: 'machine-abc' },
    modelProfiles: {}, modelPresets: {}, lastPresetId: {}, lastLoaded: {},
  }
  const loads: string[] = []
  let release: () => void = () => {}
  const stops = { n: 0 }

  const manager = {
    status: () => ({ state: 'idle', model: null }),
    load: (o: { model: { key: string } }) => {
      loads.push(o.model.key)
      return opts?.blockLoad ? new Promise<void>((r) => { release = r }) : Promise.resolve()
    },
    stop: () => { stops.n += 1 },
    target: () => 'http://127.0.0.1:1',
    touch: () => {},
  }

  const store = { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) }
  const scanner = {
    list: () => ({ models, scanning: false, lastScanAt: '' }),
    get: (k: string) => models.find((m) => m.key === k),
  }
  const registry = {
    active: () => opts?.noEngine
      ? undefined
      : { id: 'eng-1', kind: 'llama.cpp', name: 'llama.cpp', binPath: 'llama-server', capabilities: { flags: [] } },
  }
  // The REAL router, so `withSwapLock` under test is the production swap chain, not a
  // test-local re-implementation of one.
  const modelRouter = new ModelRouter(
    store as never, registry as never, manager as never, scanner as never, undefined,
  )
  const d = {
    version: '1.11.2',
    store, scanner, manager, registry, modelRouter,
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
    comfy: opts?.comfyBlocked ? { isBlocked: () => true } : undefined,
  } as unknown as Deps

  return { d, loads, finishLoad: () => release(), stops }
}

function app(d: Deps) {
  const a = new Hono()
  registerLinkApi(a, d)
  return a
}

function post(a: Hono, path: string, token: string, body?: unknown) {
  return a.request(path, {
    method: 'POST',
    headers: { 'X-TurboLLM-Auth': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('load succeeds with models:load and reaches the real load path', async () => {
  const h = mkDeps([key('tllm-a', ['models:use', 'models:load'])], [entry({})])
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', { modelKey: 'qwen3-35b' })
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { ok: true })
  // The load is fire-and-forget behind the swap lock; give the chain a turn to run.
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.loads, ['qwen3-35b'])
})

test('load is 403 with only models:use', async () => {
  const h = mkDeps([key('tllm-a', ['models:use'])], [entry({})])
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', { modelKey: 'qwen3-35b' })
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { capability: string } }
  assert.equal(body.error.capability, 'models:load')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.loads, [])
})

test('unload is 403 with only models:load — load does NOT imply unload', async () => {
  const h = mkDeps([key('tllm-a', ['models:use', 'models:load'])], [entry({})])
  const res = await post(app(h.d), '/api/link/v1/models/unload', 'tllm-a')
  assert.equal(res.status, 403)
  const body = await res.json() as { error: { capability: string } }
  assert.equal(body.error.capability, 'models:unload')
})

test('unload succeeds with models:unload and stops the engine', async () => {
  const h = mkDeps([key('tllm-a', ['models:unload'])], [entry({})])
  const res = await post(app(h.d), '/api/link/v1/models/unload', 'tllm-a')
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { ok: true })
  assert.equal(h.stops.n, 1)
})

test('loading a model outside the grant allowlist is 403', async () => {
  const h = mkDeps(
    [key('tllm-a', ['models:load'], ['gemma-27b'])],
    [entry({ key: 'qwen3-35b' }), entry({ key: 'gemma-27b' })],
  )
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', { modelKey: 'qwen3-35b' })
  assert.equal(res.status, 403)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.loads, [])
})

test('the allowlist check is exact — a similarly-named model is refused', async () => {
  const h = mkDeps(
    [key('tllm-a', ['models:load'], ['qwen3-35b'])],
    [entry({ key: 'qwen3-35b' }), entry({ key: 'qwen3-35b-instruct' })],
  )
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', { modelKey: 'qwen3-35b-instruct' })
  assert.equal(res.status, 403)
})

test('an unknown model key is a clean 404, not a 500', async () => {
  const h = mkDeps([key('tllm-a', ['models:load'])], [entry({ key: 'qwen3-35b' })])
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', { modelKey: 'nope-9b' })
  assert.equal(res.status, 404)
  const body = await res.json() as { error: { code: string } }
  assert.equal(body.error.code, 'no_such_model')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.loads, [])
})

test('a missing modelKey is 400 — it never falls through to the host lastLoaded/devModel path', async () => {
  const h = mkDeps([key('tllm-a', ['models:load'])], [entry({ key: 'qwen3-35b' })])
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', {})
  assert.equal(res.status, 400)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.loads, [])
})

test('a second load while one is in flight serializes through the existing swap chain', async () => {
  const h = mkDeps(
    [key('tllm-a', ['models:load'])],
    [entry({ key: 'qwen3-35b' }), entry({ key: 'gemma-27b' })],
    { blockLoad: true },
  )
  const a = app(h.d)
  assert.equal((await post(a, '/api/link/v1/models/load', 'tllm-a', { modelKey: 'qwen3-35b' })).status, 202)
  assert.equal((await post(a, '/api/link/v1/models/load', 'tllm-a', { modelKey: 'gemma-27b' })).status, 202)
  await new Promise((r) => setTimeout(r, 20))
  // Only the FIRST load has started: the second is queued behind the real swapChain.
  assert.deepEqual(h.loads, ['qwen3-35b'])
  h.finishLoad()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(h.loads, ['qwen3-35b', 'gemma-27b'])
})

test('the ComfyUI guard applies to a remote caller exactly as it does locally', async () => {
  const h = mkDeps([key('tllm-a', ['models:load'])], [entry({})], { comfyBlocked: true })
  const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', { modelKey: 'qwen3-35b' })
  assert.equal(res.status, 409)
  const body = await res.json() as { error: { code: string } }
  assert.equal(body.error.code, 'comfyui_busy')
})

test('no host filesystem detail crosses the façade on any load outcome', async () => {
  const models = [entry({ key: 'qwen3-35b', path: 'D:\\models\\qwen3-35b.gguf' })]
  const cases: Array<[string[], unknown, string]> = [
    [['models:load'], { modelKey: 'qwen3-35b' }, 'ok'],
    [['models:load'], { modelKey: 'nope-9b' }, '404'],
    [['models:use'], { modelKey: 'qwen3-35b' }, '403'],
    [['models:load'], {}, '400'],
  ]
  for (const [caps, body, label] of cases) {
    const h = mkDeps([key('tllm-a', caps)], models)
    const res = await post(app(h.d), '/api/link/v1/models/load', 'tllm-a', body)
    const text = await res.text()
    assert.ok(!text.includes(':\\'), `${label}: leaked a windows path`)
    assert.ok(!text.includes('D:\\models'), `${label}: leaked the model dir`)
    assert.ok(!/\/(home|Users)\//.test(text), `${label}: leaked a posix home path`)
    assert.ok(!text.includes('llama-server'), `${label}: leaked the engine binary`)
  }
})

test('an unauthenticated caller cannot reach load or unload at all', async () => {
  const h = mkDeps([key('tllm-a', ['models:load', 'models:unload'])], [entry({})])
  const a = app(h.d)
  const load = await a.request('/api/link/v1/models/load', { method: 'POST', body: '{}' })
  const unload = await a.request('/api/link/v1/models/unload', { method: 'POST' })
  assert.equal(load.status, 401)
  assert.equal(unload.status, 401)
})

// ---- LinkClient ----

function client(fetchImpl: typeof fetch) {
  return new LinkClient({ baseUrl: 'https://host.example', token: 'tllm-a' }, { fetchImpl })
}

function jsonRes(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('LinkClient.load posts the model key to the façade', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const c = client((async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return jsonRes({ ok: true })
  }) as unknown as typeof fetch)
  const res = await c.load('qwen3-35b')
  assert.equal(res.kind, 'accepted')
  assert.equal(seen[0]!.url, 'https://host.example/api/link/v1/models/load')
  assert.equal(seen[0]!.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { modelKey: 'qwen3-35b' })
  assert.equal((seen[0]!.init.headers as Record<string, string>)['X-TurboLLM-Auth'], 'tllm-a')
})

test('LinkClient.unload posts to the unload route', async () => {
  const seen: string[] = []
  const c = client((async (url: string) => { seen.push(url); return jsonRes({ ok: true }) }) as unknown as typeof fetch)
  const res = await c.unload()
  assert.equal(res.kind, 'accepted')
  assert.deepEqual(seen, ['https://host.example/api/link/v1/models/unload'])
})

test('LinkClient load/unload never throw — they inherit call()\'s total contract', async () => {
  const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
  assert.deepEqual(await client(boom).load('qwen3-35b'), { kind: 'network' })
  assert.deepEqual(await client(boom).unload(), { kind: 'network' })
})

test('LinkClient surfaces a capability refusal as an http probe, not a throw', async () => {
  const denied = (async () => new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  assert.deepEqual(await client(denied).load('qwen3-35b'), { kind: 'http', status: 403 })
  assert.deepEqual(await client(denied).unload(), { kind: 'http', status: 403 })
})

test('LinkClient rejects a non-JSON 200 rather than reporting success', async () => {
  const html = (async () => new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  assert.deepEqual(await client(html).load('qwen3-35b'), { kind: 'network' })
})
