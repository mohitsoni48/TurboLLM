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
import { Manager, type StartOpts, type Status } from '../engines/manager'
import { defaultConfig, type Config, type ConfigStore, type Engine } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'
import { runAutoLoad } from '../engines/auto-load'
import { getSysInfo } from '../sysinfo/sysinfo'
import { realEngineSetUp } from '../test-support/stand-in-engine'
import { modelIncompatibility } from '../engines/compat'

/** A Manager double exposing only status() (all the tested paths read). */
function fakeManager(state: Status['state'], modelKey: string | null): Manager {
  const model = modelKey
    ? { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false }
    : null
  return {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
    // No engine behind it: the pool helpers (and dropSlot) see no process to track.
    currentOpts: () => null,
    restartOpts: () => null,
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

// ComfyUI's acquire (cli.ts's pool stopper) force-stops the slots, as it does the primary; the engine-update
// callers keep the graceful stop they always had.
test('stopPoolSlotsOnEngine: passes force through to the slot, and stops only slots on that engine', async () => {
  const stops: Array<{ key: string; force: boolean | undefined }> = []
  const slotOn = (key: string, engineId: string): Manager => ({
    ...fakeManager('running', key),
    currentOpts: () => ({ engine: { id: engineId } }),
    stopAndWait: async (o?: { force?: boolean }) => { stops.push({ key, force: o?.force }) },
  } as unknown as Manager)
  const r = router(fakeManager('stopped', null), STORE, [
    { manager: slotOn('bge-m3', 'cuda'), modelKey: 'bge-m3', lastUsedMs: 0 },
    { manager: slotOn('qwen', 'vulkan'), modelKey: 'qwen', lastUsedMs: 0 },
  ])

  await r.stopPoolSlotsOnEngine('cuda', { force: true })
  await r.stopPoolSlotsOnEngine('vulkan')

  assert.deepEqual(stops, [{ key: 'bge-m3', force: true }, { key: 'qwen', force: undefined }])
})

// A pool slot is registered only once it has loaded, so the stopper used to miss one still starting: that model then
// came up and served requests during the render.
test('the ComfyUI pool stopper reaches a pool slot that is still loading, and that model never serves', async () => {
  let slotState = 'stopped' as Status['state']
  let settle: (() => void) | undefined
  const stops: Array<boolean | undefined> = []
  const slot = {
    status: (): Status => ({ state: slotState, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    currentOpts: () => null,
    target: () => (slotState === 'running' ? 'http://slot.invalid' : null),
    touch: () => {},
    load: async (_opts: unknown, hooks?: { beforeStart?: () => Promise<void> }) => {
      await hooks?.beforeStart?.()
      slotState = 'starting'
      await new Promise<void>((res) => { settle = res })
    },
    stopAndWait: async (o?: { force?: boolean }) => {
      stops.push(o?.force)
      slotState = 'stopped'
      settle?.()
    },
  } as unknown as Manager
  let claimed = false
  const comfy = {
    isBlocked: () => false,
    gpuClaimed: () => claimed,
    freeComfyUIBeforeLoad: async () => {},
  } as unknown as ConstructorParameters<typeof ModelRouter>[4]
  const entry = fakeEntry('model-b')
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 2 }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(store, registry, fakeManager('running', 'model-a'), scanner, comfy, undefined, () => slot)

  const routed = r.route('model-b')
  while (slot.status().state !== 'starting') await new Promise((res) => setImmediate(res))
  assert.deepEqual([...r.poolEngineIds()], ['eng1'], 'the loading slot is on its engine')

  // ComfyUI's acquire: cli.ts's pool stopper, then the slot's load runs on (it settles once its engine is gone).
  claimed = true
  await Promise.all([...r.poolEngineIds()].map((id) => r.stopPoolSlotsOnEngine(id, { force: true })))
  if (slot.status().state === 'starting') { slotState = 'running'; settle?.() } // missed by the stopper: it comes up
  const result = await routed

  assert.equal(stops[0], true, 'force-stopped by the pool stopper')
  assert.equal(slot.status().state, 'stopped')
  assert.deepEqual(result, { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' })
  assert.equal(r.loadedModelKeys().has('model-b'), false, 'not registered as a pool slot')
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
// manual load guard uses, before anything is evicted or loaded. That includes the audio check. It is permanent (the
// gateway sends `x-should-retry: false`): only the owner changing engines clears it, so a retry only delays the message.
// The refusal names the selected engine and what it cannot run, then says the setting under which an automatic load
// starts it anyway; it named another engine to activate or switch to, advice the owner's rule forbids.
const SHOW_ALL_HINT = 'Automatic loads start it there only with Settings → Models & loading → "Show models for every engine" on.'

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
      'Rapid-MLX cannot load models with an audio tower — the audio encoder fails due to an upstream mlx-vlm bug in the sanitizer for these architectures. ' +
      SHOW_ALL_HINT,
    permanent: true,
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
    message: `llama.cpp can't run this Jev model. ${SHOW_ALL_HINT}`,
    permanent: true,
  })
  assert.deepEqual(loads, [])
})

// No engine the user can select runs either model, so these two refusals say nothing of the setting: a Laya model with
// no Laya engine is refused whatever Settings shows, and a ggmlc GGUF, which with every engine's models shown an
// automatic load does start on the selected engine, fails there. The Settings sentence would be advice that cannot make
// either load, and after the ggmlc one's "it runs on the Laya engine" its "start it there" would name the Laya engine.
test('route: a ggmlc GGUF, or a Laya model with no Laya engine, is refused without the Settings sentence', async () => {
  const { manager, loads } = recordingPrimary()
  const ggmlc = { ...fakeEntry('laya-ggmlc'), format: 'gguf', arch: 'ggmlc' } as ModelEntry
  const ggmlcResult = await autoSwapRouter('llama-server', ggmlc, manager).route('laya-ggmlc')
  const { r, laya } = litertRouter(manager, undefined, [], { activeKind: 'llama-server' })
  const layaResult = await r.route(laya.key)

  assert.deepEqual([ggmlcResult, layaResult], [
    { status: 503, message: modelIncompatibility('llama-server', ggmlc)?.message, permanent: true },
    { status: 503, message: modelIncompatibility('llama-server', laya)?.message, permanent: true },
  ])
  assert.match(String('message' in ggmlcResult && ggmlcResult.message), /ggmlc/)
  assert.match(String('message' in layaResult && layaResult.message), /Install Laya/)
  assert.deepEqual(loads, [])
})

// A model loads only on the engine the user selected: a .litertlm model went to the registered LiteRT-LM engine whenever
// another kind was active, so a gateway auto-swap, a routine's swap or a side model's Load started LiteRT-LM on its own.
function litertRouter(
  primary: Manager,
  comfy?: ConstructorParameters<typeof ModelRouter>[4],
  updates: unknown[] = [],
  { showAllEngineModels = false, activeKind = 'koboldcpp' } = {},
) {
  const bundle = { ...fakeEntry('gemma-litert'), format: 'litertlm', path: '/models/gemma.litertlm' } as ModelEntry
  const gguf = { ...fakeEntry('routine-gguf'), format: 'gguf', path: '/models/routine.gguf' } as ModelEntry
  const laya = { ...fakeEntry('laya'), format: 'gguf', path: '/models/laya', laya: { version: 1 } } as unknown as ModelEntry
  const models = [bundle, gguf, laya]
  const scanner = { list: () => ({ models }), get: (k: string) => models.find((m) => m.key === k) } as unknown as Scanner
  const litert = { id: 'litert-1', kind: 'litert-lm', capabilities: { flags: [] } } as unknown as Engine
  const registry = { active: () => fakeEngine(activeKind), litertLmEngine: () => litert, layaEngine: () => undefined } as unknown as Registry
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 1 }, modelProfiles: {}, comfyui: {}, showAllEngineModels }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => { const c = {}; fn(c); updates.push(c) },
  } as unknown as ConfigStore
  return { r: new ModelRouter(store, registry, primary, scanner, comfy), bundle, gguf, laya }
}

const LITERT_REFUSAL = {
  status: 503,
  message: `KoboldCpp can't run this .litertlm model. ${SHOW_ALL_HINT}`,
  permanent: true,
}

test('route and loadExplicit: a .litertlm model under KoboldCpp is refused and never loads, LiteRT-LM installed', async () => {
  const { manager, loads } = recordingPrimary()
  const { r, bundle } = litertRouter(manager)

  assert.deepEqual(await r.route(bundle.key), LITERT_REFUSAL)
  assert.deepEqual(await r.loadExplicit(bundle.key), LITERT_REFUSAL)
  assert.deepEqual(loads, [])
})

// A load the user asks for by hand (startEngine hands the router an embedding or Laya model's Load as `manual`) is
// started on the selected engine even when that engine is not expected to run the model, and fails with the engine's
// own error; the refusal above is for the automatic loads only. It used to be refused as they are, with the advice to
// activate another engine.
test('loadExplicit, manual: a .litertlm model under KoboldCpp is started on KoboldCpp, never LiteRT-LM', async () => {
  const { manager, loads } = recordingPrimary()
  const { r, bundle } = litertRouter(manager)

  await r.loadExplicit(bundle.key, undefined, { manual: true })

  assert.deepEqual((loads as StartOpts[]).map((o) => [o.engine.id, o.engine.kind, o.modelPath]), [['eng1', 'koboldcpp', bundle.path]])
})

test("reloadAfterRender: a routine's restore of a .litertlm model under KoboldCpp is not handed to the render's release", async () => {
  const { manager } = recordingPrimary()
  const handed: unknown[] = []
  const comfy = {
    reloadOnReleaseInstead: (...args: unknown[]) => (handed.push(args), true),
  } as unknown as ConstructorParameters<typeof ModelRouter>[4]
  const updates: unknown[] = []
  // The routine's own model, which the render unloaded, is a GGUF the active engine runs.
  const { r, bundle, gguf } = litertRouter(manager, comfy, updates)

  r.reloadAfterRender(bundle.key, gguf.key)

  assert.deepEqual(handed, [])
  assert.deepEqual(updates, [], 'nothing recorded as the model last loaded')
})

// With Settings → "Show models for every engine" on, a model the user chose to show is always started on the selected
// engine, and if it fails there it fails: the owner's rule. Only the manual loads read it so; the gateway's auto-swap
// (a Claude Code /model pick, any /v1 client), the Jev endpoints (routeTo) and a routine's swap and restore refused it
// with 503 permanent and the advice to activate another engine, and never started it.
test('with "Show models for every engine" on, every load starts a .litertlm model on KoboldCpp; off, they refuse it', async () => {
  for (const showAllEngineModels of [false, true]) {
    const { manager, loads } = recordingPrimary()
    const { r, bundle } = litertRouter(manager, undefined, [], { showAllEngineModels })
    const results = [
      await r.route(bundle.key),
      await r.routeTo(bundle),
      await r.loadExplicit(bundle.key), // a routine's swap
      await r.loadExplicit(bundle.key, undefined, { restoreAfter: { target: 'http://primary.invalid' } }), // its restore
    ]
    if (!showAllEngineModels) {
      for (const result of results) assert.deepEqual(result, LITERT_REFUSAL)
      assert.deepEqual(loads, [], 'off: nothing is loaded')
      continue
    }
    for (const result of results) assert.notDeepEqual(result, LITERT_REFUSAL)
    assert.deepEqual(
      (loads as StartOpts[]).map((o) => [o.engine.kind, o.modelPath]),
      Array(4).fill(['koboldcpp', bundle.path]),
      'on: each load starts on the selected engine, never on LiteRT-LM',
    )
  }
})

test('with "Show models for every engine" on, a GGUF under vLLM is started on vLLM by an auto-swap', async () => {
  const { manager, loads } = recordingPrimary()
  const { r, gguf } = litertRouter(manager, undefined, [], { showAllEngineModels: true, activeKind: 'vllm' })

  await r.route(gguf.key)

  assert.deepEqual((loads as StartOpts[]).map((o) => [o.engine.kind, o.modelPath]), [['vllm', gguf.path]])
})

test('with "Show models for every engine" on, a Laya model with no Laya engine is still refused before anything loads', async () => {
  const { manager, loads } = recordingPrimary()
  const { r, laya } = litertRouter(manager, undefined, [], { showAllEngineModels: true })

  const result = await r.route(laya.key)

  assert.equal('status' in result && result.status, 503)
  assert.match('message' in result ? result.message : '', /Laya/)
  assert.deepEqual(loads, [])
})

test("with \"Show models for every engine\" on, a routine's restore of a .litertlm model under KoboldCpp is handed to the render's release", async () => {
  const { manager } = recordingPrimary()
  const handed: unknown[][] = []
  const comfy = {
    reloadOnReleaseInstead: (...args: unknown[]) => (handed.push(args), true),
  } as unknown as ConstructorParameters<typeof ModelRouter>[4]
  const { r, bundle, gguf } = litertRouter(manager, comfy, [], { showAllEngineModels: true })

  r.reloadAfterRender(bundle.key, gguf.key)

  assert.deepEqual(handed.map(([key, opts]) => [key, (opts as StartOpts).engine.kind, (opts as StartOpts).modelPath]), [
    [gguf.key, 'koboldcpp', bundle.path],
  ])
})

// A load that an acquire overtook while it waited (for the load gate or ComfyUI's /free) is refused by the guard's
// pre-start hook. That clears by itself, like doLoad's isBlocked() refusal, so it is a retryable (not permanent) 503.
test('route: a load refused by the ComfyUI pre-start hook is a retryable 503', async () => {
  const entry = fakeEntry('model-a')
  const primary = {
    status: (): Status => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    load: async (_opts: unknown, hooks?: { beforeStart?: () => Promise<void> }) => { await hooks?.beforeStart?.() },
    target: () => null,
    touch: () => {},
  } as unknown as Manager
  const comfy = {
    isBlocked: () => false, // the acquire landed after doLoad's check
    freeComfyUIBeforeLoad: async () => { throw new Error('ComfyUI is rendering — model loading is paused until its queue finishes.') },
  } as unknown as ConstructorParameters<typeof ModelRouter>[4]
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(fakeFullStore(), registry, primary, scanner, comfy)

  const result = await r.route('model-a')

  assert.ok('status' in result, JSON.stringify(result))
  assert.equal(result.permanent, undefined, JSON.stringify(result))
})

// The gateway tells clients not to retry only a `permanent` refusal. A load that ran and failed is one (a retry evicts
// the loaded model and runs the same failing load again); doLoad's own ComfyUI refusal clears when the render ends.
test('route: a load that ran and failed is permanent; a ComfyUI-blocked load is not', async () => {
  const entry = fakeEntry('model-a')
  const failed = await autoSwapRouter('mlx', entry, recordingPrimary().manager).route('model-a')
  assert.deepEqual(failed, { status: 503, message: 'Model failed to become ready.', permanent: true })

  const comfy = { isBlocked: () => true } as unknown as ConstructorParameters<typeof ModelRouter>[4]
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const blocked = await new ModelRouter(fakeFullStore(), {} as never, recordingPrimary().manager, scanner, comfy).route('model-a')
  assert.deepEqual(blocked, { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' })
})

// Manager.load() rethrows what the engine start threw (no active engine, a model it cannot find, a spawn or port error)
// once it has set 'error'. A retry runs the same start again, evicting the loaded model first, so it is permanent too.
test('route: a load whose engine start throws is permanent', async () => {
  const primary = {
    status: (): Status => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    load: async () => { throw new Error('no_such_model') },
    target: () => null,
    touch: () => {},
  } as unknown as Manager

  const result = await autoSwapRouter('mlx', fakeEntry('model-a'), primary).route('model-a')

  assert.deepEqual(result, { status: 503, message: 'Engine start failed: no_such_model', permanent: true })
})

// A render that starts while the gateway loads into the primary: acquire force-stops the starting engine (Manager.load
// then resolves with it stopped) and release() reloads that model, so the refusal clears by itself, as it does for a
// pool slot. A load that failed on its own during the render ('error') is still permanent.
for (const [label, endState, expected] of [
  ['it kills is retryable', 'stopped', { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }],
  ['fails on its own stays permanent', 'error', { status: 503, message: 'Model failed to become ready.', permanent: true }],
] as const) {
  test(`route: during a ComfyUI acquire, a primary load that ${label}`, async () => {
    let state = 'stopped' as Status['state']
    let claimed = false
    const primary = {
      status: (): Status => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
      load: async (_opts: unknown, hooks?: { beforeStart?: () => Promise<void> }) => {
        await hooks?.beforeStart?.()
        claimed = true // the render's acquire, while the engine starts
        state = endState
      },
      target: () => null,
      touch: () => {},
    } as unknown as Manager
    const comfy = {
      isBlocked: () => false,
      gpuClaimed: () => claimed,
      freeComfyUIBeforeLoad: async () => {},
    } as unknown as ConstructorParameters<typeof ModelRouter>[4]
    const entry = fakeEntry('model-a')
    const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
    const registry = { active: () => fakeEngine('mlx') } as unknown as Registry

    const result = await new ModelRouter(fakeFullStore(), registry, primary, scanner, comfy).route('model-a')

    assert.deepEqual(result, expected)
  })
}

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
    currentOpts: () => null,
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

test('route: a pool slot is described by its OWN engine, so the gateway does not shape the request for the primary', async () => {
  const manager = {
    ...slotManager('running', 'beta-key', BETA_SLOT_TARGET),
    currentOpts: () => ({ engine: { kind: 'litert-lm' }, modelPath: '/models/beta.litertlm', model: { name: 'Beta' } }),
  } as unknown as Manager
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key'), slots: [{ manager, modelKey: 'beta-key', lastUsedMs: 0 }] })

  assert.deepEqual(await r.route('Beta'), {
    target: BETA_SLOT_TARGET, engineKind: 'litert-lm', modelPath: '/models/beta.litertlm', modelName: 'Beta',
  })
  assert.deepEqual(await r.route('Alpha Model'), { target: PRIMARY_TARGET }, 'the primary is left to the gateway, as before')
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

test('route: with auto-swap off an embeddings request naming a running pool slot gets that slot; chat still gets the primary', async () => {
  const slot = { manager: slotManager('running', 'beta-key', BETA_SLOT_TARGET), modelKey: 'beta-key', lastUsedMs: 0 }
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key'), autoSwap: false, slots: [slot] })

  assert.deepEqual(await r.route('Beta', { embeddings: true }), { target: BETA_SLOT_TARGET })
  assert.equal(r.targetEntry('Beta', { embeddings: true }), BETA)
  assert.deepEqual(await r.route('Beta'), { target: PRIMARY_TARGET }, 'a chat request is answered by the primary, as before')
  assert.equal(r.targetEntry('Beta'), ALPHA)
})

test('route: with auto-swap off an embeddings request naming a model that is not running gets the primary, and loads nothing', async () => {
  const slot = { manager: slotManager('stopping', 'beta-key', BETA_SLOT_TARGET), modelKey: 'beta-key', lastUsedMs: 0 }
  const r = routingRouter({ models: [ALPHA, BETA], primary: primaryHolding('alpha-key'), autoSwap: false, slots: [slot] })

  assert.deepEqual(await r.route('Beta', { embeddings: true }), { target: PRIMARY_TARGET })
  assert.equal(r.targetEntry('Beta', { embeddings: true }), ALPHA)
  assert.deepEqual(await r.route('', { embeddings: true }), { target: PRIMARY_TARGET }, 'no model named: the primary')
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

function slotOnEngine(modelKey: string, engineId: string): PoolSlotShape {
  const manager = { currentOpts: () => ({ engine: { id: engineId } }) } as unknown as Manager
  return { manager, modelKey, lastUsedMs: 0 }
}

test('poolSlotsOnEngine: counts the extra pool slots running on that engine only', () => {
  const r = router(fakeManager('running', 'primary-model'), STORE, [
    slotOnEngine('a', 'litert'),
    slotOnEngine('b', 'litert'),
    slotOnEngine('c', 'llama'),
  ])
  assert.equal(r.poolSlotsOnEngine('litert'), 2)
  assert.equal(r.poolSlotsOnEngine('llama'), 1)
  assert.equal(r.poolSlotsOnEngine('absent'), 0)
})

// ── A pool slot whose engine is still exiting, or still running the model its load evicted ──────────
// The pool helpers read currentOpts(), which Manager leaves null while a slot stops, and a loading slot was tracked
// only under the engine it loads. So an ejected slot (stopExplicit drops it, then it stops gracefully: on Windows a
// full 8 s), a slot its idle watchdog is stopping, and a slot still running the LRU model it evicted on another engine
// were invisible: ComfyUI's acquire let a render start while they held VRAM, an engine update or delete went ahead
// under them, and the Models page / delete guard missed the models they run and load.

/** A pool-slot Manager double with Manager's opts semantics: currentOpts() only while running or starting,
 *  restartOpts() always; stop() is graceful (stays 'stopping'), stopAndWait() settles it. */
function slotProcess(key: string, engineId: string) {
  let state: Status['state'] = 'running'
  const opts = { engine: { id: engineId }, model: { key } }
  const stops: Array<boolean | undefined> = []
  const manager = {
    status: (): Status => ({
      state, err: null, port: 0, pid: 0, loadElapsedMs: 0,
      model: state === 'running' || state === 'starting' ? { key, name: key, quant: 'Q4', ctx: 4096, vision: false } : null,
    }),
    currentOpts: () => (state === 'running' || state === 'starting' ? opts : null),
    restartOpts: () => opts,
    stop: () => { if (state === 'running' || state === 'starting') state = 'stopping' },
    stopAndWait: async (o?: { force?: boolean }) => { stops.push(o?.force); state = 'stopped' },
  } as unknown as Manager
  return { manager, stops, setState: (s: Status['state']) => { state = s } }
}

const comfyPoolStopper = (r: ModelRouter) =>
  Promise.all([...r.poolEngineIds()].map((id) => r.stopPoolSlotsOnEngine(id, { force: true })))

test('the ComfyUI pool stopper kills a slot the user just ejected that is still stopping', async () => {
  const emb = slotProcess('bge-m3', 'cuda')
  const r = router(fakeManager('stopped', null), STORE, [{ manager: emb.manager, modelKey: 'bge-m3', lastUsedMs: 0 }])

  assert.equal(r.stopExplicit('bge-m3'), true)
  assert.equal(emb.manager.status().state, 'stopping', 'a graceful stop is still in flight')
  assert.deepEqual([...r.poolEngineIds()], ['cuda'], 'its engine still holds VRAM and files')
  assert.equal(r.poolSlotsOnEngine('cuda'), 1)

  await comfyPoolStopper(r)
  assert.deepEqual(emb.stops, [true], 'force-stopped and waited for')
  assert.deepEqual([...r.poolEngineIds()], [], 'dropped once it has exited')
})

test('the ComfyUI pool stopper kills a slot its idle watchdog is stopping', async () => {
  const chat = slotProcess('qwen', 'vulkan')
  const r = router(fakeManager('stopped', null), STORE, [{ manager: chat.manager, modelKey: 'qwen', lastUsedMs: 0 }])
  chat.setState('stopping') // Manager.watchdogTick -> stop()

  assert.deepEqual([...r.poolEngineIds()], ['vulkan'])
  await comfyPoolStopper(r)
  assert.deepEqual(chat.stops, [true])
  assert.deepEqual([...r.poolEngineIds()], [])
})

test('dropped pool slots that have exited are not kept: ejects and idle reloads alone do not grow the stopping set', () => {
  const r = router(fakeManager('stopped', null), STORE, [])
  const slots = (r as unknown as { extraSlots: Map<string, PoolSlotShape> }).extraSlots
  const stoppingSlots = (r as unknown as { stoppingSlots: Set<Manager> }).stoppingSlots
  for (let i = 0; i < 50; i++) {
    const p = slotProcess(`m${i}`, 'cuda')
    slots.set(`m${i}`, { manager: p.manager, modelKey: `m${i}`, lastUsedMs: 0 })
    if (i % 2) p.setState('stopped') // a slot its idle watchdog already unloaded: nothing left to track
    assert.equal(r.stopExplicit(`m${i}`), true)
    p.setState('stopped') // the graceful stop has finished
  }
  // No pool read (poolEngineIds etc.) in between, as for a user who never renders or updates an engine.
  assert.ok(stoppingSlots.size <= 1, `only the last eject may still be exiting, got ${stoppingSlots.size}`)

  const live = slotProcess('still', 'cuda')
  slots.set('still', { manager: live.manager, modelKey: 'still', lastUsedMs: 0 })
  assert.equal(r.stopExplicit('still'), true)
  assert.deepEqual([...r.poolEngineIds()], ['cuda'], 'a slot still exiting is tracked')
  live.setState('stopped')
  assert.deepEqual([...r.poolEngineIds()], [])
  assert.equal(stoppingSlots.size, 0)
})

/** A new pool-slot manager whose load waits (as for the global load gate) until open(), then ends in `endState`. */
function gatedNewSlot(endState: Status['state']) {
  let state: Status['state'] = 'stopped'
  let opts: StartOpts | null = null
  let open!: () => void
  const gate = new Promise<void>((res) => { open = res })
  let called!: () => void
  const loadCalled = new Promise<void>((res) => { called = res })
  const manager = {
    status: (): Status => ({
      state, err: null, port: 0, pid: 0, loadElapsedMs: 0,
      model: state === 'running' && opts ? { key: opts.model.key, name: opts.model.key, quant: 'Q4', ctx: 4096, vision: false } : null,
    }),
    currentOpts: () => (state === 'running' || state === 'starting' ? opts : null),
    restartOpts: () => opts,
    target: () => 'http://127.0.0.1:8082',
    touch: () => {},
    load: async (o: StartOpts) => { called(); await gate; opts = o; state = endState },
    stopAndWait: async () => { state = 'stopped' },
  } as unknown as Manager
  return { manager, loadCalled, open }
}

/** keepN 3, model-p in the primary, `slots` registered, new pool slots from `newSlot`, active engine 'eng1'. */
function poolRouter(slots: PoolSlotShape[], newSlot: () => Manager): ModelRouter {
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 3 }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
  const entries = slots.map((s) => fakeEntry(s.modelKey))
  const scanner = { list: () => ({ models: entries }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(store, registry, fakeManager('running', 'model-p'), scanner, undefined, undefined, newSlot)
  ;(r as unknown as { extraSlots: Map<string, PoolSlotShape> }).extraSlots = new Map(slots.map((s) => [s.modelKey, s]))
  return r
}

test('a request for a model its idle watchdog is still stopping keeps the exiting slot under the pool stopper', async () => {
  // routeResolved drops the stopping slot and loads qwen into a new one (on 'eng1', waiting for the load gate); the old
  // process (on 'vulkan') still exits, gracefully: on Windows up to 8 s.
  const old = slotProcess('qwen', 'vulkan')
  old.setState('stopping') // Manager.watchdogTick -> stop()
  const fresh = gatedNewSlot('error')
  const r = poolRouter([{ manager: old.manager, modelKey: 'qwen', lastUsedMs: 0 }], () => fresh.manager)

  const routed = r.route('qwen')
  await fresh.loadCalled
  assert.deepEqual([...r.poolEngineIds()].sort(), ['eng1', 'vulkan'])
  assert.equal(r.poolSlotsOnEngine('vulkan'), 1, 'an engine update/delete still waits for it')

  await comfyPoolStopper(r)
  assert.deepEqual(old.stops, [true], 'force-killed and waited for')
  fresh.open()
  await routed
  assert.deepEqual([...r.poolEngineIds()], [], 'dropped once it has exited')
})

test('loadExplicit over a slot its idle watchdog is still stopping keeps the exiting slot tracked', async () => {
  // loadExplicit (a Routine's pinned model) skips routeResolved: the stopping slot stays listed while the new one loads,
  // and registering the new slot under the same key must not drop the old process from view.
  const old = slotProcess('qwen', 'vulkan')
  old.setState('stopping')
  const fresh = gatedNewSlot('running')
  const r = poolRouter([{ manager: old.manager, modelKey: 'qwen', lastUsedMs: 0 }], () => fresh.manager)

  const loaded = r.loadExplicit('qwen')
  await fresh.loadCalled
  fresh.open()
  assert.equal('target' in (await loaded), true)
  assert.deepEqual([...r.poolEngineIds()].sort(), ['eng1', 'vulkan'])

  await comfyPoolStopper(r)
  assert.deepEqual(old.stops, [true])
})

test('a ComfyUI render force-kills a pool slot an engine update is still stopping gracefully', async () => {
  const chat = slotProcess('qwen', 'vulkan')
  const r = router(fakeManager('stopped', null), STORE, [{ manager: chat.manager, modelKey: 'qwen', lastUsedMs: 0 }])
  const stops: Array<boolean | undefined> = []
  let exit!: () => void
  const exited = new Promise<void>((res) => { exit = res })
  // Manager.stopAndWait: a graceful stop waits for the process (on Windows up to 8 s); a forced one kills it now.
  ;(chat.manager as unknown as { stopAndWait: (o?: { force?: boolean }) => Promise<void> }).stopAndWait = async (o) => {
    stops.push(o?.force)
    chat.setState('stopping')
    if (o?.force) { chat.setState('stopped'); exit() }
    await exited
  }

  const update = r.stopPoolSlotsOnEngine('vulkan') // stopEngineUsers, before an engine update replaces its files
  assert.deepEqual([...r.poolEngineIds()], ['vulkan'], 'still exiting')
  await comfyPoolStopper(r)
  assert.deepEqual(stops, [undefined, true])
  await update
  assert.deepEqual([...r.poolEngineIds()], [])
})

test('a slot loading over the LRU model it evicted counts on both engines, and for both models', async () => {
  // keepN 2: the primary runs model-p; slot A runs model-a on LiteRT-LM and is LRU. A request for model-b (on the
  // active engine 'eng1') evicts slot A, whose load then waits for the global load gate while model-a still runs.
  const a = slotProcess('model-a', 'litert')
  let enterGate: (() => void) | undefined
  const gate = new Promise<void>((res) => { enterGate = res })
  let loadCalled = false
  ;(a.manager as unknown as { load: () => Promise<void> }).load = async () => {
    loadCalled = true
    await gate // Manager.runExclusive: another load holds the gate
  }
  const entry = fakeEntry('model-b')
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 2 }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(store, registry, fakeManager('running', 'model-p'), scanner, undefined)
  ;(r as unknown as { extraSlots: Map<string, PoolSlotShape> }).extraSlots = new Map([
    ['model-a', { manager: a.manager, modelKey: 'model-a', lastUsedMs: 0 }],
  ])
  ;(r as unknown as { primaryLastUsed: number }).primaryLastUsed = Date.now()

  const routed = r.route('model-b')
  while (!loadCalled) await tick()

  assert.deepEqual([...r.poolEngineIds()].sort(), ['eng1', 'litert'])
  assert.equal(r.poolSlotsOnEngine('litert'), 1)
  assert.equal(r.poolSlotsOnEngine('eng1'), 1)
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['model-a', 'model-b', 'model-p'])

  // An update or delete of LiteRT-LM (stopEngineUsers) stops the process still running on it.
  await r.stopPoolSlotsOnEngine('litert')
  assert.deepEqual(a.stops, [undefined])
  enterGate?.()
  await routed
})

test('a model waiting to load into a new pool slot is loaded for the delete guard and the Models page', async () => {
  let state = 'stopped' as Status['state']
  let enterGate: (() => void) | undefined
  const gate = new Promise<void>((res) => { enterGate = res })
  let loadCalled = false
  const slot = {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    currentOpts: () => null,
    target: () => null,
    load: async () => { loadCalled = true; await gate; state = 'error' },
  } as unknown as Manager
  const entry = fakeEntry('model-b')
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 2 }, modelProfiles: {}, comfyui: {} }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
  const scanner = { list: () => ({ models: [entry] }), get: () => undefined } as unknown as Scanner
  const registry = { active: () => fakeEngine('mlx') } as unknown as Registry
  const r = new ModelRouter(store, registry, fakeManager('running', 'model-p'), scanner, undefined, undefined, () => slot)

  const routed = r.route('model-b')
  while (!loadCalled) await tick()
  assert.equal(r.loadedModelKeys().has('model-b'), true, 'DELETE /models/model-b must be refused mid-load')

  enterGate?.()
  await routed
  assert.equal(r.loadedModelKeys().has('model-b'), false, 'a failed load is no longer reported')
})

// ── The model last loaded, when an embedding model loads beside the chat model ────────────────────
// An embedding model loads into a pool slot of its own beside a running chat model (doLoad's needsNewSlot): from its
// Load button (engine-lifecycle sends a side model through loadExplicit) or from an /v1/embeddings request with
// auto-swap on. loadInto recorded it as config.lastLoaded, which holds one model, so the chat model's record was
// replaced. The next daemon start's resume then loaded the embedding model alone, into the empty primary that the chat
// screen and `turbollm launch` talk to, and left the chat model unloaded.
for (const [label, autoSwap, loadEmbedding] of [
  ['its Load button', false, (r: ModelRouter, key: string) => r.loadExplicit(key)],
  ['an embeddings request with auto-swap on', true, (r: ModelRouter, key: string) => r.route(key, { embeddings: true })],
] as const) {
  test(`an embedding model loaded beside the chat model by ${label} stays out of the model last loaded, so the next start resumes the chat model`, {
    skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
  }, async (t) => {
    const { store, registry, scanner, manager, modelRouter, userModel, embedModel } = await realEngineSetUp(t)
    t.after(() => modelRouter.stopPoolSlotsOnEngine('fake', { force: true }))
    store.update((c) => { c.gateway.autoSwap = autoSwap; c.autoLoadOnStart = true })
    const chat = await modelRouter.loadExplicit(userModel.key)
    assert.ok('target' in chat, JSON.stringify(chat))

    const embedding = await loadEmbedding(modelRouter, embedModel.key)

    assert.ok('target' in embedding, JSON.stringify(embedding))
    assert.equal('target' in embedding && embedding.lastLoaded, undefined, 'nothing recorded, so nothing for a restore to undo')
    assert.deepEqual(modelRouter.aliveSlots().map((s) => [s.modelKey, s.primary]), [[userModel.key, true], [embedModel.key, false]])
    assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' })

    // The next daemon start: nothing running, a new Manager and router on the same config, and the boot resume.
    await modelRouter.stopPoolSlotsOnEngine('fake', { force: true })
    await manager.stopAndWait({ force: true })
    const nextManager = new Manager(store)
    const nextRouter = new ModelRouter(store, registry, nextManager, scanner, undefined)
    t.after(async () => {
      await nextRouter.stopPoolSlotsOnEngine('fake', { force: true })
      await nextManager.stopAndWait({ force: true })
    })
    const warns: string[] = []
    await runAutoLoad({
      initialScan: Promise.resolve(), store, registry, scanner, manager: nextManager, modelRouter: nextRouter,
      comfy: { isBlocked: () => false, freeComfyUIBeforeLoad: async () => {} },
      sysInfo: getSysInfo, log: () => {}, warn: (line) => { warns.push(line) },
    })

    assert.deepEqual(warns, [])
    assert.deepEqual(nextRouter.aliveSlots().map((s) => [s.modelKey, s.state, s.primary]), [[userModel.key, 'running', true]])
  })
}

// The record still names an embedding model that loads with nothing else running: it took the empty primary as the
// only model, and the next start resumes it there.
test('an embedding model loaded with nothing else running takes the primary and is the model last loaded', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, modelRouter, embedModel } = await realEngineSetUp(t)

  const embedding = await modelRouter.loadExplicit(embedModel.key)

  assert.ok('target' in embedding, JSON.stringify(embedding))
  assert.deepEqual(modelRouter.aliveSlots().map((s) => [s.modelKey, s.primary]), [[embedModel.key, true]])
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: embedModel.key, engineId: 'fake' })
})
