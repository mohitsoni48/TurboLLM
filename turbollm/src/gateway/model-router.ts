// Gateway intelligence (v0.6.0): auto model-swap and keep-N pool.
// When a /v1/* request includes a `model` field, the router resolves it against
// the local model library and loads (or swaps to) that model automatically.
// Inspired by llama-swap; operates on the existing Manager + Scanner primitives.
import { Manager, type StartOpts } from '../engines/manager'
import { getModelProfile, type ConfigStore, type Engine } from '../config/config'
import type { Registry } from '../engines/registry'
import type { Scanner, ModelEntry } from '../models/scanner'
import type { ComfyGuard } from '../engines/comfy-guard'
import { resolveProfile, profileToArgs, vllmProfileToArgs, type LoadProfile } from '../models/profile'
import { mlxSamplingArgs } from '../engines/mlx'
import { koboldcppProfileToArgs } from '../engines/koboldcpp'
import { engineAcceptsFormat } from '../engines/compat'
import { getSysInfo } from '../sysinfo/sysinfo'

export type RouteResult = { target: string } | { status: 503; message: string }

interface PoolSlot {
  manager: Manager
  modelKey: string
  lastUsedMs: number
}

/** Auto-swap gateway: resolves the `model` field in API requests and loads the
 *  requested model when it isn't already running. Supports a keep-N pool so
 *  frequently-used models can stay loaded simultaneously (VRAM permitting). */
export class ModelRouter {
  /** Extra pool slots beyond the primary manager. Only populated when keepN > 1. */
  private extraSlots = new Map<string, PoolSlot>()
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
  ) {}

  /** Route a request to the correct model target URL.
   *  - If autoSwap is off: returns whatever the primary manager has loaded.
   *  - If the requested model is already loaded: returns its target immediately.
   *  - Otherwise: loads the model (swapping / evicting LRU as needed) and waits. */
  async route(requestedModel: string): Promise<RouteResult> {
    const cfg = this.store.snapshot()

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
        return { target: slot.manager.target()! }
      }
      this.extraSlots.delete(entry.key) // dead slot — clean up
    }

    // Need to load / swap. Serialise so concurrent requests for different models
    // queue rather than racing to start/stop the same engine simultaneously.
    let unlock!: () => void
    const prev = this.swapChain
    this.swapChain = new Promise<void>(r => { unlock = r })
    try {
      await prev
      return await this.doLoad(entry)
    } finally {
      unlock()
    }
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
    return keys
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private async doLoad(entry: ModelEntry): Promise<RouteResult> {
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
        return { target: slot.manager.target()! }
      }
    }

    if (this.comfy?.isBlocked()) {
      return { status: 503, message: 'ComfyUI is rendering — model swap paused until its queue finishes.' }
    }

    const active = this.registry.active()
    if (!active) return { status: 503, message: 'No active engine. Set one up in TurboLLM.' }
    if (!engineAcceptsFormat(active.kind, entry.format)) {
      return { status: 503, message: `Active engine cannot load model format '${entry.format}'.` }
    }

    const opts = this.buildOpts(entry, active)
    if (!opts) return { status: 503, message: 'Model is incomplete or unreadable.' }

    const keepN = Math.max(1, this.store.snapshot().gateway.keepN)
    // Embedding models don't consume a chat slot — they get their own implicit slot
    // so a loaded chat model is never evicted just because an embed model is requested.
    const needsNewSlot = entry.embedding || this.chatSlotCount() < keepN
    const targetManager = needsNewSlot
      ? (this.manager.status().state === 'stopped' || this.manager.status().state === 'error'
          ? this.manager
          : new Manager(this.store))
      : this.evictChatLru()

    // Single chokepoint (rule 3): load() stops whatever this slot held, runs the
    // reverse gate (free ComfyUI VRAM), spawns, and waits for readiness — all under
    // the global load lock, so concurrent swaps can't spin up two engines at once.
    try {
      await targetManager.load(opts, {
        beforeStart: () => this.comfy?.freeComfyUIBeforeLoad() ?? Promise.resolve(),
      })
    } catch (e) {
      return { status: 503, message: `Engine start failed: ${(e as Error).message}` }
    }

    const s = targetManager.status()
    if (s.state !== 'running') {
      return { status: 503, message: s.err?.message ?? 'Model failed to become ready.' }
    }

    const target = targetManager.target()
    if (!target) return { status: 503, message: 'Model loaded but target URL unavailable.' }

    if (targetManager === this.manager) {
      this.primaryLastUsed = Date.now()
    } else {
      this.extraSlots.set(entry.key, { manager: targetManager, modelKey: entry.key, lastUsedMs: Date.now() })
    }

    this.store.update(x => { x.lastLoaded = { modelKey: entry.key, engineId: active.id } })
    return { target }
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
  private isOccupied(state: string): boolean {
    return state === 'running' || state === 'starting' || state === 'stopping'
  }

  /** Count of occupied chat (non-embedding) slots. Embedding models don't consume
   *  a keepN slot so chat models and embedding models can coexist independently. */
  private chatSlotCount(): number {
    const ms = this.manager.status()
    const primaryAlive = this.isOccupied(ms.state)
    const primaryEmbed = primaryAlive && !!ms.model &&
      (this.scanner.get(ms.model.key)?.embedding ?? false)
    const extraChat = [...this.extraSlots.values()].filter(
      s => this.isOccupied(s.manager.status().state) &&
        !(this.scanner.get(s.modelKey)?.embedding ?? false),
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
      (this.scanner.get(ms.model.key)?.embedding ?? false)

    let lruManager: Manager = this.manager
    let lruTime = (primaryAlive && !primaryEmbed) ? this.primaryLastUsed : Infinity
    let lruKey: string | null = null

    for (const slot of this.extraSlots.values()) {
      const slotEmbed = this.scanner.get(slot.modelKey)?.embedding ?? false
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

    if (lruKey !== null) this.extraSlots.delete(lruKey)
    return lruManager
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

  private buildOpts(entry: ModelEntry, engine: Engine): StartOpts | null {
    if (entry.incomplete || entry.parseError) return null
    const cfg = this.store.snapshot()
    const sys = getSysInfo()
    if (entry.format !== 'gguf') {
      const savedProfile = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
      return {
        engine,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: entry.vision },
        modelPath: entry.path,
        // MLX honors sampling as launch defaults; vLLM honors its own load controls (F-027).
        extraArgs:
          engine.kind === 'mlx'
            ? mlxSamplingArgs(savedProfile?.sampling)
            : engine.kind === 'vllm'
              ? vllmProfileToArgs(resolveProfile(entry, sys, savedProfile, undefined, cfg.modelDefaults), entry.nativeCtx)
              : [],
        tensorParallelSize: savedProfile?.gpu?.tensorParallelSize,
      }
    }
    const saved = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
    const profile = resolveProfile(entry, sys, saved, undefined, cfg.modelDefaults)
    // KoboldCpp is a GGUF engine but uses its OWN flag names, so it gets its own small
    // arg-map (ctx/ngl + GPU backend) rather than the llama-server profileToArgs. llamafile
    // IS llama.cpp's server under the hood, so it keeps the full profileToArgs flags — the
    // manager's llamafileServerCommand only prepends `--server --no-webui`.
    const extraArgs =
      engine.kind === 'koboldcpp'
        ? koboldcppProfileToArgs(profile, sys.gpus[0]?.vendor ?? 'unknown', sys.gpus.length > 0)
        : profileToArgs(profile, entry, engine.capabilities, sys.cores)
    return {
      engine,
      model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
      modelPath: entry.path,
      extraArgs,
    }
  }

}
