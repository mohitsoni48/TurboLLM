// turbollm/src/routines/model-swap.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withPinnedModel, type ModelSwapDeps } from './model-swap'
import type { Manager, StartOpts } from '../engines/manager'
import { ModelRouter } from '../gateway/model-router'
import { defaultConfig, type ConfigStore } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'
import { realEngineSetUp } from '../test-support/stand-in-engine'
import { GenerationGate } from '../agents/gate'

function fakeDeps(opts: { loadedKey: string | null; state?: string; activeRequests?: number }): { deps: ModelSwapDeps; loadCalls: string[] } {
  const loadCalls: string[] = []
  let current = opts.loadedKey
  const manager = {
    status: () => ({ state: opts.state ?? 'running', model: current ? { key: current } : null }),
    sessionStats: () => ({ activeRequests: opts.activeRequests ?? 0 }),
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async (key: string) => { loadCalls.push(key); current = key; return { target: 'http://127.0.0.1:8081' } },
  } as unknown as ModelRouter
  return { deps: { manager, modelRouter }, loadCalls }
}

test('pinned model already loaded -> run, no swap', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'a' })
  let ran = false
  const result = await withPinnedModel(deps, 'a', async () => { ran = true })
  assert.equal(result.outcome, 'ran')
  assert.equal(ran, true)
  assert.equal(loadCalls.length, 0)
})

test('different model loaded, engine idle -> swap, run, restore', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'b', activeRequests: 0 })
  const result = await withPinnedModel(deps, 'a', async () => {
    assert.equal(deps.manager.status().model?.key, 'a')
  })
  assert.equal(result.outcome, 'ran')
  assert.deepEqual(loadCalls, ['a', 'b']) // swap to a, then restore to b
  assert.equal(deps.manager.status().model?.key, 'b')
})

test('different model loaded and busy -> skip-busy, fn never called', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'b', activeRequests: 1 })
  let called = false
  const result = await withPinnedModel(deps, 'a', async () => { called = true })
  assert.equal(result.outcome, 'skip-busy')
  assert.equal(called, false)
  assert.equal(loadCalls.length, 0)
})

test('nothing loaded before -> swap in, run, nothing to restore', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: null, state: 'stopped' })
  const result = await withPinnedModel(deps, 'a', async () => {})
  assert.equal(result.outcome, 'ran')
  assert.deepEqual(loadCalls, ['a']) // only the swap-in — nothing to restore
})

test('restore still runs even if fn throws', async () => {
  const { deps, loadCalls } = fakeDeps({ loadedKey: 'b' })
  await assert.rejects(() => withPinnedModel(deps, 'a', async () => { throw new Error('task failed') }))
  assert.deepEqual(loadCalls, ['a', 'b'])
})

test('ComfyUI busy -> skip-comfyui-busy, fn never called (ADR-386, a temporary yield, not a load failure)', async () => {
  const manager = {
    status: () => ({ state: 'running', model: { key: 'b' } }),
    sessionStats: () => ({ activeRequests: 0 }),
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async () => ({ status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }),
  } as unknown as ModelRouter
  let called = false
  const result = await withPinnedModel({ manager, modelRouter }, 'a', async () => { called = true })
  assert.equal(result.outcome, 'skip-comfyui-busy')
  assert.equal(called, false)
})

test('a genuine load failure (not ComfyUI) still reports skip-load-failed with the real message', async () => {
  const manager = {
    status: () => ({ state: 'running', model: { key: 'b' } }),
    sessionStats: () => ({ activeRequests: 0 }),
  } as unknown as Manager
  const modelRouter = {
    loadExplicit: async () => ({ status: 500, message: 'unknown model architecture: bailingmoe3' }),
  } as unknown as ModelRouter
  const result = await withPinnedModel({ manager, modelRouter }, 'a', async () => {})
  assert.deepEqual(result, { outcome: 'skip-load-failed', message: 'unknown model architecture: bailingmoe3' })
})

// ── a Routine run RESTORES the loaded Jev model afterwards (ADR-434 "Correction to (i)(4)") ────
// A Routine run does not unload the Jev model for good: routines swap the pinned model in, run,
// and then reload whatever was loaded before — so a Routine firing while a Jev model is loaded
// briefly takes Workspace out of the playground and then brings it back. That is settled
// Routines design (spec 20 §5, ADR-060), so this pins it through the real ModelRouter, the
// shared StartOpts builder and the Jev launch flags. Nothing is spawned and no port is used —
// the Manager is a double.

const JEV_MODEL_KEY = 'qwen3.5 4b nli v2|mlx-fp16|9012345678'
const CHAT_MODEL_KEY = 'qwen3-8b|mlx-4bit|8000000000'

function mlxEntry(key: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key, name: key, path: `/models/${key}`, dir: '/models',
    format: 'mlx', sizeBytes: 1, sizeLabel: '1 GB', arch: 'qwen3', quant: 'mlx', nativeCtx: 262144,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    ...extra,
  } as unknown as ModelEntry
}

const JEV_ENTRY = mlxEntry(JEV_MODEL_KEY, {
  jev: {
    labels: ['contradiction', 'entailment', 'neutral'],
    nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
    architecture: 'Qwen3_5ForSequenceClassification',
    verified: true,
  },
})
const CHAT_ENTRY = mlxEntry(CHAT_MODEL_KEY)

/** A primary Manager double that records every StartOpts it is asked to load and then reports
 *  that model as the one it is running. */
function recordingPrimary(initialKey: string): { manager: Manager; loads: StartOpts[] } {
  const loads: StartOpts[] = []
  let running: { key: string; name: string; quant: string; ctx: number; vision: boolean } | null =
    { key: initialKey, name: initialKey, quant: 'mlx', ctx: 4096, vision: false }
  const manager = {
    status: () => ({ state: 'running', err: null, port: 0, pid: 0, model: running, loadElapsedMs: 0 }),
    sessionStats: () => ({ activeRequests: 0 }),
    target: () => 'http://primary.invalid',
    touch: () => {},
    load: async (opts: StartOpts) => {
      loads.push(opts)
      running = { key: opts.model.key, name: opts.model.key, quant: 'mlx', ctx: 4096, vision: false }
    },
  } as unknown as Manager
  return { manager, loads }
}

function realRouter(manager: Manager): ModelRouter {
  const cfg = defaultConfig()
  cfg.gateway.autoSwap = true
  cfg.gateway.keepN = 1
  const store = { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) } as unknown as ConfigStore
  const registry = {
    active: () => ({ id: 'eng1', name: 'vLLM', kind: 'vllm', binPath: 'vllm', capabilities: { kvTypes: [], flags: [] } }),
  } as unknown as Registry
  const models = [JEV_ENTRY, CHAT_ENTRY]
  const scanner = {
    list: () => ({ models, scanning: false, lastScanAt: '' }),
    get: (key: string) => models.find((m) => m.key === key),
  } as unknown as Scanner
  return new ModelRouter(store, registry, manager, scanner, undefined)
}

test('a routine pinned to a chat model swaps it in, runs, and restores the Jev model with its flags', async () => {
  const { manager, loads } = recordingPrimary(JEV_MODEL_KEY)
  const modelRouter = realRouter(manager)
  let keyWhileRunning: string | undefined

  const result = await withPinnedModel({ manager, modelRouter }, CHAT_MODEL_KEY, async () => {
    keyWhileRunning = manager.status().model?.key
  })

  assert.equal(result.outcome, 'ran')
  assert.equal(keyWhileRunning, CHAT_MODEL_KEY, 'the routine ran on its own pinned model')
  assert.deepEqual(loads.map((o) => o.model.key), [CHAT_MODEL_KEY, JEV_MODEL_KEY], 'swap in, then restore')
  assert.equal(manager.status().model?.key, JEV_MODEL_KEY, 'Workspace goes back to the playground')
  const restoreArgs = loads[1].extraArgs
  assert.ok(
    restoreArgs.includes('--convert') && restoreArgs.includes('classify'),
    `the restored Jev model keeps its launch flags, got ${JSON.stringify(restoreArgs)}`,
  )
})

// ── a pinned model that fails to load still gives the user's model back ──────────────────────────
// Against a real ConfigStore, Manager and ModelRouter and a stand-in llama-server: with keep-N 1 the routine's model
// loads into the primary, so Manager.load stops the user's model before the routine's own fails to start. Nothing
// restored it: every run of that routine left the engine empty.

test('a pinned model that fails to load after the user model was stopped reloads the user model', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, userModel, brokenModel } = await realEngineSetUp(t)
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  let called = false

  const result = await withPinnedModel({ manager, modelRouter }, brokenModel.key, async () => { called = true })

  assert.equal(result.outcome, 'skip-load-failed')
  assert.equal(called, false)
  const st = manager.status()
  assert.equal(st.state, 'running', `the user's model is loaded again, got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
})

// A pi Code routine lets go of the gate while its session runs and takes it back for the restore
// (execute.ts pinnedGate). When the wait for it timed out (the gate's 3-minute queue limit), the
// restore ran anyway and stopped the engine under the generation still holding the only slot.
/** The routine's own hold on a one-slot gate, for the swap decision and load, given back before
 *  `fn` and asked for again with a 30 ms queue limit; `takeSlot` is another caller (a chat
 *  routine, a compaction) that takes the slot mid-run and keeps it. */
async function heldGate() {
  const gate = new GenerationGate(() => 1)
  const release = await gate.acquire('bg')
  let holder: (() => void) | undefined
  return {
    gate,
    swapGate: { release, reacquire: () => gate.acquire('bg', { timeoutMs: 30 }) },
    takeSlot: async () => { holder = await gate.acquire('bg') },
    releaseSlot: () => holder?.(),
  }
}

test('a restore that cannot take the gate back is skipped while another holder still has it', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, userModel, routineModel } = await realEngineSetUp(t)
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  const held = await heldGate()
  t.after(held.releaseSlot)

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, held.takeSlot, held.swapGate)

  assert.equal(result.outcome, 'ran')
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, routineModel.key, 'no restore while the holder still generates')
  assert.deepEqual(held.gate.stats(), { inFlight: 1, queued: 0, capacity: 1 }, 'only the other holder is in the gate')
})

// A ComfyUI render that begins while a routine runs unloads the routine's model and keeps it for its release() to
// reload. The routine's restore of the user's model then meets the render and is refused, and nothing recorded it:
// when the render ended, the guard brought the routine's model back, and the user's model stayed unloaded. The model
// saved as last loaded, which the routine's swap set, named the routine's too.
test("a routine's restore refused by a ComfyUI render makes the render's release reload the user's model", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {
    assert.equal(manager.status().model?.key, routineModel.key, 'the routine runs on its own model')
    await guard!.acquire() // a render starts mid-run
  })

  assert.equal(result.outcome, 'ran')
  assert.equal(manager.status().state, 'stopped', 'nothing loads while the render holds the GPU')
  assert.equal(guard!.snapshot().suspendedModelKey, userModel.key, "the render's release reloads the user's model")
  assert.equal(store.snapshot().lastLoaded.modelKey, userModel.key, "the next start resumes the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
  assert.equal(store.snapshot().lastLoaded.modelKey, userModel.key)
})

// The same render, landing during the routine's swap: withPinnedModel answered skip-comfyui-busy and restored nothing,
// though the user's model was already gone, and the render's release loaded the routine's model for a routine that
// never ran. Its acquire either kills the routine's model while it starts and keeps it for release() to reload, or,
// landing after Manager.load stopped the user's model (its graceful stop, or the reverse gate's /free call), refuses
// the routine's load, which release() then resumes.
test("a render that begins while the routine's model starts makes its release reload the user's model", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, guard, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  // The stand-in engine answers /health 200 ms after it starts: the acquire lands while it is still 'starting'.
  let acquired: Promise<void> | undefined
  const watch = setInterval(() => {
    const st = manager.status()
    if (st.state === 'starting' && st.model?.key === routineModel.key) {
      clearInterval(watch)
      acquired = guard!.acquire()
    }
  }, 5)
  t.after(() => clearInterval(watch))
  let called = false

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => { called = true })
  await acquired

  assert.equal(result.outcome, 'skip-comfyui-busy')
  assert.equal(called, false)
  assert.equal(guard!.modelKeyLoadedOnRelease(), userModel.key, "the render's release reloads the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
})

test("a render that begins after the routine's swap stopped the user model makes its release reload the user's model", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { manager, modelRouter, guard, comfyFree, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  // The acquire lands during the swap's /free call: Manager.load has stopped the user's model, and the routine's
  // load is refused by the pre-start hook once the call returns.
  comfyFree.hook = () => guard!.acquire()
  let called = false

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => { called = true })

  assert.equal(result.outcome, 'skip-comfyui-busy')
  assert.equal(called, false)
  assert.equal(guard!.modelKeyLoadedOnRelease(), userModel.key, "the render's release reloads the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
})

// ── keep-N 2: the restore finds the user's model still in its slot ──────────────────────────────
// With keep-N 2 or more the routine's swap loads its model into a new pool slot and records it as the model last
// loaded, while the user's model stays in the primary. The restore then took doLoad's fast path, which recorded nothing:
// the next daemon start's resume, an Engines Start that names no model and the CLI launcher's last-used pick all brought
// the routine's model back.
async function keepN2(t: Parameters<typeof realEngineSetUp>[0], opts: Parameters<typeof realEngineSetUp>[1] = {}) {
  const set = await realEngineSetUp(t, opts)
  t.after(() => set.modelRouter.stopPoolSlotsOnEngine('fake', { force: true }))
  set.store.update((c) => { c.gateway.keepN = 2 })
  const first = await set.modelRouter.loadExplicit(set.userModel.key)
  assert.ok('target' in first, JSON.stringify(first))
  return set
}

test("with keep-N 2 the routine's restore puts back the model last loaded before its swap", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, userModel, routineModel } = await keepN2(t)

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {
    assert.equal(store.snapshot().lastLoaded.modelKey, routineModel.key, "the swap loaded the routine's model into a pool slot")
  })

  assert.equal(result.outcome, 'ran')
  const st = manager.status()
  assert.equal(st.state, 'running')
  assert.equal(st.model?.key, userModel.key, "the primary kept the user's model")
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' }, "the next start resumes the user's model")
})

// What is put back is what the swap's record replaced, which need not be the model the restore finds running: the
// user's last pick may be a model that has since been unloaded.
test("with keep-N 2 the routine's restore puts back a last-loaded model that is no longer running", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, routineModel } = await keepN2(t)
  const earlier = { modelKey: 'earlier-pick|Q4_K_M|1', engineId: 'fake' }
  store.update((c) => { c.lastLoaded = { ...earlier } })

  assert.equal((await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {})).outcome, 'ran')

  assert.deepEqual(store.snapshot().lastLoaded, earlier)
})

// A swap that recorded nothing leaves nothing to undo. Writing the restored model there instead replaced the user's
// own pick, here a model in a pool slot, on every run: a routine pinned to the model already in that slot, and one
// pinned to a model that is gone.
test('with keep-N 2 a routine whose swap records nothing leaves the model last loaded alone', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, userModel, routineModel } = await keepN2(t)
  assert.ok('target' in await modelRouter.loadExplicit(routineModel.key))
  assert.equal(store.snapshot().lastLoaded.modelKey, routineModel.key, "the user's own pick, in a pool slot")

  assert.equal((await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {})).outcome, 'ran')
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: routineModel.key, engineId: 'fake' }, 'a swap that found its model running')

  assert.equal((await withPinnedModel({ manager, modelRouter }, 'gone-model', async () => {})).outcome, 'skip-load-failed')
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: routineModel.key, engineId: 'fake' }, 'a swap whose model is gone')
  assert.equal(manager.status().model?.key, userModel.key)
})

// A model recorded while the routine ran (a request's swap, an Engines Start) is a newer choice: the restore leaves it.
test('with keep-N 2 a model recorded while the routine ran stays recorded after the restore', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, routineModel } = await keepN2(t)
  const meanwhile = { modelKey: 'picked-meanwhile|Q4_K_M|1', engineId: 'fake' }

  assert.equal((await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {
    store.update((c) => { c.lastLoaded = { ...meanwhile } })
  })).outcome, 'ran')

  assert.deepEqual(store.snapshot().lastLoaded, meanwhile)
})

// The same gate wait with keep-N 2 and a free pool slot: the user's model kept its slot, so its restore stops nothing
// and only puts back the model last loaded. Skipped along with the load, the swap's record stayed and the next start
// resumed the routine's model.
test('with keep-N 2 a restore that cannot take the gate back still puts back the model last loaded', {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, userModel, routineModel } = await keepN2(t)
  const held = await heldGate()
  t.after(held.releaseSlot)

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {
    assert.equal(store.snapshot().lastLoaded.modelKey, routineModel.key, "the swap loaded the routine's model into a pool slot")
    await held.takeSlot()
  }, held.swapGate)

  assert.equal(result.outcome, 'ran')
  assert.equal(manager.status().model?.key, userModel.key, "the primary kept the user's model")
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' }, "the next start resumes the user's model")
  assert.deepEqual(held.gate.stats(), { inFlight: 1, queued: 0, capacity: 1 }, 'only the other holder is in the gate')
})

// A render that begins while the routine runs unloads the user's model from the primary, keeps it for its release() to
// reload, and stops the routine's pool slot. The restore is refused, and the render's release starts the user's model on
// the Manager, which records nothing: the model last loaded kept naming the routine's.
test("with keep-N 2 a render during the routine reloads the user's model, which stays the model last loaded", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, userModel, routineModel } = await keepN2(t, { comfy: true })

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {
    assert.equal(store.snapshot().lastLoaded.modelKey, routineModel.key, "the swap loaded the routine's model into a pool slot")
    await guard!.acquire() // a render starts mid-run
  })

  assert.equal(result.outcome, 'ran')
  assert.equal(guard!.modelKeyLoadedOnRelease(), userModel.key, "the render's release reloads the user's model")
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' }, "the next start resumes the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' })
})

// The same with keep-N 1, for a render that pauses the restore's own load: the routine's model is stopped, the user's
// load is refused before its start, and the render's release resumes it on the Manager, which records nothing either.
test("a render that pauses the routine's restore resumes the user's model, which stays the model last loaded", {
  skip: process.platform === 'win32' && 'uses a POSIX shell wrapper as the fake engine binary',
}, async (t) => {
  const { store, manager, modelRouter, guard, comfyFree, userModel, routineModel } = await realEngineSetUp(t, { comfy: true })
  const first = await modelRouter.loadExplicit(userModel.key)
  assert.ok('target' in first, JSON.stringify(first))

  const result = await withPinnedModel({ manager, modelRouter }, routineModel.key, async () => {
    assert.equal(store.snapshot().lastLoaded.modelKey, routineModel.key)
    // The acquire lands during the restore's /free call: Manager.load has stopped the routine's model, and the
    // restore's load is refused by the pre-start hook once the call returns.
    comfyFree.hook = () => guard!.acquire()
  })

  assert.equal(result.outcome, 'ran')
  assert.equal(guard!.modelKeyLoadedOnRelease(), userModel.key, "the render's release resumes the user's model")
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' }, "the next start resumes the user's model")
  await guard!.release()
  const st = manager.status()
  assert.equal(st.state, 'running', `got ${st.state} (${st.err?.message ?? ''})`)
  assert.equal(st.model?.key, userModel.key)
  assert.deepEqual(store.snapshot().lastLoaded, { modelKey: userModel.key, engineId: 'fake' })
})
