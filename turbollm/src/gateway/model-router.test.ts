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
import { ModelRouter } from './model-router'
import type { Manager, Status } from '../engines/manager'
import type { ConfigStore, Engine } from '../config/config'
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
