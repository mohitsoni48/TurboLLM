// A .litertlm loaded by path (POST /api/v1/engine/start {modelPath}, a migrated devModel) gets what a library entry with
// nothing set gets: no backend and no context in the --config file, so the server runs the model on its own backend.
// It got no LiteRT-LM config at all, and the Manager then wrote `{ default: { backend: 'cpu' } }`, which a GPU-only
// bundle (litert-community's gemma-4-E2B-it-gpu, an "artisan" decoder) cannot load on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { startEngine, type EngineStartBody } from './engine-lifecycle'
import { type Config, type Engine, defaultConfig } from '../config/config'
import type { Deps } from '../deps'
import type { StartOpts } from '../engines/manager'

function deps(engine: Engine): { d: Deps; loads: StartOpts[] } {
  const cfg: Config = defaultConfig()
  const loads: StartOpts[] = []
  const d = {
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    scanner: { get: () => undefined },
    manager: { load: (opts: StartOpts) => { loads.push(opts); return Promise.resolve() } },
    registry: { active: () => engine },
    modelRouter: { withSwapLock: (fn: () => unknown) => Promise.resolve(fn()), markPrimaryLoaded: () => {}, recordManualLoad: () => {} },
    bench: { cancel: () => {}, waitIdle: () => Promise.resolve() },
    comfy: undefined,
  } as unknown as Deps
  return { d, loads }
}

async function loadByPath(engine: Engine, body: EngineStartBody): Promise<StartOpts> {
  const { d, loads } = deps(engine)
  const app = new Hono()
  app.post('/start', async (c) => startEngine(c, d, await c.req.json<EngineStartBody>()))
  const res = await app.request('/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(res.status, 202)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(loads.length, 1)
  return loads[0]
}

const LITERT: Engine = {
  id: 'lrt', name: 'LiteRT-LM', kind: 'litert-lm', binPath: '/venv/bin/python', version: 'litert-lm 0.18.0',
  capabilities: { kvTypes: [], flags: [] }, addedAt: 't',
} as Engine

test('a .litertlm loaded by path names no backend and no context: the server runs the model on its own', async () => {
  const opts = await loadByPath(LITERT, { modelPath: '/models/gemma-4-E2B-it-gpu.litertlm' })
  assert.ok(opts.litertLmConfig, 'a LiteRT-LM config is built for it, as for a library entry')
  assert.equal(opts.litertLmConfig.default.backend, undefined)
  assert.equal(opts.litertLmConfig.default.max_num_tokens, undefined)
})

test('a load by path on another engine is left as it was: no LiteRT-LM config', async () => {
  const llama = { ...LITERT, id: 'll', kind: 'llama-server', binPath: 'llama-server' } as Engine
  const opts = await loadByPath(llama, { modelPath: '/models/m.gguf', extraArgs: ['-c', '4096'] })
  assert.equal(opts.litertLmConfig, undefined)
})
