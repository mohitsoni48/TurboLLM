// `GET /api/v1/status` counts the models loaded beside the primary (`poolModels`). The Android app keeps its service
// while any model is loaded, and read only the primary engine's state, `jev` and `laya`: an embedding model loaded in
// its own pool slot beside a chat model that was then ejected read as nothing loaded, so with notifications off the
// service stopped under it. Driven through the real routes and a real ModelRouter, its pool slot seeded as
// model-router.test.ts does, or loaded through it with a slot whose load waits, as model-router.laya.test.ts's does.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ModelRouter } from '../gateway/model-router'
import type { Deps } from '../deps'
import type { Manager, StartOpts, Status } from '../engines/manager'
import type { ConfigStore } from '../config/config'
import type { ModelEntry } from '../models/scanner'

/** A Manager double running `modelKey` until stop() is called. */
function managerRunning(modelKey: string) {
  let state: Status['state'] = 'running'
  return {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model: state === 'stopped' ? null : { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false }, loadElapsedMs: 0 }),
    stop: () => { state = 'stopped' },
    currentOpts: () => null,
    restartOpts: () => null,
    launchCommand: () => undefined,
    parallelSlots: () => 1,
    sessionStats: () => null,
    liveGeneration: () => null,
  }
}

/** A pool-slot Manager double whose load waits for `gate` with its state unchanged ('stopped'), as the real one's does
 *  while it waits for the load gate, then runs the model. */
function gatedSlot(gate: Promise<void>) {
  let state: Status['state'] = 'stopped'
  let opts: StartOpts | null = null
  let loads = 0
  const manager = {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model: state === 'stopped' ? null : opts!.model, loadElapsedMs: 0 }),
    load: async (o: StartOpts, hooks?: { beforeStart?: () => Promise<void> }) => {
      loads++
      await gate
      await hooks?.beforeStart?.()
      opts = o
      state = 'running'
    },
    stop: () => { state = 'stopped' },
    target: () => (state === 'running' ? 'http://slot.invalid' : null),
    touch: () => {},
    currentOpts: () => (state === 'stopped' ? null : opts),
    restartOpts: () => null,
  }
  return { manager, loads: () => loads }
}

/** `slot`: the manager the router gives a new pool slot (ModelRouter's newSlotManager). */
function app(slot?: Manager) {
  const cfg: Record<string, unknown> = {
    gateway: { autoSwap: true, keepN: 2 },
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
    lastLoaded: { modelKey: '', engineId: '' },
    modelProfiles: {},
    comfyui: {},
  }
  const store = { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => '/nonexistent' } as unknown as ConfigStore
  const primary = managerRunning('chat-model')
  const embedding = {
    key: 'bge-m3', name: 'bge-m3', path: '/models/bge-m3.gguf', format: 'gguf', arch: 'bert', quant: 'Q4', nativeCtx: 8192,
    vision: false, embedding: true, incomplete: false, parseError: null,
  } as unknown as ModelEntry
  const scanner = { list: () => ({ models: [embedding] }), get: (k: string) => (k === 'bge-m3' ? embedding : undefined) }
  const registry = {
    active: () => ({ id: 'eng-1', name: 'llama.cpp', kind: 'llama-server', binPath: '/opt/llama-server', capabilities: { flags: [], kvTypes: [] } }),
    layaEngine: () => undefined,
  }
  const modelRouter = new ModelRouter(store, registry as never, primary as unknown as Manager, scanner as never, undefined, undefined, () => slot!)
  const d = {
    version: 'test',
    store,
    manager: primary,
    registry,
    modelRouter,
    scanner,
    bench: { status: () => ({ running: false }), cancel: () => {} },
    downloads: { activeCount: () => 0 },
    provision: { get: () => undefined },
    build: { get: () => undefined },
  } as unknown as Deps
  const a = new Hono()
  registerApi(a, d)
  /** An embedding model loaded into its own pool slot beside the primary (startEngine's loadExplicit). */
  const loadBeside = () => {
    ;(modelRouter as unknown as { extraSlots: Map<string, unknown> }).extraSlots.set('bge-m3', { manager: managerRunning('bge-m3'), modelKey: 'bge-m3', lastUsedMs: 0 })
  }
  const poolModels = async () => ((await (await a.request('/api/v1/status')).json()) as { poolModels?: number }).poolModels
  const stop = (modelKey?: string) => a.request('/api/v1/engine/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(modelKey ? { modelKey } : {}) })
  return { primary, modelRouter, loadBeside, poolModels, stop }
}

test('GET /api/v1/status counts a model loaded beside the primary in poolModels, and drops it once unloaded', async () => {
  const h = app()
  assert.equal(await h.poolModels(), 0, 'the primary alone')
  h.loadBeside()
  assert.equal(await h.poolModels(), 1, 'an embedding model in its own pool slot')
  // The chat model ejected: the embedding model is still loaded, and still counted.
  assert.equal((await h.stop()).status, 202)
  assert.equal(h.primary.status().state, 'stopped')
  assert.equal(await h.poolModels(), 1)
  // Its own Eject unloads it.
  assert.equal((await h.stop('bge-m3')).status, 202)
  assert.equal(await h.poolModels(), 0)
})

// A pool slot is registered only once its load has succeeded (aliveSlots() leaves the load out), and /api/v1/activity's
// load item covers only the primary's: an embedding model still loading beside a chat model that was then ejected read
// as nothing loaded, so with notifications off the Android service stopped during that load.
test('GET /api/v1/status counts a model still loading into a pool slot of its own in poolModels', async () => {
  let open!: () => void
  const slot = gatedSlot(new Promise<void>((r) => { open = r }))
  const h = app(slot.manager as unknown as Manager)
  // The Load button's path for an embedding model (startEngine): a pool slot of its own beside the running chat model.
  const loading = h.modelRouter.loadExplicit('bge-m3', undefined, { manual: true })
  for (let i = 0; slot.loads() === 0 && i < 100; i++) await new Promise((r) => setImmediate(r))
  assert.equal(slot.loads(), 1, 'the load reached its pool slot')
  assert.equal(await h.poolModels(), 1, 'the embedding model mid-load')
  // The chat model ejected while it loads: it is the one model left, still loading.
  assert.equal((await h.stop()).status, 202)
  assert.equal(h.primary.status().state, 'stopped')
  assert.equal(await h.poolModels(), 1, 'still loading, nothing else loaded')
  open()
  assert.deepEqual(await loading, { target: 'http://slot.invalid', engineKind: 'llama-server', modelPath: '/models/bge-m3.gguf', modelName: 'bge-m3' })
  assert.equal(await h.poolModels(), 1, 'loaded in its own slot, counted once')
})
