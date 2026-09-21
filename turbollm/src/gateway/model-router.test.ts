// ModelRouter pool-state tests (F-033 loaded-model display).
// Contract under test:
//   • loadedModelKeys(): the union of model keys loaded (running|starting) across the
//     primary manager AND every alive extra pool slot — so gateway-loaded models show as
//     loaded on the Models page (F-033). Dead/stopped slots are excluded.
//
// We build only the light fakes the methods touch (Manager.status + ConfigStore.snapshot);
// registry/scanner/comfy are unused by these paths and cast through. The private extraSlots
// map is seeded directly via a typed cast — the same "reach into internals for a unit test"
// shape other tests use — since there's no public seeder that doesn't drive a real load.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ModelRouter } from './model-router'
import type { Manager, StartOpts, Status } from '../engines/manager'
import { defaultConfig, type Config, type ConfigStore, type Engine } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'

/** A Manager double exposing only status() (all the tested paths read). */
function fakeManager(state: Status['state'], modelKey: string | null): Manager {
  const model = modelKey
    ? { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false }
    : null
  return {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
  } as unknown as Manager
}

/** A ConfigStore double returning a fixed gateway snapshot. */
function fakeStore(gateway: { keepN: number }): ConfigStore {
  return {
    snapshot: () => ({ gateway: { autoSwap: true, ...gateway } }),
  } as unknown as ConfigStore
}

interface PoolSlotShape {
  manager: Manager
  modelKey: string
  lastUsedMs: number
}

/** Build a router with the given primary manager + seeded extra pool slots. The extraSlots
 *  map is private; we set it through a narrow cast rather than driving a real load. */
function router(
  primary: Manager,
  store: ConfigStore,
  slots: PoolSlotShape[] = [],
): ModelRouter {
  // Scanner stub: loadedModelKeys() calls scanner.get(key)?.path to also index by path;
  // returning undefined means "no path" so the set holds keys only (sufficient here).
  const scanner = { get: () => undefined } as never
  const r = new ModelRouter(store, {} as never, primary, scanner, undefined)
  const map = new Map<string, PoolSlotShape>()
  for (const s of slots) map.set(s.modelKey, s)
  ;(r as unknown as { extraSlots: Map<string, PoolSlotShape> }).extraSlots = map
  return r
}

const STORE = fakeStore({ keepN: 3 })

// ── loadedModelKeys (F-033) ───────────────────────────────────────────────────
test('loadedModelKeys: empty when nothing is loaded', () => {
  const r = router(fakeManager('stopped', null), STORE)
  assert.deepEqual([...r.loadedModelKeys()], [])
})

test('loadedModelKeys: primary-only returns just the primary key', () => {
  const r = router(fakeManager('running', 'llama-8b'), STORE)
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['llama-8b'])
})

test('loadedModelKeys: primary + alive pool slots returns the union', () => {
  const r = router(fakeManager('running', 'llama-8b'), STORE, [
    { manager: fakeManager('running', 'qwen-7b'), modelKey: 'qwen-7b', lastUsedMs: 0 },
    { manager: fakeManager('starting', 'gemma-2b'), modelKey: 'gemma-2b', lastUsedMs: 0 },
  ])
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['gemma-2b', 'llama-8b', 'qwen-7b'])
})

test('loadedModelKeys: includes starting state and excludes dead/stopped slots', () => {
  const r = router(fakeManager('starting', 'primary-loading'), STORE, [
    { manager: fakeManager('running', 'alive'), modelKey: 'alive', lastUsedMs: 0 },
    { manager: fakeManager('stopped', 'dead'), modelKey: 'dead', lastUsedMs: 0 },
    { manager: fakeManager('error', 'crashed'), modelKey: 'crashed', lastUsedMs: 0 },
  ])
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['alive', 'primary-loading'])
})

test('loadedModelKeys: pool-only (primary stopped) still reports pool slots', () => {
  const r = router(fakeManager('stopped', null), STORE, [
    { manager: fakeManager('running', 'qwen-7b'), modelKey: 'qwen-7b', lastUsedMs: 0 },
  ])
  assert.deepEqual([...r.loadedModelKeys()], ['qwen-7b'])
})

// ── stopExplicit ──────────────────────────────────────────────────────────────
// Regression for a real, live bug: ejecting an embedding model loaded into its own pool
// slot (ADR-389) actually stopped the PRIMARY (chat) manager instead — engine-lifecycle.ts's
// stopEngine() had no way to name which slot to stop, so it always called d.manager.stop()
// unconditionally. Retrying then did nothing, because the primary was already stopped and
// the embedding model was never in it to begin with.
test('stopExplicit: stops and removes the named extra slot, reports true', () => {
  const slotManager = fakeManager('running', 'bge-m3')
  let stopped = 0
  ;(slotManager as unknown as { stop: () => void }).stop = () => { stopped++ }
  const r = router(fakeManager('running', 'llama-8b'), STORE, [
    { manager: slotManager, modelKey: 'bge-m3', lastUsedMs: 0 },
  ])

  const result = r.stopExplicit('bge-m3')

  assert.equal(result, true)
  assert.equal(stopped, 1, 'the slot\'s own manager must be stopped')
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['llama-8b'], 'the slot is gone; the primary is untouched')
})

test('stopExplicit: a key naming no extra slot reports false and touches nothing', () => {
  const r = router(fakeManager('running', 'llama-8b'), STORE, [
    { manager: fakeManager('running', 'bge-m3'), modelKey: 'bge-m3', lastUsedMs: 0 },
  ])

  // 'llama-8b' is the PRIMARY's key, not an extra slot's — stopExplicit must not claim it.
  const result = r.stopExplicit('llama-8b')

  assert.equal(result, false)
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['bge-m3', 'llama-8b'], 'nothing was stopped')
})

// ── chatSlotCount / evictChatLru: 'stopping' must count as occupied ──────────────
// Regression for a real, live bug: a manual model swap (routes.ts's /api/v1/engine/start,
// which calls the PRIMARY manager directly, bypassing this router) passes the primary
// through a 'stopping' state on its way to the new model. A concurrent gateway request
// (e.g. a terminal-agent CLI's own request) landing in that window used to see
// chatSlotCount() read 0 (only running/starting counted as alive) even though a swap was
// already in flight, concluded a slot was free, and spun up a whole SECOND, independently
// tracked Manager/llama-server process — invisible to the primary's own status() and never
// cleaned up. Confirmed live: two concurrent llama-server.exe processes after a manual
// model switch with a terminal-agent session open, only one of which /api/v1/status knew
// about. `chatSlotCount`/`evictChatLru` are private — reached via the same narrow cast
// pattern used for extraSlots above rather than driving a real load() in a unit test.
function privates(r: ModelRouter) {
  return r as unknown as { chatSlotCount(): number; evictChatLru(): Manager }
}

test('chatSlotCount: a stopping primary still counts as an occupied slot', () => {
  const r = router(fakeManager('stopping', 'llama-8b'), fakeStore({ keepN: 1 }))
  assert.equal(privates(r).chatSlotCount(), 1)
})

test('chatSlotCount: stopping primary + keepN=1 means the pool is full (no room for a new slot)', () => {
  const r = router(fakeManager('stopping', 'llama-8b'), fakeStore({ keepN: 1 }))
  assert.equal(privates(r).chatSlotCount() < 1, false) // needsNewSlot's exact condition
})

test('evictChatLru: a stopping primary with no extra slots is returned as the LRU target (not skipped)', () => {
  const primary = fakeManager('stopping', 'llama-8b')
  const r = router(primary, fakeStore({ keepN: 1 }))
  assert.equal(privates(r).evictChatLru(), primary)
})

test('evictChatLru: a stopping primary beats an idle-but-newer extra slot as LRU when the primary is older', () => {
  const primary = fakeManager('stopping', 'llama-8b')
  const r = router(primary, fakeStore({ keepN: 1 }), [
    { manager: fakeManager('running', 'qwen-7b'), modelKey: 'qwen-7b', lastUsedMs: Date.now() },
  ])
  // primaryLastUsed defaults to 0 (older than the extra slot's fresh timestamp), so the
  // primary — correctly counted as occupied even mid-'stopping' — is the true LRU here.
  assert.equal(privates(r).evictChatLru(), primary)
})

// ── withSwapLock: manual switch vs. router auto-swap coordination ───────────────────
// Regression for a real, live bug: a manual model switch (routes.ts's /api/v1/engine/start,
// which calls the primary Manager directly, entirely outside this router) shared ONLY the
// lower-level Manager.runExclusive static gate with a concurrent router-triggered auto-swap
// (e.g. a terminal-agent session's own gateway traffic). That gate stops a double-SPAWN, but
// not a second caller independently deciding, mid-manual-switch, "the primary is occupied —
// evict it and load MY model instead" (evictChatLru() picks the primary whenever it's the
// only occupied slot, 'starting' included per ADR-285's isOccupied() fix). Whichever call
// physically won the gate queue silently decided which model ended up loaded — reading, from
// the UI that triggered the manual switch, exactly like "my switch reverted", with no error
// anywhere. Fixed by having the manual switch also acquire withSwapLock (the same queue
// route()/doLoad() use) before calling manager.load().

function fakeEngine(kind: string): Engine {
  return { id: 'eng1', kind, capabilities: { flags: [] } } as unknown as Engine
}

function fakeEntry(key: string): ModelEntry {
  return {
    key, name: key, quant: 'Q4', format: 'mlx', path: `/models/${key}`,
    nativeCtx: 4096, vision: false, embedding: false, incomplete: false, parseError: null,
  } as unknown as ModelEntry
}

/** A Manager double whose load() only resolves when the test calls finishLoad() — lets the
 *  test deterministically hold open the exact interleaving window a real race would need luck
 *  to hit. Records whether a second load() call ever started before the first one resolved —
 *  exactly the violation withSwapLock exists to prevent. */
function controllableManager() {
  let state: Status['state'] = 'stopped'
  let model: Status['model'] = null
  let inFlight = false
  let pendingResolve: (() => void) | null = null
  const calls: string[] = []
  let concurrentViolation = false
  const manager = {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
    target: () => 'http://127.0.0.1:9999',
    touch: () => {},
    load: (opts: { model: { key: string } }): Promise<void> => {
      calls.push(opts.model.key)
      if (inFlight) concurrentViolation = true
      inFlight = true
      state = 'starting'
      return new Promise<void>((resolve) => {
        pendingResolve = () => {
          model = { key: opts.model.key, name: opts.model.key, quant: 'Q4', ctx: 4096, vision: false }
          state = 'running'
          inFlight = false
          resolve()
        }
      })
    },
  } as unknown as Manager
  return { manager, finishLoad: () => pendingResolve?.(), calls, hadConcurrentViolation: () => concurrentViolation }
}

function fakeFullStore(): ConfigStore {
  return {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 1 }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
}

const tick = () => new Promise((res) => setImmediate(res))

test('withSwapLock: a manual switch blocks a concurrent auto-swap from racing the primary manager', async () => {
  const { manager, finishLoad, calls, hadConcurrentViolation } = controllableManager()
  const entryA = fakeEntry('model-a')
  const entryB = fakeEntry('model-b')
  const scanner = {
    list: () => ({ models: [entryA, entryB], scanning: false, lastScanAt: '' }),
    get: () => undefined,
  } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(fakeFullStore(), registry, manager, scanner, undefined)

  // Simulates routes.ts's manual switch: acquire withSwapLock, then call manager.load() directly.
  const manualSwitch = r.withSwapLock(() => manager.load({ model: { key: 'model-a' } } as never))
  await tick() // let the manual switch's synchronous portion run and actually call load()
  assert.deepEqual(calls, ['model-a'], 'manual switch should have started loading model-a')

  // A concurrent auto-swap for a DIFFERENT model arrives while the manual switch is still
  // mid-flight (primary state is 'starting', not yet resolved).
  const autoSwap = r.route('model-b')
  await tick()
  // Old code: doLoad() would call manager.load('model-b') immediately here, racing the
  // in-flight manual switch. New code: route() waits on the SAME swapChain the manual switch
  // holds, so it must NOT have started loading yet.
  assert.deepEqual(calls, ['model-a'], 'the auto-swap must be queued behind the manual switch, not racing it')

  finishLoad() // manual switch's load('model-a') resolves — model-a is now running
  await manualSwitch
  r.markPrimaryLoaded() // mirrors routes.ts's .then() chain after a real manual switch

  await tick() // let the now-unblocked auto-swap's doLoad() run up to its own load() call
  assert.deepEqual(calls, ['model-a', 'model-b'], 'the auto-swap should only start loading AFTER the manual switch fully settled')

  finishLoad() // resolves the auto-swap's load('model-b')
  const result = await autoSwap

  assert.ok('target' in result, `expected a successful RouteResult, got ${JSON.stringify(result)}`)
  assert.equal(hadConcurrentViolation(), false, 'no load() call should ever have started while another was still in flight')
})

// ── loadExplicit: autoSwap-independent pinned-model load (routine swaps) ────────
test('loadExplicit loads the requested model even when autoSwap is globally disabled', async () => {
  const scanner = {
    get: (key: string) => (key === 'target' ? { key: 'target', name: 'target', format: 'gguf' as const, path: '/models/target.gguf', nativeCtx: 4096 } : undefined),
    list: () => ({ models: [{ key: 'target', name: 'target', format: 'gguf' as const, path: '/models/target.gguf', nativeCtx: 4096 }] }),
  } as unknown as import('../models/scanner').Scanner
  let loadedWith: unknown = null
  // status() must flip to 'running' once load() resolves — doLoad()'s own post-load readiness
  // check reads status() again after awaiting load(), so a fixed 'stopped' mock (as if the
  // engine never actually started) would make doLoad() report a 503 here regardless of what
  // loadExplicit() does. Mirrors how this file's other Manager doubles (e.g. controllableManager)
  // track state through a load.
  let state: 'stopped' | 'running' = 'stopped'
  const primary = {
    status: () => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    load: async (opts: unknown) => { loadedWith = opts; state = 'running' },
    touch: () => {},
    target: () => 'http://127.0.0.1:8081',
  } as unknown as import('../engines/manager').Manager
  // update() is required — doLoad() calls store.update() to record lastLoaded on success,
  // matching this file's own fakeFullStore() convention above.
  const store = {
    snapshot: () => ({ gateway: { autoSwap: false, keepN: 1 }, modelProfiles: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as import('../config/config').ConfigStore
  // capabilities is required by doLoad's buildOpts -> profileToArgs (reads caps.flags/caps.kvTypes)
  // — matches this file's existing fakeEngine() helper (line ~151) rather than a bare {id, kind}.
  const registry = { active: () => ({ id: 'e1', kind: 'llama-cpp', capabilities: { flags: [], kvTypes: [] } }) } as unknown as import('../engines/registry').Registry
  const { ModelRouter } = await import('./model-router')
  const r = new ModelRouter(store, registry, primary, scanner, undefined)

  const result = await r.loadExplicit('target')

  assert.equal('target' in result, true)
  assert.ok(loadedWith, 'expected Manager.load to be called even though autoSwap is disabled')
})

// ── doLoad: the shared modelIncompatibility() rule (ADR-434 (g)) ──
// An auto-swap to a model the active engine cannot load answers 503 with the same message the
// manual load guard uses, before anything is evicted or loaded. That includes the audio check.
function recordingPrimary() {
  const loads: unknown[] = []
  const manager = {
    status: (): Status => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    load: async (opts: unknown) => { loads.push(opts) },
    target: () => null,
    touch: () => {},
  } as unknown as Manager
  return { manager, loads }
}

function autoSwapRouter(engineKind: string, entry: ModelEntry, primary: Manager): ModelRouter {
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => fakeEngine(engineKind) } as unknown as Registry
  return new ModelRouter(fakeFullStore(), registry, primary, scanner, undefined)
}

test('route: an audio-tower model on Rapid-MLX is refused with the audio message and never loads', async () => {
  const { manager, loads } = recordingPrimary()
  const audioModel = { ...fakeEntry('gemma-audio'), audio: true } as ModelEntry
  const r = autoSwapRouter('rapid-mlx', audioModel, manager)

  const result = await r.route('gemma-audio')

  assert.deepEqual(result, {
    status: 503,
    message:
      'Rapid-MLX cannot load models with an audio tower — the audio encoder fails due to an upstream mlx-vlm bug in the sanitizer for these architectures. Switch to the MLX engine instead.',
  })
  assert.deepEqual(loads, [])
})

test('route: a Jev model on llama.cpp is refused with the needs-vLLM message and never loads', async () => {
  const { manager, loads } = recordingPrimary()
  const jevModel = {
    ...fakeEntry('qwen3.5 4b nli v2'),
    jev: {
      labels: ['contradiction', 'entailment', 'neutral'],
      nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
      architecture: 'Qwen3_5ForSequenceClassification',
      verified: true,
    },
  } as ModelEntry
  const r = autoSwapRouter('llama-server', jevModel, manager)

  const result = await r.route('qwen3.5 4b nli v2')

  assert.deepEqual(result, {
    status: 503,
    message: 'This is a Jev model — it runs only on vLLM (Linux or WSL2). Activate a vLLM engine to load it.',
  })
  assert.deepEqual(loads, [])
})

test('loadExplicit reports 503 for an unknown model key without touching the manager', async () => {
  const scanner = { get: () => undefined, list: () => ({ models: [] }) } as unknown as import('../models/scanner').Scanner
  let loadCalled = false
  const primary = { status: () => ({ state: 'stopped', model: null }), load: async () => { loadCalled = true } } as unknown as import('../engines/manager').Manager
  const store = { snapshot: () => ({ gateway: { autoSwap: false, keepN: 1 } }) } as unknown as import('../config/config').ConfigStore
  const registry = { active: () => ({ id: 'e1', kind: 'llama-cpp' }) } as unknown as import('../engines/registry').Registry
  const { ModelRouter } = await import('./model-router')
  const r = new ModelRouter(store, registry, primary, scanner, undefined)

  const result = await r.loadExplicit('nonexistent')
  assert.equal('status' in result && result.status, 503)
  assert.equal(loadCalled, false)
})

// ── buildOpts: gateway loads build StartOpts through the one shared builder ──
// A source scan, as engine-lifecycle.shared-builder.test.ts does for startEngine: a re-introduced
// inline copy produces correct StartOpts on the day it lands, and only drifts later.
const MODEL_ROUTER_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'model-router.ts'), 'utf8')

const INLINE_BUILDER_CALLS = [
  'profileToArgs(',
  'koboldcppProfileToArgs(',
  'vllmProfileToArgs(',
  'mlxSamplingArgs(',
  'resolveProfile(',
  'getModelProfile(',
]

test('model-router.ts calls the shared buildStartOpts exactly once', () => {
  assert.equal(MODEL_ROUTER_SOURCE.split('buildStartOpts(').length - 1, 1)
})

test('model-router.ts resolves no profile and builds no engine args of its own', () => {
  const inlineCalls = INLINE_BUILDER_CALLS.filter((call) => MODEL_ROUTER_SOURCE.includes(call))

  assert.deepEqual(inlineCalls, [], `build these through buildStartOpts instead:\n${inlineCalls.join('\n')}`)
})

const OPENJEV_LAUNCH_TOKENS = [
  '--runner', 'pooling',
  '--convert', 'classify',
  '--hf-overrides', '{"architectures":["Qwen3_5ForConditionalGeneration"]}',
  '--limit-mm-per-prompt', '{"image":0,"video":0}',
]

function builderEngine(kind: string): Engine {
  return {
    id: 'eng1', name: kind, kind, binPath: 'llama-server', version: 'b1',
    capabilities: { kvTypes: [], flags: [] }, addedAt: 't',
  } as unknown as Engine
}

function builderEntry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    key: 'model-a', name: 'Model A', path: '/models/model-a.gguf', dir: '/models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'Q4_K_M', nativeCtx: 4096,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    ...overrides,
  } as unknown as ModelEntry
}

function routerWithConfig(cfg: Config): ModelRouter {
  const store = { snapshot: () => cfg } as unknown as ConfigStore
  return new ModelRouter(store, {} as never, fakeManager('stopped', null), {} as never, undefined)
}

function buildOptsOf(r: ModelRouter, entry: ModelEntry, engine: Engine): StartOpts | null {
  return (r as unknown as { buildOpts(e: ModelEntry, g: Engine): StartOpts | null }).buildOpts(entry, engine)
}

test('buildOpts: a Jev model auto-swapped onto vLLM launches with the verified flags', () => {
  const jevModel = builderEntry({
    key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', format: 'mlx', path: '/models/openjev/qwen3.5-4b-nli-v2',
    nativeCtx: 262144,
    jev: {
      labels: ['contradiction', 'entailment', 'neutral'],
      nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
      architecture: 'Qwen3_5ForSequenceClassification',
      verified: true,
    },
  })

  const opts = buildOptsOf(routerWithConfig(defaultConfig()), jevModel, builderEngine('vllm'))

  assert.deepEqual(opts?.extraArgs.slice(-OPENJEV_LAUNCH_TOKENS.length), OPENJEV_LAUNCH_TOKENS)
  assert.equal(opts?.trigger, 'gateway_switch')
})

test('buildOpts: a gateway load honours the saved profile pinned port', () => {
  const cfg = defaultConfig()
  cfg.modelProfiles['model-a'] = { eng1: { profile: { port: 6997 }, updatedAt: '2026-09-19T00:00:00.000Z' } }

  const opts = buildOptsOf(routerWithConfig(cfg), builderEntry({}), builderEngine('llama-server'))

  assert.equal(opts?.preferredPort, 6997)
})

test('buildOpts: an incomplete model builds nothing', () => {
  const opts = buildOptsOf(routerWithConfig(defaultConfig()), builderEntry({ incomplete: true }), builderEngine('llama-server'))

  assert.equal(opts, null)
})

// ── resolveLocal / targetEntry / routeTo / aliveSlots (ADR-060, ADR-376) ──
// routeTo routes to exactly the entry it is given and never falls back to whatever the primary
// holds; targetEntry answers "which local model would route() hit" without loading anything.
// Targets are opaque strings here: nothing is ever contacted.
const PRIMARY_TARGET = 'http://primary.invalid'
const BETA_SLOT_TARGET = 'http://slot-beta.invalid'

function namedEntry(key: string, name: string): ModelEntry {
  return { ...fakeEntry(key), name } as ModelEntry
}

const ALPHA = namedEntry('alpha-key', 'Alpha Model')
const BETA = namedEntry('beta-key', 'Beta')

/** A primary Manager double holding `loadedKey` (running) or nothing. Its load() throws, so a test
 *  that must not load anything fails loudly if it does. */
function primaryHolding(loadedKey: string | null): Manager {
  const model = loadedKey ? { key: loadedKey, name: loadedKey, quant: 'Q4', ctx: 4096, vision: false } : null
  return {
    status: (): Status => ({ state: loadedKey ? 'running' : 'stopped', err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
    target: () => (loadedKey ? PRIMARY_TARGET : null),
    touch: () => {},
    load: () => { throw new Error('this test must not load a model') },
  } as unknown as Manager
}

function slotManager(state: Status['state'], modelKey: string, target: string): Manager {
  const model = { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false }
  return {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
    target: () => target,
    touch: () => {},
  } as unknown as Manager
}

function routingRouter(opts: {
  models: ModelEntry[]
  primary: Manager
  autoSwap?: boolean
  slots?: PoolSlotShape[]
}): ModelRouter {
  const cfg = { gateway: { autoSwap: opts.autoSwap ?? true, keepN: 1 }, modelProfiles: {}, comfyui: {}, links: [] }
  const store = { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never) } as unknown as ConfigStore
  const scanner = {
    list: () => ({ models: opts.models }),
    get: (key: string) => opts.models.find((m) => m.key === key),
  } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(store, registry, opts.primary, scanner, undefined)
  const slots = new Map<string, PoolSlotShape>()
  for (const s of opts.slots ?? []) slots.set(s.modelKey, s)
  ;(r as unknown as { extraSlots: Map<string, PoolSlotShape> }).extraSlots = slots
  return r
}

test('resolveLocal: exact key, exact name, case-insensitive name, then substring', () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding(null) })

  assert.equal(r.resolveLocal('beta-key'), BETA)
  assert.equal(r.resolveLocal('Alpha Model'), ALPHA)
  assert.equal(r.resolveLocal('alpha model'), ALPHA)
  assert.equal(r.resolveLocal('pha mod'), ALPHA)
  assert.equal(r.resolveLocal('gamma'), undefined)
})

test('targetEntry: a Turbo Link qualified id is never a local entry', () => {
  const r = routingRouter({ models: [ALPHA], primary: primaryHolding('alpha-key') })
  ;(r as unknown as { catalog: unknown }).catalog = {
    linkByName: (name: string) => (name === 'workstation'
      ? { id: 'l1', name: 'workstation', baseUrl: 'https://ws.invalid', token: 't', status: 'online' }
      : undefined),
    modelOn: () => ({ key: 'Alpha Model', name: 'Alpha Model' }),
  }

  assert.equal(r.targetEntry('workstation/Alpha Model'), undefined)
})

test('targetEntry: auto-swap off answers with the primary entry, whatever was named', () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key'), autoSwap: false })

  assert.equal(r.targetEntry('Beta'), ALPHA)
})

test('targetEntry: an empty model answers with the primary entry', () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key') })

  assert.equal(r.targetEntry(''), ALPHA)
})

test('targetEntry: a resolvable model answers with that entry, without loading it', () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key') })

  assert.equal(r.targetEntry('Beta'), BETA)
})

test('targetEntry: an unresolvable model answers with the primary entry, matched by path too', () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding(ALPHA.path) })

  assert.equal(r.targetEntry('gamma'), ALPHA)
})

test('targetEntry: with nothing loaded an unresolvable model has no target entry', () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding(null) })

  assert.equal(r.targetEntry('gamma'), undefined)
  assert.equal(r.targetEntry(''), undefined)
})

test('routeTo: the entry running in the primary gets the primary target, with no load', async () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key') })

  assert.deepEqual(await r.routeTo(ALPHA), { target: PRIMARY_TARGET })
})

test('routeTo: the entry running in a pool slot gets that slot target', async () => {
  const slot = { manager: slotManager('running', 'beta-key', BETA_SLOT_TARGET), modelKey: 'beta-key', lastUsedMs: 0 }
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key'), slots: [slot] })

  assert.deepEqual(await r.routeTo(BETA), { target: BETA_SLOT_TARGET })
})

test('routeTo: an entry that is not alive is loaded once when auto-swap is on', async () => {
  const { manager, finishLoad, calls } = controllableManager()
  const r = routingRouter({ models: [ALPHA, BETA], primary: manager })

  const routed = r.routeTo(BETA)
  await tick()
  finishLoad()

  assert.deepEqual(await routed, { target: manager.target() })
  assert.deepEqual(calls, ['beta-key'])
})

test('routeTo: with auto-swap off an entry that is not loaded is a 503, never the primary target', async () => {
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key'), autoSwap: false })

  assert.deepEqual(await r.routeTo(BETA), {
    status: 503,
    message: "'Beta' is not loaded. Load it from Models, or turn on auto-swap.",
  })
})

test('aliveSlots: the primary first, then alive pool slots; stopped slots are left out', () => {
  const r = routingRouter({
    models: [ALPHA, BETA],
    primary: primaryHolding('alpha-key'),
    slots: [
      { manager: slotManager('starting', 'beta-key', BETA_SLOT_TARGET), modelKey: 'beta-key', lastUsedMs: 5 },
      { manager: slotManager('stopped', 'gamma-key', 'http://slot-gamma.invalid'), modelKey: 'gamma-key', lastUsedMs: 7 },
    ],
  })

  assert.deepEqual(r.aliveSlots(), [
    { modelKey: 'alpha-key', state: 'running', primary: true, lastUsedMs: 0 },
    { modelKey: 'beta-key', state: 'starting', primary: false, lastUsedMs: 5 },
  ])
})
