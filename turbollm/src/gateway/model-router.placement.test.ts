// Free-VRAM placement of a default-profile pool-slot load (scalability review 4.7). keep-N > 1 sized every default
// profile against EMPTY cards, so the third model on 2x24 GB loaded ngl 99 into full ones. The router now reads each
// card's use right before such a load (an injected reading here: no nvidia-smi) and places the default on the card that
// has room, or evicts an idle LRU slot when none does. A profile the user set is untouched (ADR-060).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelRouter } from './model-router'
import type { Manager, StartOpts, Status } from '../engines/manager'
import type { ConfigStore, Engine } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

const TWO_24: SysInfo = {
  os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
  gpus: [0, 1].map((i) => ({ name: `gpu${i}`, vramMb: 24000, vendor: 'nvidia' as const })),
}

function entry(key: string): ModelEntry {
  return {
    key, name: key, path: `/models/${key}.gguf`, dir: '/models', format: 'gguf',
    sizeBytes: 8e9, sizeLabel: '', arch: 'llama', quant: 'Q4_K_M',
    nativeCtx: 32768, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false, benchTps: null, mtime: '',
  } as ModelEntry
}

/** A Manager double that records its load and comes up running with it. */
function engine(modelKey: string | null, activeRequests = 0) {
  let state: Status['state'] = modelKey ? 'running' : 'stopped'
  let model: Status['model'] = modelKey ? { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false } : null
  const loads: StartOpts[] = []
  const manager = {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
    sessionStats: () => ({ activeRequests }),
    isHeld: () => false,
    currentOpts: () => null,
    restartOpts: () => null,
    target: () => 'http://engine',
    touch: () => {},
    load: async (opts: StartOpts, hooks?: { beforeStop?: () => void; beforeStart?: () => Promise<void> }) => {
      hooks?.beforeStop?.()
      await hooks?.beforeStart?.()
      loads.push(opts)
      model = { key: opts.model.key, name: opts.model.name, quant: 'Q4', ctx: 4096, vision: false }
      state = 'running'
    },
  } as unknown as Manager
  return { manager, loads }
}

const LLAMA = { id: 'eng1', kind: 'llama-server', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine

/** `readings`: what each successive read of the cards' use returns (the last repeats); null: unreadable. */
type Reading = number[] | null
function setup(readings: Reading | Reading[], opts: { modelProfiles?: unknown; primaryBusy?: number; slotBusy?: number; comfyEnabled?: boolean } = {}) {
  const seq: Reading[] = readings !== null && typeof readings[0] !== 'number' ? (readings as Reading[]) : [readings as Reading]
  const primary = engine('model-a', opts.primaryBusy)
  const slot = engine('model-b', opts.slotBusy)
  const fresh = engine(null)
  const cfg = { gateway: { autoSwap: true, keepN: 3 }, modelProfiles: opts.modelProfiles ?? {}, comfyui: { enabled: !!opts.comfyEnabled } }
  const store = { snapshot: () => cfg, read: () => cfg, update: (fn: (c: object) => void) => fn({}) } as unknown as ConfigStore
  const scanner = { list: () => ({ models: [entry('model-c')] }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => LLAMA } as unknown as Registry
  let reads = 0
  const fresh_: boolean[] = []
  const gpuUse = async (_engine: Engine, fresh = false) => { fresh_.push(fresh); const usedMb = seq[Math.min(reads++, seq.length - 1)]; return usedMb ? { sys: TWO_24, usedMb } : null }
  const r = new ModelRouter(store, registry, primary.manager, scanner, undefined, undefined, () => fresh.manager, gpuUse, () => TWO_24)
  ;(r as unknown as { extraSlots: Map<string, unknown> }).extraSlots = new Map([['model-b', { manager: slot.manager, modelKey: 'model-b', lastUsedMs: Date.now() }]])
  ;(r as unknown as { primaryLastUsed: number }).primaryLastUsed = 1
  return { r, primary, slot, fresh, reads: () => reads, freshReads: () => fresh_ }
}

const flag = (o: StartOpts, name: string) => { const i = o.extraArgs.indexOf(name); return i < 0 ? undefined : o.extraArgs[i + 1] }

test('two models on card 0: the third default model is placed on card 1', async () => {
  const { r, fresh, primary } = setup([21000, 500])
  const result = await r.route('model-c')
  assert.ok('target' in result, JSON.stringify(result))
  assert.equal(fresh.loads.length, 1, 'a new slot, nothing evicted')
  assert.equal(primary.loads.length, 0)
  assert.equal(flag(fresh.loads[0], '--split-mode'), 'none')
  assert.equal(flag(fresh.loads[0], '--main-gpu'), '1')
})

test('empty cards: the default even split is untouched', async () => {
  const { r, fresh } = setup([0, 0])
  await r.route('model-c')
  assert.equal(flag(fresh.loads[0], '--split-mode'), undefined)
  assert.equal(flag(fresh.loads[0], '--main-gpu'), undefined)
})

test('no card has room: the idle least-recently-used engine is evicted and the model loads there', async () => {
  const { r, fresh, primary } = setup([23000, 23000])
  const result = await r.route('model-c')
  assert.ok('target' in result, JSON.stringify(result))
  assert.equal(primary.loads.length, 1, 'the primary (LRU, idle) was reloaded with the new model')
  assert.equal(primary.loads[0].model.key, 'model-c')
  assert.equal(fresh.loads.length, 0, 'no extra slot beyond the one it replaced')
  assert.equal(r.loadedModelKeys().has('model-b'), true, 'the more recently used slot stays')
})

test('no card has room and every engine is generating: a retryable busy 503, nothing stopped', async () => {
  const { r, fresh, primary } = setup([23000, 23000], { primaryBusy: 1, slotBusy: 1 })
  const result = await r.route('model-c')
  assert.ok('status' in result)
  assert.equal(result.status, 503)
  assert.equal(result.reason, 'busy')
  assert.equal(result.permanent, undefined)
  assert.equal(primary.loads.length + fresh.loads.length, 0)
})

test('a gpu block the user saved is respected exactly, and VRAM is not even read', async () => {
  const saved = { profile: { gpu: { splitMode: 'none', tensorSplit: [], mainGpu: 0, tensorParallelSize: 1 }, userSetOnly: true }, updatedAt: '2026-01-01' }
  const { r, fresh, reads } = setup([21000, 500], { modelProfiles: { 'model-c': { eng1: saved } } })
  await r.route('model-c')
  assert.equal(flag(fresh.loads[0], '--main-gpu'), '0', "the user's card, though card 0 is full")
  assert.equal(reads(), 0)
})

test('VRAM that cannot be read: today\'s behaviour, a new slot with the default profile', async () => {
  const { r, fresh, primary } = setup(null)
  const result = await r.route('model-c')
  assert.ok('target' in result)
  assert.equal(fresh.loads.length, 1)
  assert.equal(primary.loads.length, 0)
  assert.equal(flag(fresh.loads[0], '--main-gpu'), undefined)
})

test('a reading that throws does not stop the load', async () => {
  const { r, fresh } = setup([21000, 500])
  ;(r as unknown as { gpuUse: () => Promise<never> }).gpuUse = () => Promise.reject(new Error('smi'))
  await r.route('model-c')
  assert.equal(fresh.loads.length, 1)
})

test('ComfyUI integration on: no VRAM reading and no placement, its resident models would read as used (H2)', async () => {
  const { r, fresh, primary, reads } = setup([23000, 23000], { comfyEnabled: true })
  const result = await r.route('model-c')
  assert.ok('target' in result, JSON.stringify(result))
  assert.equal(reads(), 0)
  assert.equal(primary.loads.length, 0, 'no eviction for memory held by ComfyUI')
  assert.equal(fresh.loads.length, 1)
  assert.equal(flag(fresh.loads[0], '--main-gpu'), undefined)
})

test('after the eviction the placement is recomputed from a fresh reading', async () => {
  // Full cards, so the LRU engine goes; once it is stopped card 1 is free and the model is placed there.
  const { r, primary, freshReads } = setup([[23000, 23000], [21000, 500]])
  await r.route('model-c')
  assert.equal(primary.loads.length, 1)
  assert.equal(flag(primary.loads[0], '--split-mode'), 'none')
  assert.equal(flag(primary.loads[0], '--main-gpu'), '1')
  assert.deepEqual(freshReads(), [false, true], 'the second reading skips the cache')
})

test('an eviction that did not make room loads the default profile and evicts nothing more', async () => {
  const { r, primary, slot, fresh, reads } = setup([23000, 23000])
  const result = await r.route('model-c')
  assert.ok('target' in result, JSON.stringify(result))
  assert.equal(reads(), 2)
  assert.equal(primary.loads.length, 1)
  assert.equal(flag(primary.loads[0], '--main-gpu'), undefined, 'the default profile, as before placement existed')
  assert.equal(fresh.loads.length, 0)
  assert.equal(slot.loads.length, 0, 'the second engine is not touched')
})

test('requests alternating between two loaded models do not read the cards or evict anything', async () => {
  const { r, primary, slot, reads } = setup([23000, 23000])
  for (const key of ['model-a', 'model-b', 'model-a', 'model-b']) await r.route(key)
  assert.equal(reads(), 0)
  assert.equal(primary.loads.length + slot.loads.length, 0)
})
