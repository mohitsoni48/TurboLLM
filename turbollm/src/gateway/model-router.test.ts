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
import type { ConfigStore } from '../config/config'

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
