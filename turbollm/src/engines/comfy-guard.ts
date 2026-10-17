// ComfyUI GPU coordinator — PUSH model (no polling). A one-time-installed ComfyUI
// custom node (see ../comfyui/gate-template.ts) calls TurboLLM the instant a render
// starts and when its queue drains, so the handoff is event-driven and deterministic:
//
//   POST /api/v1/comfyui/acquire → guard.acquire(): force-unload the model (freeing
//     VRAM before ComfyUI executes) and BLOCK new loads. Returns once VRAM is free.
//   POST /api/v1/comfyui/release → guard.release(): unblock loads and answer, then reload the exact model we
//     unloaded (or, if the render paused a load, start that load instead).
//
// That FORWARD direction (ComfyUI → TurboLLM) is mirrored by the REVERSE direction
// (TurboLLM → ComfyUI, F-011): before TurboLLM loads a model it calls ComfyUI's native
// `POST {url}/free` to make ComfyUI drop its VRAM first — see freeComfyUIBeforeLoad().
// The two are ONE mutual-exclusion policy, not two ping-ponging triggers: whoever the
// user is actively driving wins. The reverse free-call therefore fires ONLY when we are
// not already holding the GPU for ComfyUI (`!held`) — an in-flight render is never
// interrupted (the forward block in the load route keeps TurboLLM waiting instead).
//
// The guard owns no engine state of its own — it reads Manager.status()/currentOpts()
// and drives Manager.stopAndWait({force})/start(), the same primitives the HTTP load
// route uses. A lease backstop auto-releases if ComfyUI crashes mid-render and never
// sends release (a local timer, not a poll of ComfyUI).
//
// KV prompt-cache persistence (F-014): when the opt-in is on, the force-unload would also
// evict the model's prompt cache — so before unloading we SAVE the slot-0 KV to disk (a
// capped POST that never delays ComfyUI past the cap) and after the reload we RESTORE it,
// turning the slow re-prefill of a long prefix into a cheap memcpy. See ./slot-cache.
import type { ConfigStore, Engine } from '../config/config'
import type { Manager, StartOpts } from './manager'
import { cacheEligible, restoreSlot, SAVE_CAP_MS, saveSlot, slotCacheDir, slotCacheKey, TTL_MS } from './slot-cache'

/** The subset of the global `fetch` the reverse gate needs. Injectable so tests can
 *  assert the call without hitting the network (production defaults to global fetch). */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>

/** How long to wait on ComfyUI's `/free` before giving up. Short by design: a slow or
 *  hung ComfyUI must NOT stall a TurboLLM load — we treat the timeout as non-fatal and
 *  load anyway (the gate node treats an unreachable TurboLLM the same way). */
const FREE_TIMEOUT_MS = 10_000

/** The refusal freeComfyUIBeforeLoad throws; Manager.load stores it as the engine's error, and release()
 *  recognises it there to resume that load. */
const LOAD_PAUSED = 'ComfyUI is rendering — model loading is paused until its queue finishes.'

/** The refusal of a reload whose engine was unregistered or moved to another binary during the render (see reload()). */
const engineGone = (name: string): string =>
  `${name} was updated or removed while ComfyUI was rendering, so the model was not loaded again. Load it from Models.`

/** Backstop: if `release` never arrives (ComfyUI crashed mid-render), auto-release
 *  after this long so the model doesn't stay unloaded forever. Each acquire re-arms
 *  it: the gate node (v4+) acquires again after every prompt that leaves more queued,
 *  so it must exceed the longest single render. An older node acquires only on a
 *  queue's first prompt, so there it must outlast the whole queue (update the node).
 *  Override with TURBOLLM_COMFY_LEASE_MIN. */
const LEASE_MINUTES = (() => {
  const v = Number(process.env.TURBOLLM_COMFY_LEASE_MIN)
  return Number.isFinite(v) && v > 0 ? v : 30
})()

/** What the guard exposes to /status so the UI can explain a paused/unloaded engine. */
export interface ComfyStatus {
  enabled: boolean
  /** The gate node has been installed (a path is recorded in config). */
  installed: boolean
  /** Holding the GPU for ComfyUI right now (model unloaded, loads blocked). */
  held: boolean
  /** Model loads are currently blocked (enabled && held). */
  blocked: boolean
  /** Key of the model we unloaded for ComfyUI. Release reloads it, unless a load the render paused takes its place
   *  (see release() and modelKeyLoadedOnRelease()). */
  suspendedModelKey: string | null
  /** ms since the last acquire (a queue's first prompt, or the gate's per-prompt heartbeat) or release from
   *  ComfyUI, or null if none yet. */
  lastSignalAgoMs: number | null
}

export class ComfyGuard {
  private held = false
  // The model we unloaded because ComfyUI started: release() reloads it unless a load the render
  // paused takes its place.
  private suspended: StartOpts | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private lastSignalAt = 0
  // Serialize concurrent acquire() calls (rapid-fire enqueues) onto one unload.
  private acquiring: Promise<void> | null = null
  // Serialize concurrent reverse free-calls (rapid LLM↔image alternation) onto one
  // POST so we never double-free or race two /free requests at ComfyUI.
  private freeing: Promise<void> | null = null
  // KV prompt-cache persistence (F-014): the slot filename we successfully saved THIS
  // cycle (or null if the save was skipped/failed/ineligible). Gates the restore in
  // release() — we only restore a cache we actually wrote this acquire.
  private cachedFile: string | null = null
  // Counts acquire() calls. A reload started by release() compares it to tell that a new render began meanwhile.
  private acquires = 0
  // Stops the gateway's extra pool slots (keep-N chat models, embedding / Laya side models), which
  // hold VRAM beside the primary. Set by setPoolStopper once the router exists (cli.ts).
  private stopPoolSlots: (() => Promise<void>) | null = null
  // Auto-tune (BenchRunner), which starts its probes itself. Set by setAutoTune (cli.ts).
  private autoTune: { isRunning(): boolean; cancel(): void } | null = null
  // The gateway's swap lock (ModelRouter.withSwapLock), which release()'s reload runs under. Set by setSwapLock (cli.ts).
  private swapLock: (<T>(fn: () => Promise<T>) => Promise<T>) | null = null
  // The model release()'s reload is loading, until its start or restart settles (see modelKeyReloading()).
  private reloading: { modelKey: string } | null = null
  // The registry's engine lookup (Registry.get), which release()'s reload checks its engine against. Set by
  // setEngineLookup (cli.ts).
  private engineLookup: ((id: string) => Engine | undefined) | null = null

  private readonly leaseMs: number
  private readonly fetchImpl: FetchImpl

  constructor(
    private store: ConfigStore,
    private manager: Manager,
    /** Crash-recovery lease in minutes (defaults to env/30). Injectable for tests. */
    leaseMinutes: number = LEASE_MINUTES,
    /** HTTP client for the reverse `POST {url}/free` call. Injectable so tests don't hit
     *  the network; defaults to the Node 22 global fetch in production. */
    fetchImpl: FetchImpl = (globalThis.fetch as unknown as FetchImpl),
  ) {
    this.leaseMs = Math.max(1, leaseMinutes * 60_000)
    this.fetchImpl = fetchImpl
  }

  private enabled(): boolean {
    return this.store.snapshot().comfyui.enabled
  }

  /** Wire the pool-slot stopper: the router is built after the guard (it takes the guard). */
  setPoolStopper(stop: () => Promise<void>): void {
    this.stopPoolSlots = stop
  }

  /** Wire auto-tune, which acquire() cancels (see there). */
  setAutoTune(autoTune: { isRunning(): boolean; cancel(): void }): void {
    this.autoTune = autoTune
  }

  /** Wire the gateway's swap lock, which release()'s reload runs under (see reload()). */
  setSwapLock(lock: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.swapLock = lock
  }

  /** Wire the registry's engine lookup, which release()'s reload checks its engine against (see reload()). */
  setEngineLookup(lookup: (id: string) => Engine | undefined): void {
    this.engineLookup = lookup
  }

  /** True when a model load should be refused right now (ComfyUI holds the GPU). The
   *  HTTP load route, bench route, and startup auto-load all consult this. */
  isBlocked(): boolean {
    return this.enabled() && this.held
  }

  /** ComfyUI is starting/continuing a render: free the GPU and block loads. Resolves
   *  once VRAM is actually free, so the caller (ComfyUI) can safely begin executing.
   *  Idempotent — repeated calls just refresh the crash-recovery lease. */
  async acquire(): Promise<void> {
    if (!this.enabled()) return
    this.acquires++
    this.lastSignalAt = Date.now()
    this.armLease()
    if (this.held) return
    if (this.acquiring) return this.acquiring
    this.acquiring = (async () => {
      // Auto-tune starts its probes with Manager.start, which runs no pre-start hook, so nothing would refuse its next
      // probe mid-render: the run is cancelled, as a model load or an engine stop cancels it (its next start is then
      // refused inside the load gate). Its probe is never the model to reload either: a run starts only with nothing
      // loaded, and ends with the engine stopped.
      const tuning = this.autoTune?.isRunning() ?? false
      if (tuning) this.autoTune?.cancel()
      const st = this.manager.status()
      this.cachedFile = null
      // 'stopping' too: a model swap stopping the previous model (gracefully, up to 8 s) is killed
      // now, and the incoming model's load is refused while we hold the GPU (freeComfyUIBeforeLoad).
      if (st.state === 'running' || st.state === 'starting' || st.state === 'stopping') {
        const opts = tuning ? null : this.manager.currentOpts()
        if (opts && !this.suspended) this.suspended = opts
        // KV prompt-cache persistence (F-014): only a RUNNING engine has a real cache and a
        // reachable port to save it from. When eligible, try the CAPPED save BEFORE the
        // unload; whether it succeeds or not we then free VRAM immediately (the cap means
        // ComfyUI is never delayed past SAVE_CAP_MS). cachedFile gates the later restore.
        if (st.state === 'running' && opts) {
          const cfg = this.store.snapshot().comfyui
          if (cacheEligible(opts, cfg)) {
            const base = this.manager.target()
            if (base) {
              const filename = slotCacheKey(opts)
              const ok = await saveSlot({
                http: this.fetchImpl,
                base,
                dir: slotCacheDir(this.store.dir()),
                filename,
                capMs: SAVE_CAP_MS,
                ttlMs: TTL_MS,
                now: Date.now(),
              })
              this.cachedFile = ok ? filename : null
            }
          }
        }
        console.log('[comfy-guard] ComfyUI acquired the GPU — force-unloading the model.')
        await this.manager.stopAndWait({ force: true })
      }
      // Not suspended for release(), by decision: a pool slot's model comes back only when the gateway
      // reloads it on demand, which takes auto-swap on and a caller allowed to load models. Otherwise
      // it stays unloaded after the render until the user loads it again.
      await this.stopPoolSlots?.()
      this.held = true
    })()
    try {
      await this.acquiring
    } finally {
      this.acquiring = null
    }
  }

  /** ComfyUI's queue drained: unblock loads at once (before the first await), then start the load the render paused,
   *  else reload the model we unloaded for it. The promise settles once that reload has, and never rejects (a failed
   *  reload is logged). The release route does not wait for it: the gate node (v3+) holds its lock across the release
   *  call, and a prompt ComfyUI queues meanwhile (every "Run (Instant)" auto-queue iteration) waits for that lock on
   *  ComfyUI's server thread, so answering only after the LLM reloaded froze ComfyUI for up to the node's 10 s
   *  timeout, after which that prompt's acquire killed the reload anyway. */
  release(): Promise<void> {
    this.clearLease()
    this.lastSignalAt = Date.now()
    if (!this.held && !this.suspended) return Promise.resolve()
    this.held = false
    const opts = this.suspended
    this.suspended = null
    // Taken now, not read after the reload: an acquire landing during it saves the cache of the engine it stops, and
    // that file is the next release's to restore.
    const cachedFile = this.cachedFile
    this.cachedFile = null
    return this.reload(opts, cachedFile)
  }

  /** release()'s reload. A render that acquires while it runs (the route has already answered, so the next prompt's
   *  acquire can come at once) stops it as it stops any load: a reload already spawned is suspended and killed by
   *  acquire() itself. One not spawned yet (waiting for the load gate, or in the engine's preflight) gives that acquire
   *  nothing to suspend: it is refused, never spawned under the render, and stays the model to reload when that render
   *  ends. */
  private async reload(opts: StartOpts | null, cachedFile: string | null): Promise<void> {
    const render = this.acquires
    let refused = false
    // The engine the reload starts on, set once it is known which load that is.
    let engine: Engine | undefined
    const refuse = () => {
      refused = this.gpuClaimed()
      this.refuseLoadWhileHeld()
      // An engine update, delete or purge does not wait for a render (the model is already unloaded). A delete or
      // purge unregisters the engine, and so does an update that registers its new build under a new id (an official
      // llama.cpp backend); a purge and that update also delete its files. A release engine's update and a same-named
      // zip re-upload keep the id but swap in a new build folder whose binary can be at another path (Registry.refresh
      // records it). Starting the old opts then ran a binary that no longer exists (engine_spawn_failed, ENOENT). The
      // model stays unloaded instead, as an update leaves a running model it stops; a paused load keeps this as its
      // error. An update that replaces the binary at the same path (TurboQuant, KoboldCpp, llamafile, the pip engines,
      // a re-upload of the same layout) is reloaded as before.
      if (engine && this.engineLookup && this.engineLookup(engine.id)?.binPath !== engine.binPath) {
        throw new Error(engineGone(engine.name))
      }
    }
    // Checked inside the load gate and again right before the spawn. Between the two the start awaits its preflight
    // (vLLM and SGLang import uvloop first, about 1 s) and a port: an acquire landing there found the engine stopped,
    // and the reload then brought the LLM up under that render with nothing tracking it.
    const hooks = { beforeStart: async () => refuse(), beforeSpawn: refuse }
    // Under the gateway's swap lock, taken before the first await so no gateway load gets in first. Outside it, a
    // gateway request for this model while it loads found no running target: doLoad evicted the starting primary as
    // LRU and loaded the same model again (keep-N 1), or loaded a second copy into a pool slot (keep-N > 1). Now that
    // request waits for the reload and finds the model running. The KV restore runs after the lock is released.
    // `modelKey` is named by modelKeyReloading() from here until the start or restart settles.
    const underSwapLock = (modelKey: string | undefined, fn: () => Promise<void>): Promise<void> => {
      const mine = modelKey ? { modelKey } : null
      if (mine) this.reloading = mine
      return (this.swapLock ? this.swapLock(fn) : fn()).finally(() => {
        if (mine && this.reloading === mine) this.reloading = null
      })
    }
    let paused = false
    try {
      // A load we refused mid-render (one that reached its start while we held the GPU, e.g. a swap whose old
      // model was still stopping, which acquire() kills without suspending) left the engine in 'error' saying
      // loading resumes when the queue finishes. Keep that promise. That load is the user's latest choice, so it
      // also wins over a model the render displaced. Manager.load recorded its opts before our hook threw, so
      // restart() retries exactly it. A KV cache saved on the way in belongs to the displaced model: not restored.
      paused = this.hasPausedLoad()
      engine = (paused ? this.manager.restartOpts() : opts)?.engine
      if (paused) {
        console.log('[comfy-guard] ComfyUI released the GPU — loading the model whose load it paused.')
        await underSwapLock(this.manager.restartOpts()?.model.key, () => this.manager.restart(hooks))
      } else if (opts) {
        console.log('[comfy-guard] ComfyUI released the GPU — reloading the previous model.')
        await underSwapLock(opts.model.key, () => this.manager.start(opts, hooks))
        // KV prompt-cache persistence (F-014): if we saved a cache on the way in, restore it
        // now — but only once the reloaded engine is actually ready (the slot endpoint needs
        // the model loaded). Poll readiness up to a generous timeout; a stall or an 'error'
        // state simply skips the restore (the prefix re-prefills normally), as does a new render. Non-fatal.
        if (cachedFile) {
          await this.restoreAfterReady(opts, cachedFile, render)
        }
      }
    } catch (e) {
      if (!refused) {
        console.warn(`[comfy-guard] reload after ComfyUI failed: ${e instanceof Error ? e.message : e}`)
        return
      }
      // Refused by a new render. A paused load: Manager.load stored the same refusal as the engine's error, so that
      // render's release resumes it. A reload: that render's acquire found nothing running to suspend, so this model is
      // the one its release reloads, unless that acquire suspended a model loaded since (the user's newer choice).
      if (!paused && opts && !this.suspended) {
        this.suspended = opts
        this.cachedFile = cachedFile
      }
    }
  }

  /** A routine's restore of the model its swap displaced (`opts`, routines/model-swap.ts through
   *  ModelRouter.reloadAfterRender), refused because a render holds the GPU. That render's acquire unloaded the
   *  routine's model (`routineModelKey`) and keeps it for release() to reload, and nothing else brings the user's
   *  model back once the routine is over: release() reloads `opts` instead. Also when the render unloaded nothing (the
   *  routine's model had stopped by then): the restore would have loaded `opts` had no render been running. A load the
   *  render paused that names the routine's model is the routine's own swap, which the render refused, so the routine
   *  never ran: it is dropped, and release() reloads `opts` in its place. Left alone when release() has the user's own
   *  choice to load: another load the render paused, or another model it unloaded. Returns whether release() now
   *  reloads `opts`. */
  reloadOnReleaseInstead(routineModelKey: string, opts: StartOpts): boolean {
    // Held, not just claimed: an acquire still running may yet suspend a model, and writes cachedFile when its save ends.
    if (!this.isBlocked()) return false
    if (this.hasPausedLoad()) {
      // The render's acquire landed while that swap was stopping the user's model or waiting on the reverse gate's
      // /free call, after the user's model was gone. Resumed, release() loaded the routine's model, which nothing uses
      // now, and the user's stayed unloaded. clearError leaves the primary 'stopped', as an acquire that found nothing
      // to unload does.
      if (this.manager.restartOpts()?.model.key !== routineModelKey) return false
      this.manager.clearError()
    }
    if (this.suspended && this.suspended.model.key !== routineModelKey) return false
    this.suspended = opts
    this.cachedFile = null // a KV cache saved on the way in is the routine model's
    return true
  }

  /** The primary is in 'error' with our pre-start hook's refusal: release() resumes that load. */
  private hasPausedLoad(): boolean {
    const st = this.manager.status()
    return st.state === 'error' && st.err?.message === LOAD_PAUSED
  }

  /** Key of the model release() loads when this render ends, as release() decides it: the load it paused, else the
   *  model it unloaded. null when it loads none, or no render claims the GPU. The gateway uses it to tell a caller that
   *  may not load models whether waiting brings its model up. */
  modelKeyLoadedOnRelease(): string | null {
    if (!this.gpuClaimed()) return null
    if (this.hasPausedLoad()) return this.manager.restartOpts()?.model.key ?? null
    return this.suspended?.model.key ?? null
  }

  /** Key of the model release()'s reload is loading right now (the model the render unloaded, or the load it paused),
   *  from the release until that start or restart settles; else null. Until the engine spawns (the reload waits for the
   *  swap lock and the load gate, then a vLLM or SGLang preflight) the primary is 'stopped', or in 'error' with the
   *  paused load's refusal, and no render claims the GPU: the gateway learns from this that the model is on its way. */
  modelKeyReloading(): string | null {
    return this.reloading?.modelKey ?? null
  }

  /** Wait for the just-reloaded engine (`opts`) to reach 'running', then restore the saved KV cache
   *  (F-014), if the model running then is the one it was saved from. Bounded poll: bails on 'error' or after ~130s
   *  (just over the manager's 120s readiness window), or once `render` is no longer the latest acquire. The restore
   *  itself is non-fatal — any failure leaves the prefix to re-prefill normally. */
  private async restoreAfterReady(opts: StartOpts, filename: string, render: number): Promise<void> {
    const deadline = Date.now() + 130_000
    for (;;) {
      if (this.acquires !== render) {
        // A new render acquired meanwhile and stopped the engine. Its acquire saved the cache itself if the engine was
        // up; one that caught it still starting saved none, and this file, never restored, stays the one its release
        // restores. Dropped, the cache was gone for good, and an auto-queued prompt usually catches the reload
        // starting. (An acquire still saving overwrites this with its own result.)
        if (this.suspended === opts && this.cachedFile === null) this.cachedFile = filename
        return
      }
      const state = this.manager.status().state
      if (state === 'running') break
      if (state === 'error' || Date.now() > deadline) return
      await this.sleep(500)
    }
    // Only into the model it was saved from (the file is named by slotCacheKey: model path, launch args, engine
    // version). The reload's start can end with that model not running (ejected while it loaded, or a swap took the
    // primary), and the poll above then restored the cache into whatever model was running next.
    const running = this.manager.currentOpts()
    if (!running || slotCacheKey(running) !== filename) return
    const base = this.manager.target()
    if (!base) return
    try {
      await restoreSlot({ http: this.fetchImpl, base, dir: slotCacheDir(this.store.dir()), filename })
    } catch {
      /* non-fatal — slot-cache already swallows, but guard the await defensively */
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  /** The pre-start hook the model-load paths run inside the global load gate (Manager.load's
   *  beforeStart): the reverse gate below, bracketed by a refusal while ComfyUI holds the GPU.
   *  Auto-tune's probes do not run it (the bench route awaits it once, before the run): acquire()
   *  cancels a running auto-tune instead.
   *  The routes check isBlocked() before queuing a load, but a load that then waited for the gate
   *  (a swap stopping the previous model) or for the /free call (up to 10 s) can meet an acquire
   *  that arrived meanwhile — it must not spawn mid-render. The throw becomes the load's error. */
  async freeComfyUIBeforeLoad(): Promise<void> {
    this.refuseLoadWhileHeld()
    await this.requestComfyUIFree()
    this.refuseLoadWhileHeld()
  }

  /** The refusal itself, also the pre-spawn check (Manager's beforeSpawn hook) for a load that ran
   *  freeComfyUIBeforeLoad first: after that hook a vLLM or SGLang start still awaits its preflight (about 1 s) and a
   *  port, and a render acquiring there finds no engine to stop. Throws while a render claims the GPU. */
  refuseLoadWhileHeld(): void {
    if (this.gpuClaimed()) {
      throw new Error(LOAD_PAUSED)
    }
  }

  /** True from the moment an acquire begins until release. isBlocked() turns true only once the acquire has freed
   *  VRAM; a load that comes up in between (the gateway's pool slots) must not serve during the render either. */
  gpuClaimed(): boolean {
    return this.enabled() && (this.held || this.acquiring !== null)
  }

  /** REVERSE gate (F-011): TurboLLM is about to load a model — ask ComfyUI to drop its
   *  VRAM first by calling its native `POST {url}/free`. Symmetric counterpart of the
   *  forward acquire/release gate. The model-load entry points (the HTTP load route,
   *  the startup auto-load, a gateway swap) await this before their engine starts, and
   *  the bench route once before an auto-tune run (not before each of its probes).
   *
   *  Fires ONLY when ComfyUI is idle from our side (`!held`): if WE currently hold the
   *  GPU for ComfyUI a render is in flight, and the forward block already kept this load
   *  out — never interrupt that render. Any failure (ComfyUI down, connection refused,
   *  timeout, non-2xx) is NON-FATAL: we log a warning and return so the load proceeds,
   *  exactly as the gate node treats an unreachable TurboLLM. Concurrent calls (rapid
   *  LLM↔image alternation) collapse onto one in-flight POST so we never double-free. */
  private async requestComfyUIFree(): Promise<void> {
    const cfg = this.store.snapshot().comfyui
    if (!cfg.enabled || !cfg.reverseGate || !cfg.url || this.held) return
    if (this.freeing) return this.freeing
    this.freeing = (async () => {
      const url = `${cfg.url.replace(/\/+$/, '')}/free`
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
          signal: AbortSignal.timeout(FREE_TIMEOUT_MS),
        })
        if (res.ok) {
          console.log('[comfy-guard] freed ComfyUI VRAM before model load.')
        } else {
          console.warn(`[comfy-guard] ComfyUI /free returned ${res.status} — loading anyway.`)
        }
      } catch (e) {
        // TypeError (fetch failed / ECONNREFUSED) = ComfyUI simply not running — silent.
        if (!(e instanceof TypeError)) {
          console.warn(`[comfy-guard] unexpected error calling ComfyUI /free (${e instanceof Error ? e.message : e}) — loading anyway.`)
        }
      }
    })()
    try {
      await this.freeing
    } finally {
      this.freeing = null
    }
  }

  snapshot(): ComfyStatus {
    const cfg = this.store.snapshot().comfyui
    return {
      enabled: cfg.enabled,
      installed: !!cfg.gatePath,
      held: cfg.enabled && this.held,
      blocked: cfg.enabled && this.held,
      suspendedModelKey: this.suspended?.model.key ?? null,
      lastSignalAgoMs: this.lastSignalAt ? Date.now() - this.lastSignalAt : null,
    }
  }

  /** Stop the lease timer (daemon shutdown/restart) so a backstop can't fire mid-teardown. */
  stop(): void {
    this.clearLease()
  }

  private armLease(): void {
    this.clearLease()
    this.leaseTimer = setTimeout(() => {
      console.warn('[comfy-guard] no ComfyUI signal before lease expiry — auto-releasing (assuming ComfyUI exited).')
      void this.release()
    }, this.leaseMs)
    this.leaseTimer.unref?.()
  }

  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
  }
}
