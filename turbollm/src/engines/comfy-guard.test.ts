// ComfyUI GPU-coordination tests (push model). The guard's contract:
//   • acquire() while a model is loaded → force-unload it, capture it, block loads.
//   • acquire() with nothing loaded → still blocks loads (ComfyUI owns the GPU).
//   • release() → reload exactly the model that was unloaded; unblock loads.
//   • disabled → acquire/release are no-ops and loads are never blocked.
//   • the lease backstop auto-releases (reloads) if release never arrives.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComfyGuard } from './comfy-guard'
import type { FetchImpl } from './comfy-guard'
import type { StartOpts, Status } from './manager'

/** Records the reverse-gate `POST {url}/free` calls so tests can assert on them, and
 *  returns a scripted response. `throws` simulates an unreachable/timed-out ComfyUI. */
function fakeFetch(opts: { ok?: boolean; status?: number; throws?: boolean } = {}) {
  const calls: { url: string; init?: { body?: unknown } }[] = []
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init: init as { body?: unknown } })
    if (opts.throws) throw new Error('ECONNREFUSED')
    return { ok: opts.ok ?? true, status: opts.status ?? 200 }
  }
  return { impl, calls }
}

/** Minimal Manager double: records start/force-stop calls, reports a scripted state.
 *  `target()` returns a base URL whenever running (slot save/restore needs a reachable
 *  port); `start()` flips state to 'running' immediately so the release-time readiness
 *  poll resolves at once in tests. */
function fakeManager(initial: { state: Status['state']; opts: StartOpts | null }) {
  let state = initial.state
  let opts = initial.opts
  const calls = { stops: 0, forceStops: 0, starts: [] as StartOpts[] }
  return {
    mgr: {
      status: () => ({ state, err: null, port: 0, pid: 0, model: opts?.model ?? null, loadElapsedMs: 0 }) as Status,
      target: () => (state === 'running' ? 'http://127.0.0.1:0' : null),
      currentOpts: () => ((state === 'running' || state === 'starting') ? opts : null),
      stopAndWait: async (o?: { force?: boolean }) => {
        calls.stops++
        if (o?.force) calls.forceStops++
        state = 'stopped'
        opts = null
      },
      start: async (o: StartOpts) => {
        calls.starts.push(o)
        state = 'running'
        opts = o
      },
    },
    calls,
  }
}

/** ConfigStore double returning a fixed comfyui config snapshot. `url`/`reverseGate`
 *  default off so the existing forward-gate tests are unaffected by the reverse gate. */
function fakeStore(comfyui: {
  enabled: boolean
  gatePath: string
  url?: string
  reverseGate?: boolean
  cachePersist?: boolean
}) {
  const full = { url: '', reverseGate: false, cachePersist: false, ...comfyui }
  return {
    snapshot: () => ({ comfyui: full }),
    // slot-cache helpers ask the store for the data dir to compute the slot-cache path.
    dir: () => '/tmp/turbollm-test',
  } as unknown as ConstructorParameters<typeof ComfyGuard>[0]
}

const OPTS = (key: string): StartOpts => ({
  engine: { id: 'e', name: 'llama', binPath: '/x', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
  model: { key, name: key, quant: 'Q4', ctx: 4096, vision: false },
  modelPath: `/models/${key}`,
  extraArgs: [],
})

test('acquire force-unloads the running model + blocks; release reloads exactly it', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('llama-8b') })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  assert.equal(calls.forceStops, 1, 'should force-unload (free VRAM now)')
  assert.equal(g.isBlocked(), true, 'loads blocked while ComfyUI holds the GPU')
  assert.equal(g.snapshot().suspendedModelKey, 'llama-8b', 'remembers what to restore')

  await g.release()
  assert.equal(calls.starts.length, 1, 'should reload on release')
  assert.equal(calls.starts[0].model.key, 'llama-8b', 'reloads the exact model it unloaded')
  assert.equal(g.isBlocked(), false, 'loads unblocked after release')
  assert.equal(g.snapshot().suspendedModelKey, null, 'capture cleared')
})

test('acquire with nothing loaded still blocks; release has nothing to reload', async () => {
  const { mgr, calls } = fakeManager({ state: 'stopped', opts: null })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  assert.equal(calls.stops, 0, 'no model to stop')
  assert.equal(g.isBlocked(), true, 'still blocks loads — ComfyUI owns the GPU')

  await g.release()
  assert.equal(calls.starts.length, 0, 'nothing to reload — no model was loaded')
  assert.equal(g.isBlocked(), false)
})

test('repeated acquire is idempotent — one unload, stays blocked', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('m') })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  await g.acquire()
  await g.acquire()
  assert.equal(calls.forceStops, 1, 'extra acquires must not unload again')
  assert.equal(g.isBlocked(), true)
})

test('disabled guard is fully inert (never blocks, never touches the engine)', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('m') })
  const g = new ComfyGuard(fakeStore({ enabled: false, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  assert.equal(calls.stops, 0, 'disabled acquire must not stop the engine')
  assert.equal(g.isBlocked(), false, 'disabled guard never blocks loads')
})

test('lease backstop auto-reloads if release never arrives', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('m') })
  // Tiny lease (~60ms) via the injectable constructor param.
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never, 0.001)
  await g.acquire()
  assert.equal(g.isBlocked(), true)
  await new Promise((r) => setTimeout(r, 200)) // let the lease fire
  assert.equal(calls.starts.length, 1, 'backstop should reload the model')
  assert.equal(g.isBlocked(), false, 'backstop releases the block')
})

// ── Reverse gate (F-011): freeComfyUIBeforeLoad() ─────────────────────────────
//   • disabled OR reverseGate off OR no url → never calls ComfyUI.
//   • enabled + reverseGate + url + idle → POSTs {unload_models,free_memory} to /free.
//   • currently holding the GPU for ComfyUI (forward gate active) → no call (don't
//     interrupt an in-flight render — the forward block already kept this load out).
//   • any HTTP failure (down, non-2xx, timeout) is swallowed so the load proceeds.

test('reverse gate off → no /free call', async () => {
  const { mgr } = fakeManager({ state: 'stopped', opts: null })
  const f = fakeFetch()
  // enabled but reverseGate not set + no url.
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/g' }), mgr as never, undefined, f.impl)
  await g.freeComfyUIBeforeLoad()
  assert.equal(f.calls.length, 0, 'must not call ComfyUI when the reverse gate is off')
})

test('reverse gate on but disabled comfyui → no /free call', async () => {
  const { mgr } = fakeManager({ state: 'stopped', opts: null })
  const f = fakeFetch()
  const g = new ComfyGuard(
    fakeStore({ enabled: false, gatePath: '', url: 'http://127.0.0.1:8188', reverseGate: true }),
    mgr as never, undefined, f.impl,
  )
  await g.freeComfyUIBeforeLoad()
  assert.equal(f.calls.length, 0, 'disabled ComfyUI coordination → reverse gate inert')
})

test('reverse gate on + idle → POSTs the free request to {url}/free', async () => {
  const { mgr } = fakeManager({ state: 'stopped', opts: null })
  const f = fakeFetch()
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', url: 'http://127.0.0.1:8188/', reverseGate: true }),
    mgr as never, undefined, f.impl,
  )
  await g.freeComfyUIBeforeLoad()
  assert.equal(f.calls.length, 1, 'should ask ComfyUI to free its VRAM')
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8188/free', 'trailing slash trimmed, /free appended')
  assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)), { unload_models: true, free_memory: true })
})

test('reverse gate does NOT fire while holding the GPU for ComfyUI (render in flight)', async () => {
  const { mgr } = fakeManager({ state: 'running', opts: OPTS('m') })
  const f = fakeFetch()
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', url: 'http://127.0.0.1:8188', reverseGate: true }),
    mgr as never, undefined, f.impl,
  )
  await g.acquire() // ComfyUI now holds the GPU (held === true)
  // The hook runs inside the load gate right before the spawn: a load that got this far is refused.
  await assert.rejects(g.freeComfyUIBeforeLoad(), /ComfyUI is rendering/)
  assert.equal(f.calls.length, 0, 'never interrupt an in-flight render via the reverse gate')
})

// A load that is already past the routes' isBlocked() check (waiting for the load gate, or in its
// /free call) must not spawn once a render has acquired the GPU in the meantime.
test('a load whose /free call is in flight when ComfyUI acquires is refused', async () => {
  const { mgr } = fakeManager({ state: 'stopped', opts: null })
  let answer!: () => void
  const slowFree: FetchImpl = () => new Promise((r) => { answer = () => r({ ok: true, status: 200 }) })
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', url: 'http://127.0.0.1:8188', reverseGate: true }),
    mgr as never, undefined, slowFree,
  )
  const hook = g.freeComfyUIBeforeLoad()

  await g.acquire()
  answer()

  await assert.rejects(hook, /ComfyUI is rendering/)
})

test('acquire during a model swap force-stops the model that is still stopping', async () => {
  const { mgr, calls } = fakeManager({ state: 'stopping', opts: null })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/g' }), mgr as never)

  await g.acquire()

  assert.equal(calls.forceStops, 1, 'the graceful stop (up to 8 s) is cut short')
  assert.equal(g.isBlocked(), true)
})

test('release resumes a load the guard refused mid-render, over the model the render displaced, without its cache', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('a') })
  const f = fakeFetch({ ok: true })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/g', cachePersist: true }), mgr as never, undefined, f.impl)
  await g.acquire() // suspends A and saves its KV cache
  // A swap to B, queued behind the render, reaches its start: the hook refuses it and Manager.load stores
  // the refusal as the engine's error (restart() would retry B, the opts it recorded before the hook).
  const refusal = await g.freeComfyUIBeforeLoad().then(() => null, (e: Error) => e.message)
  let restarts = 0
  Object.assign(mgr, {
    status: () => ({ state: 'error', err: { code: 'load_failed', message: refusal, exitCode: -1, logTail: [] }, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    restart: async () => { restarts++ },
  })

  await g.release()

  assert.equal(restarts, 1, 'the refused load is retried')
  assert.equal(calls.starts.length, 0, 'A, which the user had already swapped away from, is not reloaded')
  assert.equal(f.calls.filter((c) => c.url.includes('action=restore')).length, 0, "A's KV cache is not restored into B")
  assert.equal(g.isBlocked(), false)
})

// The gateway answers a caller that may not load models from this: it must name the model release() loads.
test('modelKeyLoadedOnRelease names what release() loads: the paused load over the unloaded model, none outside a render', async () => {
  const { mgr } = fakeManager({ state: 'running', opts: OPTS('a') })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/g' }), mgr as never)
  assert.equal(g.modelKeyLoadedOnRelease(), null, 'no render')
  await g.acquire()
  assert.equal(g.modelKeyLoadedOnRelease(), 'a', 'the model the render unloaded')

  const refusal = await g.freeComfyUIBeforeLoad().then(() => null, (e: Error) => e.message)
  Object.assign(mgr, {
    status: () => ({ state: 'error', err: { code: 'load_failed', message: refusal, exitCode: -1, logTail: [] }, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    restartOpts: () => OPTS('b'),
    restart: async () => {},
  })
  assert.equal(g.modelKeyLoadedOnRelease(), 'b', 'the load the render paused wins')

  await g.release()
  assert.equal(g.modelKeyLoadedOnRelease(), null, 'the render is over')
})

// Not only once the GPU is held: while acquire is still freeing VRAM, release() will already reload the model.
test('modelKeyLoadedOnRelease already names the unloaded model while acquire is still stopping it', async () => {
  const { mgr } = fakeManager({ state: 'running', opts: OPTS('a') })
  let finishStop = () => {}
  Object.assign(mgr, {
    stopAndWait: async () => {
      Object.assign(mgr, { currentOpts: () => null })
      await new Promise<void>((resolve) => { finishStop = resolve })
    },
  })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/g' }), mgr as never)

  const acq = g.acquire()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(g.isBlocked(), false, 'the GPU is not held yet')
  assert.equal(g.modelKeyLoadedOnRelease(), 'a')

  finishStop()
  await acq
  await g.release()
})

test('acquire also stops the gateway pool slots, before it reports the GPU free', async () => {
  const { mgr } = fakeManager({ state: 'running', opts: OPTS('m') })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/g' }), mgr as never)
  const events: string[] = []
  g.setPoolStopper(async () => {
    await new Promise((r) => setTimeout(r, 20))
    events.push('pool slots stopped')
  })

  await g.acquire()
  events.push('acquire returned')

  assert.deepEqual(events, ['pool slots stopped', 'acquire returned'])
  assert.equal(g.isBlocked(), true)
})

test('reverse gate HTTP failure is non-fatal (load proceeds)', async () => {
  const { mgr } = fakeManager({ state: 'stopped', opts: null })
  const f = fakeFetch({ throws: true })
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', url: 'http://127.0.0.1:8188', reverseGate: true }),
    mgr as never, undefined, f.impl,
  )
  // Must resolve (not reject) even though ComfyUI is unreachable.
  await g.freeComfyUIBeforeLoad()
  assert.equal(f.calls.length, 1, 'attempted the call')
})

// ── KV prompt-cache persistence (F-014) ───────────────────────────────────────
//   • cachePersist on + eligible running model → acquire() POSTs …/slots/0?action=save
//     and STILL force-unloads; release() then POSTs …/slots/0?action=restore once running.
//   • cachePersist off → no save/restore POSTs (the cycle is unchanged).
//   • a failed save → still unloads, and release() does NOT attempt a restore.
// The guard reuses its injected fetchImpl as the SlotHttp, so the fake records both the
// reverse-gate /free calls (none here) and the slot calls — filter by URL.

const saves = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('action=save'))
const restores = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('action=restore'))

test('cachePersist: acquire saves the slot cache then still force-unloads', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('llama-8b') })
  const f = fakeFetch({ ok: true })
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', cachePersist: true }),
    mgr as never, undefined, f.impl,
  )

  await g.acquire()
  const s = saves(f.calls)
  assert.equal(s.length, 1, 'should save the prompt cache before unloading')
  assert.match(s[0].url, /\/slots\/0\?action=save$/, 'targets the slot-0 save action')
  assert.equal(calls.forceStops, 1, 'still force-unloads to free VRAM after the save')
})

test('cachePersist: release restores the slot cache once the engine is running again', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('llama-8b') })
  const f = fakeFetch({ ok: true })
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', cachePersist: true }),
    mgr as never, undefined, f.impl,
  )

  await g.acquire()
  await g.release()
  assert.equal(calls.starts.length, 1, 'reloads the model first')
  const r = restores(f.calls)
  assert.equal(r.length, 1, 'restores the saved cache after the reload')
  assert.match(r[0].url, /\/slots\/0\?action=restore$/, 'targets the slot-0 restore action')
})

test('cachePersist off → neither save nor restore is attempted', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('llama-8b') })
  const f = fakeFetch({ ok: true })
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', cachePersist: false }),
    mgr as never, undefined, f.impl,
  )

  await g.acquire()
  await g.release()
  assert.equal(saves(f.calls).length, 0, 'no save when the opt-in is off')
  assert.equal(restores(f.calls).length, 0, 'no restore when the opt-in is off')
  assert.equal(calls.forceStops, 1, 'the unload/reload cycle is otherwise unchanged')
  assert.equal(calls.starts.length, 1)
})

test('cachePersist: a failed save means release skips the restore', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('llama-8b') })
  // Save POST throws (timeout / hit the cap) → cachedFile stays null.
  const f = fakeFetch({ throws: true })
  const g = new ComfyGuard(
    fakeStore({ enabled: true, gatePath: '/cn/g', cachePersist: true }),
    mgr as never, undefined, f.impl,
  )

  await g.acquire()
  assert.equal(saves(f.calls).length, 1, 'attempted the save')
  assert.equal(calls.forceStops, 1, 'still force-unloads even though the save failed')

  await g.release()
  assert.equal(calls.starts.length, 1, 'still reloads the model')
  assert.equal(restores(f.calls).length, 0, 'no restore — nothing was saved this cycle')
})
