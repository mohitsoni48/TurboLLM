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

function store(): ConfigStore {
  return {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 1 }, modelProfiles: {}, comfyui: {} }),
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
