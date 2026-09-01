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
import { getModelProfile } from '../config/config'
import type { Deps } from '../deps'
import type { ModelInfo, StartOpts } from '../engines/manager'
import { abortAllInFlightChats } from '../chat/chat-routes'
import { engineAcceptsFormat, engineRejectsAudioModel } from '../engines/compat'
import { koboldcppProfileToArgs } from '../engines/koboldcpp'
import { mlxSamplingArgs } from '../engines/mlx'
import { type LoadProfile, profileToArgs, resolveProfile, vllmProfileToArgs } from '../models/profile'
import { getSysInfo, primaryVendor } from '../sysinfo/sysinfo'

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
    // Engine/model format must match (spec 03 §2b/2c): llama.cpp + forks load
    // GGUF; MLX and vLLM load safetensors model directories.
    if (!engineAcceptsFormat(active.kind, entry.format)) {
      return err(c, 409, 'engine_model_mismatch', formatMismatchMessage(active.kind, entry.format))
    }
    if (entry.audio && engineRejectsAudioModel(active.kind)) {
      const engineLabel = active.kind === 'mlx-vlm' ? 'MLX-VLM' : 'Rapid-MLX'
      // Rapid-MLX: confirmed live, reproduced end to end (see engineRejectsAudioModel's
      // docblock). MLX-VLM: same underlying mlx_vlm sanitizer bug, but excluded here
      // precautionarily from reading the source, not a fresh live reproduction — say so
      // rather than stating it as flatly settled. Either way, plain MLX (mlx-lm) never
      // attempts VLM/audio loading, so it's a safe fallback recommendation for both.
      const certainty = active.kind === 'mlx-vlm' ? 'is expected to fail' : 'fails'
      return err(
        c,
        409,
        'engine_model_mismatch',
        `${engineLabel} cannot load models with an audio tower — the audio encoder ${certainty} due to an upstream mlx-vlm bug in the sanitizer for these architectures. Switch to the MLX engine instead.`,
      )
    }

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

    let opts: StartOpts
    if (entry.format !== 'gguf') {
      // MLX / vLLM: the model dir is the launch target (no llama.cpp -ngl/ctx knobs).
      // MLX honors sampling defaults; vLLM honors its own load controls (F-027,
      // --max-model-len/--gpu-memory-utilization/--dtype/…) built via vllmProfileToArgs,
      // plus the multi-GPU shard count (ADR-054) mapped to --tensor-parallel-size below.
      const savedProfile = getModelProfile(cfg, entry.key, active.id) as Partial<LoadProfile> | undefined
      // Resolved once regardless of engine kind (mlx's own arg-building doesn't need
      // it, but `model_load` telemetry — spec 23 §3.3 — wants the same full-config
      // shape for every engine, not just vLLM).
      const profile = resolveProfile(entry, sys, savedProfile, b.profileOverrides, cfg.modelDefaults)
      const extraArgs =
        active.kind === 'mlx'
          ? mlxSamplingArgs(savedProfile?.sampling)
          : active.kind === 'vllm'
            ? vllmProfileToArgs(profile, entry.nativeCtx)
            : []
      opts = {
        engine: active,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: entry.vision },
        modelPath: entry.path,
        extraArgs,
        tensorParallelSize: savedProfile?.gpu?.tensorParallelSize,
        preferredPort: savedProfile?.port,
        profile,
        trigger: 'manual',
      }
    } else {
      const saved = getModelProfile(cfg, entry.key, active.id) as Partial<LoadProfile> | undefined
      const profile = resolveProfile(entry, sys, saved, b.profileOverrides, cfg.modelDefaults)
      // KoboldCpp is a GGUF engine with its OWN flag names — build its arg-map instead of
      // the llama-server profileToArgs. llamafile IS llama.cpp's server, so it keeps the
      // full profileToArgs flags (the manager only prepends --server --no-webui for it).
      const extraArgs =
        active.kind === 'koboldcpp'
          ? koboldcppProfileToArgs(profile, primaryVendor(sys), sys.gpus.length > 0)
          : profileToArgs(profile, entry, active.capabilities, sys.cores, sys, active.binPath)
      opts = {
        engine: active,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
        modelPath: entry.path,
        extraArgs,
        preferredPort: profile.port,
        profile,
        trigger: 'manual',
      }
    }
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

/** Unload whatever the primary manager is running. */
export function stopEngine(c: Context, d: Deps): Response {
  // Kill switch: stopping the engine cancels auto-tune and aborts in-flight chats too —
  // they all depend on the engine that's going away.
  d.bench.cancel()
  abortAllInFlightChats()
  d.manager.stop()
  return c.json({ ok: true }, 202)
}

/** User-facing message when the active engine can't load a model's format (ADR-044). */
function formatMismatchMessage(engineKind: string, format: 'gguf' | 'mlx'): string {
  if (engineKind === 'mlx')
    return 'The active engine is MLX — pick a safetensors model, or switch to a llama.cpp engine for GGUF.'
  if (engineKind === 'rapid-mlx')
    return 'The active engine is Rapid-MLX — pick a safetensors model, or switch to a llama.cpp engine for GGUF.'
  if (engineKind === 'mlx-vlm')
    return 'The active engine is MLX-VLM — pick a safetensors model, or switch to a llama.cpp engine for GGUF.'
  if (engineKind === 'vllm')
    return 'The active engine is vLLM — pick a safetensors / HF model, or switch to a llama.cpp engine for GGUF.'
  // llama.cpp / fork active, model is a safetensors dir.
  return format === 'mlx'
    ? 'This is a safetensors model — activate an MLX or vLLM engine to load it.'
    : 'The active engine can only load GGUF models.'
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
