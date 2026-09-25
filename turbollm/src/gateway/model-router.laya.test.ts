// A Laya model loads on the Laya engine whatever engine is active, and — like an embedding model — beside the
// chat model rather than in place of it: it is a side model a few hundred MB to a few GB in size, not a chat slot.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelRouter } from './model-router'
import type { Manager, StartOpts, Status } from '../engines/manager'
import type { ConfigStore, Engine } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'

const LLAMA: Engine = { id: 'llama', kind: 'llama-server', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine
const LAYA_ENGINE: Engine = { id: 'laya', kind: 'laya', binPath: '/venv/bin/python', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine

const LAYA_MODEL = {
  key: 'laya|laya|1455', name: 'laya', path: '/models/laya', format: 'mlx', quant: 'fp16', nativeCtx: 512,
  vision: false, embedding: false, incomplete: false, parseError: null, laya: { checkpoints: ['english', 'multilingual'] },
} as unknown as ModelEntry
const CHAT_MODEL = {
  key: 'qwen', name: 'qwen', path: '/models/qwen.gguf', format: 'gguf', quant: 'Q4', nativeCtx: 4096,
  vision: false, embedding: false, incomplete: false, parseError: null,
} as unknown as ModelEntry

function store(keepN = 1): ConfigStore {
  return {
    snapshot: () => ({ gateway: { autoSwap: true, keepN }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
}

function scannerOf(...models: ModelEntry[]): Scanner {
  return {
    list: () => ({ models, scanning: false, lastScanAt: '' }),
    get: (key: string) => models.find((m) => m.key === key),
  } as unknown as Scanner
}

function registry(layaInstalled: boolean): Registry {
  return { active: () => LLAMA, layaEngine: () => (layaInstalled ? LAYA_ENGINE : undefined) } as unknown as Registry
}

/** A primary that starts stopped and records every load. */
function stoppedPrimary() {
  const loads: StartOpts[] = []
  let state: Status['state'] = 'stopped'
  const manager = {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    load: async (opts: StartOpts) => { loads.push(opts); state = 'running' },
    target: () => 'http://laya-slot',
    touch: () => {},
  } as unknown as Manager
  return { manager, loads }
}

function runningPrimary(modelKey: string): Manager {
  return {
    status: (): Status => ({
      state: 'running', err: null, port: 0, pid: 0, loadElapsedMs: 0,
      model: { key: modelKey, name: modelKey, quant: '', ctx: 0, vision: false },
    }),
  } as unknown as Manager
}

test('routeTo: a Laya model loads on the Laya engine while llama.cpp is the active engine', async () => {
  const primary = stoppedPrimary()
  const slot = stoppedPrimary()
  const r = new ModelRouter(store(), registry(true), primary.manager, scannerOf(LAYA_MODEL), undefined, undefined, () => slot.manager)
  const result = await r.routeTo(LAYA_MODEL)
  assert.deepEqual(result, { target: 'http://laya-slot' })
  assert.equal(slot.loads.length, 1)
  assert.equal(slot.loads[0].engine.kind, 'laya')
  assert.equal(slot.loads[0].modelPath, '/models/laya')
})

test('routeTo: a Laya model never takes the primary, even an empty one — the chat screen talks to the primary', async () => {
  const primary = stoppedPrimary()
  const slot = stoppedPrimary()
  const r = new ModelRouter(store(), registry(true), primary.manager, scannerOf(LAYA_MODEL), undefined, undefined, () => slot.manager)
  await r.routeTo(LAYA_MODEL)
  assert.deepEqual(primary.loads, [])
  assert.deepEqual([...r.loadedModelKeys()], [LAYA_MODEL.key, LAYA_MODEL.path])
})

test('routeTo: a Laya model with no Laya engine installed is refused with the reason and never loads', async () => {
  const { manager, loads } = stoppedPrimary()
  const r = new ModelRouter(store(), registry(false), manager, scannerOf(LAYA_MODEL), undefined)
  const result = await r.routeTo(LAYA_MODEL)
  assert.deepEqual(result, {
    status: 503,
    message: 'This is a Laya model — it runs only on the Laya engine. Install Laya from Engines to load it.',
  })
  assert.deepEqual(loads, [])
})

test('a Laya model in the primary does not take the chat slot', () => {
  const r = new ModelRouter(store(), registry(true), runningPrimary(LAYA_MODEL.key), scannerOf(LAYA_MODEL, CHAT_MODEL), undefined)
  const chatSlots = (r as unknown as { chatSlotCount: () => number }).chatSlotCount()
  assert.equal(chatSlots, 0)
})

test('a chat model in the primary still takes the chat slot', () => {
  const r = new ModelRouter(store(), registry(true), runningPrimary(CHAT_MODEL.key), scannerOf(LAYA_MODEL, CHAT_MODEL), undefined)
  const chatSlots = (r as unknown as { chatSlotCount: () => number }).chatSlotCount()
  assert.equal(chatSlots, 1)
})

// ── loads in flight ────────────────────────────────────────────────────────────
// The real Manager.load() does not report 'starting' at once: a fresh manager stays 'stopped' while it waits for the
// global load gate, the ComfyUI free call and a port. The fake mirrors that ordering so the router is tested through
// the window a request can land in. The v1.14.1 Opus review found that registering the pool slot before load() opened
// races there (an orphaned engine, a duplicate, another model's engine answering), so a pool slot is registered only
// once its load has succeeded, and a Laya load in flight is tracked on the side.

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** A slot manager like the real one: waits on the gate with its state unchanged, then 'starting', then 'running'. */
function gatedSlot(gate: Promise<void>, { failsToStart = false } = {}) {
  let state: Status['state'] = 'stopped'
  let loadedKey: string | null = null
  let stops = 0
  let loads = 0
  const manager = {
    status: (): Status => ({
      state, err: null, port: 0, pid: 0, loadElapsedMs: 0,
      model: loadedKey ? { key: loadedKey, name: loadedKey, quant: '', ctx: 0, vision: false } : null,
    }),
    load: async (opts: StartOpts) => {
      loads++
      await gate
      state = 'starting'
      await tick()
      if (failsToStart) { state = 'error'; return }
      state = 'running'
      loadedKey = opts.model.key
    },
    stop: () => { stops++; if (state === 'running' || state === 'starting') state = 'stopped' },
    target: () => 'http://laya-slot',
    touch: () => {},
  } as unknown as Manager
  return { manager, stops: () => stops, loads: () => loads }
}

function routerWithSlots(gate: Promise<void>, options: { keepN?: number; models?: ModelEntry[]; failsToStart?: boolean } = {}) {
  const made: ReturnType<typeof gatedSlot>[] = []
  const models = options.models ?? [LAYA_MODEL]
  const r = new ModelRouter(store(options.keepN), registry(true), stoppedPrimary().manager, scannerOf(...models), undefined, undefined, () => {
    const slot = gatedSlot(gate, { failsToStart: options.failsToStart })
    made.push(slot)
    return slot.manager
  })
  return { r, made }
}

test('a Laya model is alive as "starting" from the moment its load is requested, even while its manager still waits on the gate', async () => {
  const gate = deferred()
  const { r, made } = routerWithSlots(gate.promise)
  const loading = r.routeTo(LAYA_MODEL)
  await tick()
  assert.equal(made[0].manager.status().state, 'stopped', 'precondition: the manager has not started yet')
  assert.deepEqual(r.aliveSlots().map((s) => ({ key: s.modelKey, state: s.state, primary: s.primary })), [
    { key: LAYA_MODEL.key, state: 'starting', primary: false },
  ])
  assert.ok(r.loadedModelKeys().has(LAYA_MODEL.key))
  gate.resolve()
  await loading
  assert.deepEqual(r.aliveSlots().map((s) => s.state), ['running'])
})

test('two requests for the same Laya model at once start one engine and both get its target', async () => {
  const gate = deferred()
  const { r, made } = routerWithSlots(gate.promise)
  const first = r.routeTo(LAYA_MODEL)
  await tick()
  const second = r.routeTo(LAYA_MODEL)
  await tick()
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), [{ target: 'http://laya-slot' }, { target: 'http://laya-slot' }])
  assert.equal(made.length, 1, 'one manager, so one engine process')
  assert.equal(made[0].loads(), 1)
  assert.equal(made[0].stops(), 0)
  assert.equal(r.aliveSlots().length, 1)
})

test('a Laya load that fails leaves no slot behind', async () => {
  const gate = deferred()
  const { r } = routerWithSlots(gate.promise, { failsToStart: true })
  const loading = r.routeTo(LAYA_MODEL)
  await tick()
  gate.resolve()
  const result = await loading
  assert.equal('status' in result && result.status, 503)
  assert.deepEqual(r.aliveSlots(), [])
  assert.equal(r.loadedModelKeys().has(LAYA_MODEL.key), false)
})

test('ejecting a Laya model before its engine has spawned cancels the load: nothing is left running untracked', async () => {
  const gate = deferred()
  const { r, made } = routerWithSlots(gate.promise)
  const loading = r.routeTo(LAYA_MODEL)
  await tick()
  assert.equal(r.stopExplicit(LAYA_MODEL.key), true)
  assert.deepEqual(r.aliveSlots(), [], 'an ejected model is no longer alive')
  gate.resolve()
  const result = await loading
  assert.equal('status' in result && result.status, 503)
  assert.equal(made[0].manager.status().state, 'stopped', 'the engine that spawned after the eject is stopped again')
  assert.deepEqual(r.aliveSlots(), [])
  assert.equal(r.loadedModelKeys().has(LAYA_MODEL.key), false)
})

test('ejecting a Laya model while its engine is starting stops it', async () => {
  const gate = deferred()
  const { r, made } = routerWithSlots(gate.promise)
  const loading = r.routeTo(LAYA_MODEL)
  gate.resolve()
  await tick()
  assert.equal(made[0].manager.status().state, 'starting', 'precondition')
  assert.equal(r.stopExplicit(LAYA_MODEL.key), true)
  await loading
  assert.equal(made[0].manager.status().state, 'stopped')
  assert.deepEqual(r.aliveSlots(), [])
})

test('a chat model in a pool slot is registered only once it has loaded, as before', async () => {
  const gate = deferred()
  const chat = (key: string) => ({ ...CHAT_MODEL, key, name: key, path: `/m/${key}` }) as unknown as ModelEntry
  const models = [chat('A'), chat('B')]
  const { r } = routerWithSlots(Promise.resolve(), { keepN: 2, models })
  // A takes the empty primary; B needs a pool slot.
  await r.route('A')
  const held = gatedSlot(gate.promise)
  ;(r as unknown as { newSlotManager: () => Manager }).newSlotManager = () => held.manager
  const loadingB = r.route('B')
  await tick()
  assert.equal(r.aliveSlots().some((s) => s.modelKey === 'B'), false, 'nothing can be routed to B before it is loaded')
  assert.equal(r.loadedModelKeys().has('B'), false)
  gate.resolve()
  assert.deepEqual(await loadingB, { target: 'http://laya-slot' })
  assert.equal(r.aliveSlots().some((s) => s.modelKey === 'B' && s.state === 'running'), true)
})
