// ComfyUI GPU coordinator — PUSH model (no polling). A one-time-installed ComfyUI
// custom node (see ../comfyui/gate-template.ts) calls TurboLLM the instant a render
// starts and when its queue drains, so the handoff is event-driven and deterministic:
//
//   POST /api/v1/comfyui/acquire → guard.acquire(): force-unload the model (freeing
//     VRAM before ComfyUI executes) and BLOCK new loads. Returns once VRAM is free.
//   POST /api/v1/comfyui/release → guard.release(): reload the exact model we unloaded.
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
import type { ConfigStore } from '../config/config'
import type { Manager, StartOpts } from './manager'
import { cacheEligible, restoreSlot, SAVE_CAP_MS, saveSlot, slotCacheDir, slotCacheKey, TTL_MS } from './slot-cache'

/** The subset of the global `fetch` the reverse gate needs. Injectable so tests can
 *  assert the call without hitting the network (production defaults to global fetch). */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>

/** How long to wait on ComfyUI's `/free` before giving up. Short by design: a slow or
 *  hung ComfyUI must NOT stall a TurboLLM load — we treat the timeout as non-fatal and
 *  load anyway (the gate node treats an unreachable TurboLLM the same way). */
const FREE_TIMEOUT_MS = 10_000

/** Backstop: if `release` never arrives (ComfyUI crashed mid-render), auto-release
 *  after this long so the model doesn't stay unloaded forever. Each acquire re-arms
 *  it. Must exceed the longest single render; override with TURBOLLM_COMFY_LEASE_MIN. */
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
  /** Key of the model we unloaded for ComfyUI and will reload on release. */
  suspendedModelKey: string | null
  /** ms since the last acquire/heartbeat signal from ComfyUI, or null if none yet. */
  lastSignalAgoMs: number | null
}

export class ComfyGuard {
  private held = false
  // The model we unloaded because ComfyUI started — reloaded on release.
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
  // Stops the gateway's extra pool slots (keep-N chat models, embedding / Laya side models), which
  // hold VRAM beside the primary. Set by setPoolStopper once the router exists (cli.ts).
  private stopPoolSlots: (() => Promise<void>) | null = null

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
    this.lastSignalAt = Date.now()
    this.armLease()
    if (this.held) return
    if (this.acquiring) return this.acquiring
    this.acquiring = (async () => {
      const st = this.manager.status()
      this.cachedFile = null
      // 'stopping' too: a model swap stopping the previous model (gracefully, up to 8 s) is killed
      // now, and the incoming model's load is refused while we hold the GPU (freeComfyUIBeforeLoad).
      if (st.state === 'running' || st.state === 'starting' || st.state === 'stopping') {
        const opts = this.manager.currentOpts()
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

  /** ComfyUI's queue drained: unblock loads and reload the model we unloaded for it. */
  async release(): Promise<void> {
    this.clearLease()
    this.lastSignalAt = Date.now()
    if (!this.held && !this.suspended) return
    this.held = false
    const opts = this.suspended
    this.suspended = null
    if (opts) {
      console.log('[comfy-guard] ComfyUI released the GPU — reloading the previous model.')
      try {
        await this.manager.start(opts)
        // KV prompt-cache persistence (F-014): if we saved a cache on the way in, restore it
        // now — but only once the reloaded engine is actually ready (the slot endpoint needs
        // the model loaded). Poll readiness up to a generous timeout; a stall or an 'error'
        // state simply skips the restore (the prefix re-prefills normally). Non-fatal.
        if (this.cachedFile) {
          await this.restoreAfterReady(this.cachedFile)
        }
      } catch (e) {
        console.warn(`[comfy-guard] reload after ComfyUI failed: ${e instanceof Error ? e.message : e}`)
      }
    }
    this.cachedFile = null
  }

  /** Wait for the just-reloaded engine to reach 'running', then restore the saved KV cache
   *  (F-014). Bounded poll: bails on 'error' or after ~130s (just over the manager's 120s
   *  readiness window). The restore itself is non-fatal — any failure leaves the prefix to
   *  re-prefill normally. */
  private async restoreAfterReady(filename: string): Promise<void> {
    const deadline = Date.now() + 130_000
    for (;;) {
      const state = this.manager.status().state
      if (state === 'running') break
      if (state === 'error' || Date.now() > deadline) return
      await this.sleep(500)
    }
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

  /** The pre-start hook every model-load path runs inside the global load gate (Manager.load's
   *  beforeStart): the reverse gate below, bracketed by a refusal while ComfyUI holds the GPU.
   *  The routes check isBlocked() before queuing a load, but a load that then waited for the gate
   *  (a swap stopping the previous model) or for the /free call (up to 10 s) can meet an acquire
   *  that arrived meanwhile — it must not spawn mid-render. The throw becomes the load's error. */
  async freeComfyUIBeforeLoad(): Promise<void> {
    this.refuseLoadWhileHeld()
    await this.requestComfyUIFree()
    this.refuseLoadWhileHeld()
  }

  private refuseLoadWhileHeld(): void {
    if (this.enabled() && (this.held || this.acquiring)) {
      throw new Error('ComfyUI is rendering — model loading is paused until its queue finishes.')
    }
  }

  /** REVERSE gate (F-011): TurboLLM is about to load a model — ask ComfyUI to drop its
   *  VRAM first by calling its native `POST {url}/free`. Symmetric counterpart of the
   *  forward acquire/release gate. Every model-load entry point (the HTTP load route,
   *  the bench load, the startup auto-load) awaits this before `manager.start(...)`.
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
