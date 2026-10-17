// Gateway intelligence (v0.6.0): auto model-swap and keep-N pool.
// When a /v1/* request includes a `model` field, the router resolves it against
// the local model library and loads (or swaps to) that model automatically.
// Inspired by llama-swap; operates on the existing Manager + Scanner primitives.
import { Manager, type StartOpts } from '../engines/manager'
import type { ConfigStore, Engine } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'
import type { ComfyGuard } from '../engines/comfy-guard'
import type { LoadProfile } from '../models/profile'
import { modelIncompatibility } from '../engines/compat'
import { engineForModel } from '../engines/registry'
import { buildStartOpts } from '../engines/start-opts'
import { getSysInfo } from '../sysinfo/sysinfo'
import { parseRemoteId } from '../link/model-id'
import type { RemoteCatalog } from '../link/remote-catalog'
import { modelLoadsRefused } from '../auth'

export type RouteResult =
  | {
      target: string
      /** Present only for a Turbo Link remote model. The gateway uses this to build the
       *  upstream URL and to present the LINK token instead of the caller's credential.
       *  Absent = an ordinary local engine target, unchanged. */
      remote?: { linkId: string; baseUrl: string; token: string; modelKey: string; noLoad?: true }
      /** The engine serving `target` when it is an extra pool slot, read from that slot's manager: a `.litertlm` model
       *  there runs on LiteRT-LM whatever the primary runs. The gateway shapes the outbound request (model alias or path,
       *  token-limit key) and labels the reply from these; absent (the primary, remote) it reads the primary, as before. */
      engineKind?: string
      modelPath?: string
      modelName?: string
    }
  | {
      status: 503
      message: string
      /** A retry cannot help this caller: its token may not load models and nothing is bringing the model up, the
       *  active engine cannot run the model, its link needs re-pairing or an update, or the retry would re-run a load
       *  that just failed or was cancelled (evicting what is loaded each time). The gateway tells clients not to retry
       *  these. Absent, the refusal may clear by itself (a load in progress, ComfyUI's queue, a link still connecting)
       *  or costs nothing to repeat, so the client's own retry policy applies. */
      permanent?: true
    }

interface PoolSlot {
  manager: Manager
  modelKey: string
  lastUsedMs: number
}

const UNLOADED_WHILE_LOADING = 'The model was unloaded while it was loading.'

/** A Laya load that has begun and not yet settled (ADR-443). `cancelled` is set by an eject while it loads. */
interface LayaLoad {
  manager: Manager
  modelKey: string
  startedMs: number
  cancelled: boolean
}

/** One loaded (or loading / unloading) model across the pool, as `aliveSlots()` reports it. */
export interface AliveSlot {
  modelKey: string
  state: 'running' | 'starting' | 'stopping'
  primary: boolean
  lastUsedMs: number
}

/** Auto-swap gateway: resolves the `model` field in API requests and loads the
 *  requested model when it isn't already running. Supports a keep-N pool so
 *  frequently-used models can stay loaded simultaneously (VRAM permitting). */
export class ModelRouter {
  /** Extra pool slots beyond the primary manager. Only populated when keepN > 1. */
  private extraSlots = new Map<string, PoolSlot>()
  /** Laya loads in flight, by model key. Separate from extraSlots on purpose: a slot is registered only once its
   *  load has succeeded, so a request can never be routed to a manager that is still loading. */
  private layaLoads = new Map<string, LayaLoad>()
  /** The model doLoad is loading right now (one at a time: it runs under the swap lock). A pool slot's load is
   *  otherwise visible nowhere until it has succeeded. */
  private loadingKey: string | undefined
  /** The pool-slot manager that load runs in, and the engine it loads on (unset for a load into the primary). It is in
   *  no extraSlots entry until it has loaded, yet it already holds VRAM, so poolEngineIds and stopPoolSlotsOnEngine (a
   *  ComfyUI render's pool stopper, an engine update) count it too: on that engine, and, while it still runs or stops
   *  the LRU model it evicted (until Manager.load gets the load gate and that model has exited), on that model's. */
  private loadingSlot: { manager: Manager; engineId: string } | undefined
  /** Pool-slot managers dropped from extraSlots (dropSlot) while their engine may still exit: tracked nowhere else, yet
   *  the process keeps its VRAM and its engine's files until it is gone (a graceful stop, on Windows a full 8 s).
   *  Exited ones are pruned on every drop and every pool read, so it holds at most the slots that were still exiting
   *  at the last of those. */
  private stoppingSlots = new Set<Manager>()
  /** Last-used timestamp for the primary manager slot (for LRU eviction). */
  private primaryLastUsed = 0
  /** Promise chain that serialises swap operations so concurrent requests for
   *  different models queue rather than race. */
  private swapChain: Promise<void> = Promise.resolve()

  constructor(
    private store: ConfigStore,
    private registry: Registry,
    private manager: Manager,
    private scanner: Scanner,
    private comfy: ComfyGuard | undefined,
    /** Turbo Link peer catalog (ADR-376). Optional and TRAILING so every pre-Turbo-Link
     *  construction site keeps compiling unchanged; when absent, `route()` behaves
     *  exactly as it did before — there are no links, so nothing can be remote. */
    private catalog?: RemoteCatalog,
    /** Builds the Manager for a new pool slot; a parameter only so a test can watch what it loads. */
    private newSlotManager: () => Manager = () => new Manager(store, { poolSlot: true }),
  ) {}

  /** Route a request to the correct model target URL.
   *  - If autoSwap is off: returns whatever the primary manager has loaded.
   *  - If the requested model is already loaded: returns its target immediately.
   *  - Otherwise: loads the model (swapping / evicting LRU as needed) and waits. */
  async route(requestedModel: string): Promise<RouteResult> {
    const cfg = this.store.snapshot()

    // Turbo Link (ADR-376). A qualified `<machine>/<model>` id is resolved here and
    // NOWHERE ELSE, and it must FAIL LOUDLY rather than degrade to a local model.
    //
    // Two pieces of deliberately-helpful existing behaviour make this critical:
    //   1. the autoSwap-off early return below hands back whatever is loaded, and
    //   2. resolveEntry ends in a SUBSTRING match, then route() falls back to the loaded
    //      model for anything unresolved, "so unrecognised aliases don't break clients".
    // Composed, an offline peer would be silently answered by a local model with the
    // wrong weights and no error. So: once an id parses as qualified AND names a known
    // machine, every failure path from here is a 503. It never falls through.
    //
    // This sits at the VERY TOP of route(), above the autoSwap early return, because
    // that return never reaches resolveRemote — with auto-swap off the whole guard would
    // otherwise be bypassed, which is the single most dangerous configuration.
    const remote = this.resolveRemote(requestedModel)
    if (remote) return remote

    // Auto-swap disabled or no model requested → fall back to current loaded model.
    if (!cfg.gateway.autoSwap || !requestedModel.trim()) {
      const t = this.manager.target()
      return t ? { target: t } : { status: 503, message: 'No model loaded. Load one in TurboLLM.' }
    }

    const entry = this.resolveEntry(requestedModel)
    if (!entry) {
      // Unknown model — fall back gracefully so unrecognised aliases don't break clients.
      const t = this.manager.target()
      return t
        ? { target: t }
        : { status: 503, message: `No model matching '${requestedModel}' found. Add one in TurboLLM.` }
    }

    const alive = this.routeResolved(entry)
    if (alive) return alive
    if (modelLoadsRefused()) return this.notLoadedForCaller(entry)

    // Need to load / swap. Serialise so concurrent requests for different models
    // queue rather than racing to start/stop the same engine simultaneously.
    return this.withSwapLock(() => this.doLoad(entry))
  }

  /** Route to exactly `entry` — never to a different model (ADR-434). Unlike
   *  route(), an entry that isn't alive is never answered by whatever the primary holds: with
   *  auto-swap on it is loaded (the same serialised doLoad route() uses); with it off, a 503. */
  async routeTo(entry: ModelEntry): Promise<RouteResult> {
    const alive = this.routeResolved(entry)
    if (alive) return alive
    if (!this.store.snapshot().gateway.autoSwap) {
      return { status: 503, message: `'${entry.name}' is not loaded. Load it from Models, or turn on auto-swap.` }
    }
    if (modelLoadsRefused()) return this.notLoadedForCaller(entry)
    return this.withSwapLock(() => this.doLoad(entry))
  }

  /** The local entry `requested` names — exact key → exact name → ci name → substring. No remote,
   *  no fallback. */
  resolveLocal(requested: string): ModelEntry | undefined {
    return this.resolveEntry(requested)
  }

  /** Which local entry route(requested) would hit, WITHOUT loading anything. Mirrors route():
   *  remote id → undefined; auto-swap off or no model named → the primary's entry; resolved → that
   *  entry; unresolved → the primary's entry. */
  targetEntry(requested: string): ModelEntry | undefined {
    if (this.resolveRemote(requested)) return undefined
    if (!this.store.snapshot().gateway.autoSwap || !requested.trim()) return this.primaryEntry()
    return this.resolveEntry(requested) ?? this.primaryEntry()
  }

  /** Every alive slot (running | starting | stopping), primary first. */
  aliveSlots(): AliveSlot[] {
    const slots: AliveSlot[] = []
    const ms = this.manager.status()
    if (this.isOccupied(ms.state) && ms.model) {
      slots.push({ modelKey: ms.model.key, state: ms.state, primary: true, lastUsedMs: this.primaryLastUsed })
    }
    for (const slot of this.extraSlots.values()) {
      const state = slot.manager.status().state
      if (this.isOccupied(state)) slots.push({ modelKey: slot.modelKey, state, primary: false, lastUsedMs: slot.lastUsedMs })
    }
    for (const load of this.layaLoads.values()) {
      slots.push({ modelKey: load.modelKey, state: load.cancelled ? 'stopping' : 'starting', primary: false, lastUsedMs: load.startedMs })
    }
    return slots
  }

  /** Load `modelKey` unconditionally — used by a Routine's pinned-model swap (spec 20 §5), which
   *  is an explicit per-routine decision made once at creation time and must NOT be silently
   *  skipped just because the user's own, unrelated chat auto-swap preference
   *  (`cfg.gateway.autoSwap`) happens to be off. Reuses every other piece of route()'s machinery
   *  — LRU eviction, keepN pool, ComfyUI guard, swap serialization — by delegating straight to
   *  the same withSwapLock()/doLoad() route() itself calls; only the autoSwap early-return is
   *  skipped. Callers are responsible for their OWN idle-vs-busy decision before calling this
   *  (see routines/model-swap.ts) — this method has no opinion on whether now is a safe time to
   *  swap, only on HOW to swap once that's decided. */
  async loadExplicit(modelKey: string, overrides?: Partial<LoadProfile>): Promise<RouteResult> {
    // Same invariant-5 guard as route(): a routine pinned to `<machine>/<model>` must
    // never be satisfied by resolveEntry's substring match against a LOCAL model.
    const remote = this.resolveRemote(modelKey)
    if (remote) return remote
    const entry = this.resolveEntry(modelKey)
    if (!entry) return { status: 503, message: `No model matching '${modelKey}' found. Add one in TurboLLM.` }
    return this.withSwapLock(() => this.doLoad(entry, overrides))
  }

  /** Acquire the SAME swap-serialization queue `route()` uses, then run `fn` exclusively with
   *  respect to any other swap (manual or auto). `route()` itself is just this wrapping
   *  `doLoad()` — exposed publicly so a MANUAL model switch (routes.ts's `/api/v1/engine/start`,
   *  which loads the primary manager directly, entirely outside this router) can coordinate too.
   *
   *  Why this was missing mattered in practice: the lower-level `Manager.runExclusive` static
   *  gate already stops two loads from physically racing (no double-spawn), but it only
   *  serialises EXECUTION order — it doesn't stop a router-triggered auto-swap (e.g. a
   *  terminal-agent session's own gateway traffic) from independently deciding, mid-manual-
   *  switch, "the primary is occupied, evict it and load MY model" (`evictChatLru()` picks
   *  the primary as LRU whenever it's the only occupied slot, `'starting'`/`'stopping'`
   *  included per ADR-285's `isOccupied()` fix). That decision would then queue behind the
   *  manual switch at the `Manager` gate and win once it finally ran — so the model that ends
   *  up loaded silently isn't the one the user just picked in the UI, which reads exactly like
   *  "my switch reverted" even though nothing crashed or errored. Wrapping the manual switch in
   *  this same queue means a concurrent auto-swap request now waits for the manual switch to
   *  fully settle before it even re-checks "is the model I want already running" — so it either
   *  fast-path no-ops (the manual switch happened to satisfy it) or proceeds cleanly AFTER,
   *  never mid-flight. */
  async withSwapLock<T>(fn: () => Promise<T>): Promise<T> {
    let unlock!: () => void
    const prev = this.swapChain
    this.swapChain = new Promise<void>(r => { unlock = r })
    try {
      await prev
      return await fn()
    } finally {
      unlock()
    }
  }

  /** Stop the extra pool slot named by `modelKey`, if one exists — the symmetric counterpart
   *  to `loadExplicit`'s "an embedding model gets its own slot" rule (needsNewSlot above).
   *  Returns false when `modelKey` doesn't name a live extra slot (including when it names
   *  the PRIMARY manager's own model), so the caller knows to fall back to stopping the
   *  primary — this method never touches it. Engine-lifecycle.ts's stopEngine() uses this so
   *  ejecting a specific model (e.g. an embedding model loaded alongside a chat model) stops
   *  THAT engine only, not whatever happens to be in the primary slot. */
  stopExplicit(modelKey: string): boolean {
    // A Laya load still in flight comes first: its engine may not have spawned yet, so stopping the manager is not
    // enough on its own — the load is marked cancelled, and doLoad stops whatever it then brings up. The entry stays,
    // reported as 'stopping', until doLoad settles it, so nothing else touches an engine that is still going away.
    const loading = this.layaLoads.get(modelKey)
    if (loading) {
      loading.cancelled = true
      loading.manager.stop()
      return true
    }
    const slot = this.extraSlots.get(modelKey)
    if (!slot) return false
    slot.manager.stop()
    this.dropSlot(modelKey)
    return true
  }

  /** Drop the pool slot `modelKey` from extraSlots, keeping its manager in stoppingSlots until its process has exited:
   *  an eject, its idle watchdog or an engine stop may still be stopping it. Every removal of a slot whose process may
   *  be alive goes through here, except evictChatLru's, whose manager the load takes over (loadingSlot). */
  private dropSlot(modelKey: string): void {
    const slot = this.extraSlots.get(modelKey)
    if (!slot) return
    this.extraSlots.delete(modelKey)
    // Pruned here too: pool reads are rare (an engine update or delete, a ComfyUI render), and ejects and idle
    // reloads alone must not keep every stopped manager for the daemon's lifetime.
    for (const m of this.stoppingSlots) if (!this.slotEngineId(m)) this.stoppingSlots.delete(m)
    if (this.slotEngineId(slot.manager)) this.stoppingSlots.add(slot.manager) // an exited one ('stopped', 'error') is not
  }

  /** Ids of the engines the extra pool slots run on (not the primary). A .litertlm model auto-swapped into a slot
   *  runs on LiteRT-LM whatever engine is active, so an engine can be in use without being active or primary. */
  poolEngineIds(): Set<string> {
    const ids = new Set<string>()
    for (const p of this.poolProcesses()) for (const id of p.engineIds) ids.add(id)
    return ids
  }

  /** How many extra pool slots run on `engineId` (read-only). A release update refuses to replace that engine's
   *  files while this is above zero, rather than stopping a model the user is using. */
  poolSlotsOnEngine(engineId: string): number {
    return this.poolProcesses().filter((p) => p.engineIds.has(engineId)).length
  }

  /** Stop and drop every extra pool slot running on `engineId`, resolving once they have exited — before that
   *  engine's files are replaced or it is unregistered. The primary is the caller's (stopEngineUsers).
   *  `force` kills at once, as ComfyUI's acquire does the primary: a render must not wait out the graceful stop
   *  (on Windows its full 8 s timer, which a windowless llama-server never cuts short). A slot already stopping (an
   *  eject, or its idle watchdog) is waited for, and with `force` killed now.
   *  A slot still loading is stopped now, whatever it still runs: the model it evicted (as LRU, still running while
   *  its load waits for the load gate, or being stopped), or the engine it is starting. A load that has not spawned
   *  its engine yet is not cancelled by this: for ComfyUI the hook refuses it and loadInto's gpuClaimed() check
   *  drops one that spawns anyway; an engine update/delete (stopEngineUsers) does not stop such a load. */
  async stopPoolSlotsOnEngine(engineId: string, opts?: { force?: boolean }): Promise<void> {
    const stopping: Promise<unknown>[] = []
    for (const p of this.poolProcesses()) {
      if (!p.engineIds.has(engineId)) continue
      if (p.slotKey !== undefined) this.dropSlot(p.slotKey)
      stopping.push(p.manager.stopAndWait(opts))
    }
    await Promise.all(stopping)
  }

  /** Every pool-slot manager whose engine process may be alive, with the engine ids it holds: the registered slots
   *  (`slotKey`), the ejected ones still exiting, and the slot a load runs in (see loadingSlot: on its new engine, and
   *  on its evicted model's while that model still runs or stops). */
  private poolProcesses(): Array<{ manager: Manager; engineIds: Set<string>; slotKey?: string }> {
    const engineIds = (manager: Manager, also?: string): Set<string> => {
      const ids = new Set<string>()
      const id = this.slotEngineId(manager)
      if (id) ids.add(id)
      if (also) ids.add(also)
      return ids
    }
    const out: Array<{ manager: Manager; engineIds: Set<string>; slotKey?: string }> = []
    for (const [key, slot] of this.extraSlots) out.push({ manager: slot.manager, engineIds: engineIds(slot.manager), slotKey: key })
    for (const manager of this.stoppingSlots) {
      const ids = engineIds(manager)
      if (ids.size) out.push({ manager, engineIds: ids })
      else this.stoppingSlots.delete(manager) // exited
    }
    const loading = this.loadingSlot
    if (loading) out.push({ manager: loading.manager, engineIds: engineIds(loading.manager, loading.engineId) })
    return out
  }

  /** The engine a pool-slot manager's process runs on, while there is one. currentOpts() names it while the model runs
   *  or starts; while it stops, currentOpts() is null but the process still holds its VRAM and its engine's files,
   *  and restartOpts() still names the opts it was started with (Manager.load replaces them only once it has exited). */
  private slotEngineId(manager: Manager): string | undefined {
    return (manager.currentOpts() ?? (manager.status().state === 'stopping' ? manager.restartOpts() : null))?.engine.id
  }

  /** A manual switch (routes.ts) always loads directly into the PRIMARY manager, never an
   *  extra pool slot — so unlike `doLoad()`'s own bookkeeping, only `primaryLastUsed` needs
   *  updating on success. Without this, a manual switch left the router's own LRU timestamp
   *  stale, which could bias `evictChatLru()`'s choice on a later auto-swap. */
  markPrimaryLoaded(): void {
    this.primaryLastUsed = Date.now()
  }

  /** Every model key currently loaded (or loading) across the WHOLE pool — the primary
   *  manager plus every alive extra slot (F-033). "Alive" = running OR starting, matching
   *  the delete-guard's notion of "loaded" (routes.ts), so a model loaded via gateway
   *  auto-swap into an extra slot is reported as loaded even though it isn't in the
   *  primary manager. Used by overlayModel to mark gateway-loaded models loaded on the
   *  Models page (they were previously invisible — only the primary manager was consulted). */
  loadedModelKeys(): Set<string> {
    const isAlive = (s: string) => s === 'running' || s === 'starting'
    const keys = new Set<string>()
    const add = (key: string) => {
      keys.add(key)
      // Also index by on-disk path so overlayModel can match a model by either its key
      // or its path (mirrors keysMatch, which the delete-guard / route paths use).
      const path = this.scanner.get(key)?.path
      if (path) keys.add(path)
    }
    const ms = this.manager.status()
    if (isAlive(ms.state) && ms.model) add(ms.model.key)
    for (const slot of this.extraSlots.values()) {
      if (isAlive(slot.manager.status().state)) add(slot.modelKey)
    }
    for (const load of this.layaLoads.values()) add(load.modelKey)
    // A load in flight: the model it loads, for the whole load (a pool slot is registered only once it has loaded),
    // and the LRU model its pool slot still runs while that load waits for the load gate (evictChatLru dropped it).
    if (this.loadingKey) add(this.loadingKey)
    const loading = this.loadingSlot?.manager.status()
    if (loading && isAlive(loading.state) && loading.model) add(loading.model.key)
    return keys
  }

  // ── internal ──────────────────────────────────────────────────────────────

  /** The fast paths shared by route() and routeTo(): `entry` already running in the primary or in
   *  a pool slot → its target. undefined = not alive (a dead pool slot is cleaned up on the way). */
  private routeResolved(entry: ModelEntry): RouteResult | undefined {
    // Fast path: correct model already running in the primary manager.
    {
      const ms = this.manager.status()
      if (ms.state === 'running' && ms.model && this.keysMatch(ms.model.key, entry)) {
        this.primaryLastUsed = Date.now()
        this.manager.touch()
        return { target: this.manager.target()! }
      }
    }

    // Fast path: already running in a pool slot.
    const slot = this.extraSlots.get(entry.key)
    if (slot) {
      const ss = slot.manager.status()
      if (ss.state === 'running') {
        slot.lastUsedMs = Date.now()
        slot.manager.touch()
        return this.served(slot.manager, slot.manager.target()!)
      }
      this.dropSlot(entry.key) // dead or stopping slot (its idle watchdog) — clean up
    }
    return undefined
  }

  /** The answer to a caller whose credential may not load models (auth.ts modelLoadsRefused) when `entry` is not
   *  running: the same "not loaded" refusal the Turbo Link façade gives a peer without models:load. It is permanent
   *  for this caller only when nothing under way brings the model up. A model that is loading, or the one ComfyUI's
   *  guard loads when the render ends (a load the render paused, else the model it unloaded), is served to this caller
   *  once it runs, so its client may retry. */
  private notLoadedForCaller(entry: ModelEntry): RouteResult {
    const ms = this.manager.status()
    if ((ms.state === 'starting' && ms.model && this.keysMatch(ms.model.key, entry)) || this.loadingKey === entry.key) {
      return { status: 503, message: `'${entry.name}' is still loading. Try again shortly.` }
    }
    const comfyLoads = this.comfy?.modelKeyLoadedOnRelease() ?? null
    if (comfyLoads && this.keysMatch(comfyLoads, entry)) {
      return { status: 503, message: `ComfyUI is rendering — '${entry.name}' is loaded when its queue finishes.` }
    }
    return { status: 503, message: `'${entry.name}' is not loaded, and this access token may not load models.`, permanent: true }
  }

  private async doLoad(entry: ModelEntry, overrides?: Partial<LoadProfile>): Promise<RouteResult> {
    // Re-check after acquiring the lock — another queued request may have already
    // loaded this model while we were waiting.
    {
      const ms = this.manager.status()
      if (ms.state === 'running' && ms.model && this.keysMatch(ms.model.key, entry)) {
        this.primaryLastUsed = Date.now()
        this.manager.touch()
        return { target: this.manager.target()! }
      }
      const slot = this.extraSlots.get(entry.key)
      if (slot && slot.manager.status().state === 'running') {
        slot.lastUsedMs = Date.now()
        slot.manager.touch()
        return this.served(slot.manager, slot.manager.target()!)
      }
    }

    if (this.comfy?.isBlocked()) {
      return { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }
    }

    const engine = engineForModel(this.registry, entry)
    if (!engine) return { status: 503, message: 'No active engine. Set one up in TurboLLM.' }
    const inc = modelIncompatibility(engine.kind, entry)
    // Stays so until the owner installs or switches to an engine that runs it; a retry only delays the message.
    if (inc) return { status: 503, message: inc.message, permanent: true }

    const opts = this.buildOpts(entry, engine, overrides)
    if (!opts) return { status: 503, message: 'Model is incomplete or unreadable.' }

    const keepN = Math.max(1, this.store.snapshot().gateway.keepN)
    // Side models (embedding, Laya) don't consume a chat slot — they get their own implicit slot
    // so a loaded chat model is never evicted just because a side model is requested.
    const needsNewSlot = isSideModel(entry) || this.chatSlotCount() < keepN
    // A Laya model never takes the primary, even an empty one: the chat screen shows and talks to whatever the
    // primary holds, and a Laya engine answers only /v1/systemone.
    const targetManager = entry.laya
      ? this.newSlotManager()
      : needsNewSlot
        ? (this.manager.status().state === 'stopped' || this.manager.status().state === 'error'
            ? this.manager
            : this.newSlotManager())
        : this.evictChatLru()

    // A Laya load takes 10-20 s, and /status must say it is loading for all of it: it is tracked while it is in
    // flight. A pool slot itself is registered only once its load has succeeded, as it always was — registering it
    // earlier lets a request land on a manager that is still waiting on the load gate or stopping its old model.
    const inFlight = entry.laya ? this.trackLayaLoad(entry.key, targetManager) : undefined
    this.loadingKey = entry.key
    this.loadingSlot = targetManager === this.manager ? undefined : { manager: targetManager, engineId: opts.engine.id }
    try {
      return await this.loadInto(entry, engine, opts, targetManager, inFlight)
    } finally {
      this.loadingKey = undefined
      this.loadingSlot = undefined
      if (inFlight && this.layaLoads.get(entry.key) === inFlight) this.layaLoads.delete(entry.key)
    }
  }

  /** The load itself, and what follows it. A Laya load (`inFlight`) stays tracked until this returns, so a cancelled
   *  load is still reported (as 'stopping') while its engine is being stopped. */
  private async loadInto(
    entry: ModelEntry,
    engine: Engine,
    opts: StartOpts,
    targetManager: Manager,
    inFlight: LayaLoad | undefined,
  ): Promise<RouteResult> {
    // Single chokepoint (rule 3): load() stops whatever this slot held, runs the
    // reverse gate (free ComfyUI VRAM), spawns, and waits for readiness — all under
    // the global load lock, so concurrent swaps can't spin up two engines at once.
    let comfyRefused = false
    try {
      await targetManager.load(opts, {
        beforeStart: async () => {
          // Ejected while it waited for the gate: never spawn an engine for it.
          if (inFlight?.cancelled) throw new Error(UNLOADED_WHILE_LOADING)
          try {
            await (this.comfy?.freeComfyUIBeforeLoad() ?? Promise.resolve())
          } catch (e) {
            comfyRefused = true
            throw e
          }
        },
      })
    } catch (e) {
      if (inFlight?.cancelled) {
        await this.stopCancelled(targetManager)
        return { status: 503, message: UNLOADED_WHILE_LOADING, permanent: true }
      }
      // The hook throws only when a ComfyUI render started while this load waited (for the gate or for /free):
      // the same condition as doLoad's isBlocked() refusal, which clears by itself, so the client may retry.
      if (comfyRefused) {
        return { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }
      }
      return { status: 503, message: `Engine start failed: ${(e as Error).message}`, permanent: true }
    }

    // Ejected while it loaded (stopExplicit): an engine that came up after the eject is stopped again, and waited for,
    // so nothing is left running that the router no longer tracks and a load queued behind this one never overlaps it.
    if (inFlight?.cancelled) {
      await this.stopCancelled(targetManager)
      return { status: 503, message: UNLOADED_WHILE_LOADING, permanent: true }
    }

    // ComfyUI acquired the GPU while this pool slot loaded: its pool stopper killed the load, or the engine came up
    // anyway (an acquire landing between the pre-start hook and the spawn). Either way nothing may serve during the
    // render, so it is stopped and not registered, and like doLoad's isBlocked() refusal the client may retry.
    if (targetManager !== this.manager && this.comfy?.gpuClaimed()) {
      await targetManager.stopAndWait({ force: true })
      return { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }
    }

    const s = targetManager.status()
    if (s.state !== 'running') {
      // The primary's load, when ComfyUI's acquire killed it: acquire force-stops a starting primary itself and keeps
      // its model for release() to reload, so it is stopped, not failed, and like the pool slot above the client may
      // retry. A load that failed on its own leaves the engine in 'error' and stays permanent.
      if (s.state !== 'error' && this.comfy?.gpuClaimed()) {
        return { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }
      }
      return { status: 503, message: s.err?.message ?? 'Model failed to become ready.', permanent: true }
    }

    const target = targetManager.target()
    if (!target) return { status: 503, message: 'Model loaded but target URL unavailable.', permanent: true }

    if (targetManager === this.manager) {
      this.primaryLastUsed = Date.now()
    } else {
      // A slot still listed for this key (loadExplicit skips routeResolved's cleanup) is dead or still stopping.
      this.dropSlot(entry.key)
      this.extraSlots.set(entry.key, { manager: targetManager, modelKey: entry.key, lastUsedMs: Date.now() })
    }

    // A Laya model is never the model to resume at boot: the resume path loads on the active engine, which
    // refuses it, so recording it would leave the machine with no model at all after a restart.
    if (!entry.laya) this.store.update(x => { x.lastLoaded = { modelKey: entry.key, engineId: engine.id } })
    return targetManager === this.manager ? { target } : this.served(targetManager, target)
  }

  /** A route to a pool slot, described from that slot's own manager (see RouteResult). The primary's routes carry
   *  none of this: the gateway's fallback already reads the primary. */
  private served(manager: Manager, target: string): RouteResult {
    const opts = manager.currentOpts()
    return opts ? { target, engineKind: opts.engine.kind, modelPath: opts.modelPath, modelName: opts.model.name } : { target }
  }

  /** A slot counts as occupied while 'stopping' too, not just 'running'/'starting' —
   *  a manual swap (routes.ts's /api/v1/engine/start, going straight to the primary
   *  Manager, outside this router entirely) passes the primary through 'stopping' on
   *  its way to the new model. A concurrent gateway request landing in that window
   *  (e.g. a terminal-agent CLI's own request, racing a founder's manual model switch
   *  in the UI) used to read the narrower running/starting-only check as "no slot is
   *  occupied" and spin up a whole SECOND, independently-tracked Manager/llama-server
   *  process — invisible to the primary manager's own status() and never cleaned up,
   *  since nothing outside the router's own extraSlots map ever stops it. Found live:
   *  a founder-reported "it loaded 2 models" during a manual switch while a terminal
   *  session was open, confirmed via two concurrent llama-server.exe processes on
   *  8081/8082 where only 8081 was known to /api/v1/status.  */
  private isOccupied(state: string): state is AliveSlot['state'] {
    return state === 'running' || state === 'starting' || state === 'stopping'
  }

  /** Note a Laya load as in flight. It shows as a 'starting' slot and counts as loaded (aliveSlots,
   *  loadedModelKeys), and stopExplicit can cancel it, until doLoad settles it. */
  private trackLayaLoad(modelKey: string, manager: Manager): LayaLoad {
    // Whatever slot the router still holds for this key is dead or going away: doLoad found no running one under the
    // swap lock. Dropping it means the model is reported once, and an eject reaches the load and not a stale entry.
    this.dropSlot(modelKey)
    const load: LayaLoad = { manager, modelKey, startedMs: Date.now(), cancelled: false }
    this.layaLoads.set(modelKey, load)
    return load
  }

  /** Stop the engine of a cancelled load and wait until it is gone. Best effort: the load is over either way. */
  private async stopCancelled(manager: Manager): Promise<void> {
    try {
      await manager.stopAndWait()
    } catch {
      /* the engine may already be gone */
    }
  }

  private isSideModelKey(modelKey: string): boolean {
    const entry = this.scanner.get(modelKey)
    return entry !== undefined && isSideModel(entry)
  }

  /** Count of occupied chat (non-side-model) slots. Side models (embedding, Laya) don't consume
   *  a keepN slot so chat models and side models can coexist independently. */
  private chatSlotCount(): number {
    const ms = this.manager.status()
    const primaryAlive = this.isOccupied(ms.state)
    const primaryEmbed = primaryAlive && !!ms.model &&
      this.isSideModelKey(ms.model.key)
    const extraChat = [...this.extraSlots.values()].filter(
      s => this.isOccupied(s.manager.status().state) &&
        !this.isSideModelKey(s.modelKey),
    ).length
    return (primaryAlive && !primaryEmbed ? 1 : 0) + extraChat
  }

  /** Evict the least-recently-used occupied chat (non-embedding) slot. Embedding
   *  slots are skipped; if every occupied slot is an embedding model the true LRU is
   *  used as a fallback so we never deadlock. */
  private evictChatLru(): Manager {
    const ms = this.manager.status()
    const primaryAlive = this.isOccupied(ms.state)
    const primaryEmbed = primaryAlive && !!ms.model &&
      this.isSideModelKey(ms.model.key)

    let lruManager: Manager = this.manager
    let lruTime = (primaryAlive && !primaryEmbed) ? this.primaryLastUsed : Infinity
    let lruKey: string | null = null

    for (const slot of this.extraSlots.values()) {
      const slotEmbed = this.isSideModelKey(slot.modelKey)
      if (this.isOccupied(slot.manager.status().state) && !slotEmbed && slot.lastUsedMs < lruTime) {
        lruTime = slot.lastUsedMs
        lruManager = slot.manager
        lruKey = slot.modelKey
      }
    }

    // Fallback: all alive slots are embedding models — evict true LRU.
    if (lruTime === Infinity) {
      lruTime = primaryAlive ? this.primaryLastUsed : Infinity
      lruManager = this.manager
      lruKey = null
      for (const slot of this.extraSlots.values()) {
        if (this.isOccupied(slot.manager.status().state) && slot.lastUsedMs < lruTime) {
          lruTime = slot.lastUsedMs
          lruManager = slot.manager
          lruKey = slot.modelKey
        }
      }
    }

    if (lruKey !== null) this.extraSlots.delete(lruKey) // not dropSlot: the load takes this manager over (loadingSlot)
    return lruManager
  }

  /** PUBLIC view of `resolveRemote` — "does this id name a linked machine, and if so what
   *  is the outcome?" — with no local resolution, no auto-swap and no side effects.
   *
   *  Exists so every other surface that must treat a qualified id as remote reuses THIS
   *  resolution instead of growing its own. Two already do:
   *   - in-app chat (chat/chat-upstream.ts), which must not hand a qualified id to the
   *     LOCAL engine loader; and
   *   - the host façade's chaining refusal (link/link-routes.ts), which has to recognise a
   *     second-hop id before its wake gate answers with a misleading reason.
   *  Three findings in this feature came from two implementations of one idea drifting
   *  apart, so this is deliberately one function with two callers rather than three
   *  copies of `parseRemoteId` + `linkByName`.
   *
   *  `undefined` means "not remote" — including the real case of a LOCAL model key that
   *  happens to contain a slash (`unsloth/Qwen3-GGUF`), which must keep resolving locally. */
  resolveRemoteTarget(requestedModel: string): RouteResult | undefined {
    return this.resolveRemote(requestedModel)
  }

  /** Resolve a qualified id, or return undefined to let local resolution proceed.
   *
   *  Returns undefined ONLY when the id does not name a known linked machine — which
   *  covers the real case of a LOCAL model key that happens to contain a slash
   *  (`unsloth/Qwen3-GGUF`). Once the machine matches, every outcome is terminal. */
  private resolveRemote(requestedModel: string): RouteResult | undefined {
    if (!this.catalog) return undefined
    const parsed = parseRemoteId(requestedModel.trim())
    if (!parsed) return undefined
    const link = this.catalog.linkByName(parsed.machine)
    if (!link) return undefined

    if (link.status !== 'online') {
      return {
        status: 503,
        message:
          `'${parsed.machine}' is not connected (${link.status}). ` +
          `Reconnect it in Settings → Turbo Link.`,
        // 'unknown' (not probed yet) and 'unreachable' can come back on the next probe; a revoked or incompatible
        // link stays down until someone re-pairs or updates it.
        ...(link.status === 'revoked' || link.status === 'incompatible' ? { permanent: true as const } : {}),
      }
    }
    const model = this.catalog.modelOn(link.id, parsed.model)
    if (!model) {
      return { status: 503, message: `'${parsed.machine}' does not have a model '${parsed.model}'.` }
    }
    // A caller that may not load models (auth.ts modelLoadsRefused) gets a linked machine's model only while it is
    // already loaded there, as it does locally. The request goes out with THIS daemon's link token, so a link granted
    // models:load would otherwise have the host swap models for a caller this machine never let load one. `loaded` is
    // what the host reported on the last catalog refresh (true while its engine runs or starts the model), so this
    // refuses early and covers a host too old to read the marker below. The host itself decides on its live state:
    // `noLoad` puts the marker on the request (link-proxy.ts linkHeaders) and on every later request built from this
    // target, such as the tool rounds of an in-app chat turn.
    const noLoad = modelLoadsRefused()
    if (!model.loaded && noLoad) {
      return {
        status: 503,
        message: `'${parsed.machine}/${model.key}' is not loaded, and this access token may not load models.`,
        permanent: true,
      }
    }
    return {
      target: link.baseUrl,
      remote: {
        linkId: link.id, baseUrl: link.baseUrl, token: link.token, modelKey: model.key,
        ...(noLoad ? { noLoad: true as const } : {}),
      },
    }
  }

  private resolveEntry(requested: string): ModelEntry | undefined {
    const models = this.scanner.list().models
    // Exact key, then exact name, then case-insensitive name, then partial name.
    return (
      models.find(e => e.key === requested) ??
      models.find(e => e.name === requested) ??
      models.find(e => e.name.toLowerCase() === requested.toLowerCase()) ??
      models.find(e => e.name.toLowerCase().includes(requested.toLowerCase()))
    )
  }

  private keysMatch(loadedKey: string, entry: ModelEntry): boolean {
    return loadedKey === entry.key || loadedKey === entry.path
  }

  /** The scanned entry of the model running in the primary — what route()'s fallback answers from. */
  private primaryEntry(): ModelEntry | undefined {
    const ms = this.manager.status()
    if (ms.state !== 'running' || !ms.model) return undefined
    const loadedKey = ms.model.key
    return this.scanner.list().models.find(e => this.keysMatch(loadedKey, e))
  }

  /** Gateway loads build their StartOpts through the one shared builder (start-opts.ts), like the
   *  manual Load and the boot resume, so a Jev model's launch flags and a pinned port reach
   *  auto-swap loads too. doLoad has already checked compatibility, buildStartOpts's precondition. */
  private buildOpts(entry: ModelEntry, engine: Engine, overrides?: Partial<LoadProfile>): StartOpts | null {
    if (entry.incomplete || entry.parseError) return null
    return buildStartOpts({
      entry, engine, cfg: this.store.snapshot(), sys: getSysInfo(), overrides, trigger: 'gateway_switch',
    })
  }

}

/** A model that runs beside the chat model instead of in a chat slot: an embedding model (ADR-389) or a Laya
 *  decision model. */
function isSideModel(entry: Pick<ModelEntry, 'embedding' | 'laya'>): boolean {
  return entry.embedding || entry.laya !== undefined
}
