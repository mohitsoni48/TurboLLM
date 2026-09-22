// Engine lifecycle (spec 02 A2): the ONE implementation of "load a model" and "unload the
// model", extracted from routes.ts so that more than one transport can mount it.
//
// It has exactly two callers today: the local `/api/v1/engine/start` + `/api/v1/engine/stop`
// routes (routes.ts), and the Turbo Link façade's `/api/link/v1/models/load` + `/unload`
// (link/link-routes.ts). The façade mounts THESE functions behind `requireCapability` rather
// than reimplementing them, so eviction, the keep-N pool, the ComfyUI guard, the auto-tune
// kill switch and swap serialization behave identically whether the caller is the local UI or
// a linked peer. A second copy of this logic would drift — this project has already paid for
// that once (an admin `probe()` diverging from `LinkManager.probeOnce`).
import type { Context } from 'hono'
import { basename } from 'node:path'
import type { Deps } from '../deps'
import type { ModelInfo, StartOpts } from '../engines/manager'
import { abortAllInFlightChats } from '../chat/chat-routes'
import { modelIncompatibility } from '../engines/compat'
import { buildStartOpts } from '../engines/start-opts'
import type { LoadProfile } from '../models/profile'
import { getSysInfo } from '../sysinfo/sysinfo'

type Status = 200 | 202 | 400 | 409 | 500

function err(c: Context, status: Status, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

/** What `POST /api/v1/engine/start` accepts.
 *
 *  `modelPath` / `extraArgs` / `modelName` are the transitional pre-A4 fallback and are
 *  LOCAL-ONLY in practice: they name a filesystem path and extra process arguments, which is
 *  precisely what ADR-139 says no remote caller may supply. The Turbo Link façade therefore
 *  constructs this object itself with `modelKey` alone — it never forwards a peer's body. */
export interface EngineStartBody {
  modelKey?: string
  profileOverrides?: Partial<LoadProfile>
  modelPath?: string
  extraArgs?: string[]
  modelName?: string
}

/** Start (or swap to) a model. Fire-and-forget: returns 202 as soon as the load is queued —
 *  the caller polls `/status` for the starting→running/error transition. */
export async function startEngine(c: Context, d: Deps, b: EngineStartBody): Promise<Response> {
  const active = d.registry.active()
  if (!active) return err(c, 409, 'no_active_engine', 'Register and select an engine first.')
  // ComfyUI guard: while ComfyUI is rendering it owns the GPU, so refuse to load a
  // model (it would thrash/OOM VRAM). The guard reloads automatically once idle.
  if (d.comfy?.isBlocked()) return err(c, 409, 'comfyui_busy', 'ComfyUI is rendering — model loading is paused until its queue finishes.')
  const cfg = d.store.snapshot()
  const sys = getSysInfo()

  // Preferred (A4): start by modelKey with a resolved LoadProfile. An empty
  // request (the Engines "Start" button) re-loads the last model.
  let key = b.modelKey ?? ''
  if (!key && !b.modelPath && cfg.lastLoaded.modelKey) key = cfg.lastLoaded.modelKey
  const entry = key ? d.scanner.get(key) : undefined

  if (entry) {
    if (entry.incomplete || entry.parseError) {
      return err(c, 409, 'model_not_loadable', 'This model is incomplete or unreadable.')
    }
    // Engine and model must be compatible (spec 03 §2b/2c, ADR-434 (g)): format, audio
    // tower, and a Jev model's vLLM requirement — the one shared rule in compat.ts.
    const inc = modelIncompatibility(active.kind, entry)
    if (inc) return err(c, 409, 'engine_model_mismatch', inc.message)

    // Embedding models get their own pool slot via the router (same coexistence rule
    // the auto-swap gateway path already uses — model-router.ts's `chatSlotCount`/
    // `evictChatLru`) instead of replacing whatever's in the primary manager. Without
    // this, clicking "Load" on an embedding model in the UI killed a running chat
    // model's engine even though the two are meant to run side by side for RAG.
    // Skips the kill switch below too: that exists to stop in-flight chats/auto-tune
    // against an engine that's "going away" (chat-routes.ts's abortAllInFlightChats
    // docblock) — the primary engine isn't going away here, so nothing needs aborting.
    if (entry.embedding) {
      void d.modelRouter
        .loadExplicit(entry.key, b.profileOverrides)
        .catch((e) => console.warn(`engine load failed: ${e}`))
      return c.json({ ok: true }, 202)
    }

    // Kill switch: loading a model takes over the primary engine — cancel any auto-tune
    // and abort in-flight chats, then wait for auto-tune to release the engine so the
    // load can't race the runner's teardown.
    d.bench.cancel()
    abortAllInFlightChats()
    await d.bench.waitIdle()

    const opts = buildStartOpts({ entry, engine: active, cfg, sys, overrides: b.profileOverrides, trigger: 'manual' })
    // Single chokepoint (rule 3): load() stops the current model, runs the reverse
    // gate (F-011: ask ComfyUI to free VRAM first), spawns, and waits for readiness —
    // all under the global load lock so this can't race another load. Fire-and-forget:
    // the UI polls /status for the starting→running/error transition, so we return 202
    // immediately rather than blocking the HTTP request on a multi-second load.
    //
    // Wrapped in the router's own swap-serialization queue (same one route()/doLoad() use)
    // so a concurrent auto-swap request (e.g. a terminal-agent session's own gateway
    // traffic) can't independently decide "the primary is occupied mid-switch, evict it and
    // load MY model instead" — it now waits for this manual switch to fully settle first.
    // Without this, the two paths only shared the lower-level Manager.runExclusive gate,
    // which prevents a double-SPAWN but not a second caller silently overriding which model
    // ends up loaded — the model-router.ts withSwapLock doc comment has the full trace.
    void d.modelRouter
      .withSwapLock(() => d.manager.load(opts, { beforeStart: () => d.comfy?.freeComfyUIBeforeLoad() ?? Promise.resolve() }))
      .then(() => d.modelRouter.markPrimaryLoaded())
      .catch((e) => console.warn(`engine load failed: ${e}`))
    d.store.update((x) => {
      x.lastLoaded = { modelKey: entry.key, engineId: active.id }
    })
    return c.json({ ok: true }, 202)
  }

  // Transitional fallback: explicit path or migrated devModel (pre-A4 configs).
  let modelPath = b.modelPath ?? ''
  let extra = b.extraArgs ?? []
  let name = b.modelName ?? ''
  if (!modelPath && cfg.devModel) {
    modelPath = cfg.devModel.modelPath
    extra = cfg.devModel.extraArgs
    name = cfg.devModel.label
  }
  if (!modelPath) return err(c, 409, 'no_such_model', 'No model specified. Pick one from the Models screen.')
  // This legacy path always targets the primary manager directly (no scanner entry to
  // read `.embedding` off), so the kill switch still applies here.
  d.bench.cancel()
  abortAllInFlightChats()
  await d.bench.waitIdle()
  const opts: StartOpts = { engine: active, model: deriveModel(modelPath, name, extra), modelPath, extraArgs: extra }
  // Same single-chokepoint, fire-and-forget, swap-lock-coordinated load as the
  // resolved-model branch above.
  void d.modelRouter
    .withSwapLock(() => d.manager.load(opts, { beforeStart: () => d.comfy?.freeComfyUIBeforeLoad() ?? Promise.resolve() }))
    .then(() => d.modelRouter.markPrimaryLoaded())
    .catch((e) => console.warn(`engine load failed: ${e}`))
  return c.json({ ok: true }, 202)
}

/** What `POST /api/v1/engine/stop` accepts. `modelKey` is optional and BACKWARD
 *  COMPATIBLE: every existing caller (the topbar Eject, `/api/v1/engine/restart`, the Turbo
 *  Link façade's `/unload`) still posts no body at all, which keeps stopping the primary
 *  manager exactly as before. */
export interface EngineStopBody {
  modelKey?: string
}

/** Whether `modelKey` names the primary manager's CURRENTLY loaded model — by key or by
 *  on-disk path, mirroring `ModelRouter.keysMatch`'s reason for accepting either: the
 *  primary manager reports a model by whichever spelling `startEngine` last loaded it
 *  under, so an exact-key-only check can miss a path-loaded model. */
function namesPrimaryModel(d: Deps, modelKey: string): boolean {
  const ms = d.manager.status()
  const primaryKey = ms.model?.key
  if (!primaryKey) return false
  return primaryKey === modelKey || d.scanner.get(primaryKey)?.path === modelKey
}

/** Unload a model. When `modelKey` names a model loaded into its own extra pool slot (an
 *  embedding model, ADR-389) that slot is stopped and nothing else is touched — the
 *  symmetric counterpart to `startEngine`'s `entry.embedding` branch above. When `modelKey`
 *  names the primary's own currently-loaded model (or no key is given at all — the Engines
 *  page's own "Stop" button and every legacy caller), this stops the PRIMARY manager,
 *  unchanged. Anything else — a key that names neither — is a safe no-op.
 *
 *  Before this, `stopEngine` took no model identity at all and always stopped the primary,
 *  so ejecting an embedding model loaded alongside a chat model actually killed the chat
 *  model instead. A first fix routed a non-matching key straight to "stop the primary" as
 *  its fallback, which reintroduced the same failure a different way: a stale key (a
 *  duplicate eject click landing after the slot already drained, or a load that hasn't
 *  finished populating its pool slot yet) would ALSO fall through and kill whatever the
 *  primary happened to be running — an unrelated model, still live. Only a key that
 *  genuinely names the primary's own model may stop it; every other non-matching key is a
 *  no-op, never a fallback. */
export function stopEngine(c: Context, d: Deps, b: EngineStopBody = {}): Response {
  if (b.modelKey) {
    if (d.modelRouter.stopExplicit(b.modelKey)) return c.json({ ok: true }, 202)
    if (!namesPrimaryModel(d, b.modelKey)) return c.json({ ok: true }, 202)
  }
  // Kill switch: stopping the PRIMARY engine cancels auto-tune and aborts in-flight chats
  // too — they all depend on the engine that's going away. Not run above: the primary
  // isn't going away when an extra slot was stopped, or nothing matched at all.
  d.bench.cancel()
  abortAllInFlightChats()
  d.manager.stop()
  return c.json({ ok: true }, 202)
}

function deriveModel(modelPath: string, name: string, extraArgs: string[]): ModelInfo {
  let ctx = 0
  for (let i = 0; i + 1 < extraArgs.length; i++) {
    if (extraArgs[i] === '-c' || extraArgs[i] === '--ctx-size') ctx = Number(extraArgs[i + 1]) || 0
  }
  return { key: modelPath, name: name || cleanModelName(modelPath), quant: '', ctx, vision: false }
}

function cleanModelName(p: string): string {
  return basename(p).replace(/\.gguf$/i, '')
}
