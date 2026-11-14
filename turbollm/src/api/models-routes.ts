// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { getModelProfile, setModelProfile, deleteModelProfile, isModelHidden, setModelHidden, isUnsafeMapKey, ownEntry, type Config, type DeepReadonly } from '../config/config'
import type { Deps } from '../deps'
import type { ModelEntry as ModelEntryView, ModelsList } from '../contract/models'
import { engineForModel, type Registry } from '../engines/registry'
import { isLocalOrAuthenticated } from '../auth'
import { engineWithholdsVision, modelIncompatibility } from '../engines/compat'
import { ScannerError, type ModelEntry } from '../models/scanner'
import { automaticProfile, configuredCtx, estimateVram, legacySeedProfile, type LoadProfile, resolveProfile, userSetProfile } from '../models/profile'
import { getSysInfo } from '../sysinfo/sysinfo'
import { requestUsage } from '../sysinfo/usage'
import { inferRepoFromPath } from './path-utils'
import { validateLoadProfileFields, profilesEqual, launchFieldsRefusal, loadsWithNow, isUserSetOnly } from './profile-validate'
import { modelDeleteBlocked } from './delete-guards'
import { err, jsonBody, body } from './http'

/** The model library (list, rescan, delete, detail, profile, hidden) plus sysinfo and hwstats. */
export function registerModelRoutes(app: Hono, d: Deps): void {
  // ---- models (A3, spec 04) ----
  app.get('/api/v1/models', (c) => {
    const { models, scanning, lastScanAt } = d.scanner.list()
    const lastTps = d.db.lastGenTpsByModel()
    // One config snapshot (and one lookup per registry engine) for the whole list, not per row:
    // each is a structuredClone of the full config, which itself grows with the library
    // (profiles, presets, bench results are per model), and the UI polls this every few seconds.
    const shared = overlayShared(d)
    return c.json({ models: models.map((m) => overlayModel(m, d, lastTps, shared)), scanning, lastScanAt } satisfies ModelsList)
  })

  app.post('/api/v1/models/rescan', (c) => {
    void d.scanner.rescan()
    return c.json({ ok: true }, 202)
  })

  // Delete a model's file(s) from disk (spec 05). Split GGUFs delete all shards.
  // Blocked while the model is the one currently loaded in the running engine.
  // `c.req.param()` is already percent-decoded (see custom-sources/:key) — decoding again broke
  // every key containing '%' (a URIError 500, or a different key: '%41' → 'A').
  app.delete('/api/v1/models/:key', async (c) => {
    // Removes files from the host's disk for good (a whole MLX folder, every non-model file in it
    // included), so it is held to isLocalOrAuthenticated like the other host-side changes: a keyless
    // Serve identity, Access JWT or open-LAN peer could empty the owner's library. A remote token is
    // refused before this (requiredCapability, I3). api_key_required: the web client opens its key
    // prompt on it.
    if (!isLocalOrAuthenticated(c, d)) return err(c, 403, 'api_key_required', 'Deleting a model requires a valid API key.')
    const key = c.req.param('key')
    const e = d.scanner.get(key)
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    // Any slot, not just the primary: a Laya model always runs in its own (ADR-443).
    if (modelDeleteBlocked(d, e)) {
      return err(c, 409, 'model_loaded', 'This model is currently loaded. Eject it before deleting.')
    }
    try {
      const deleted = await d.scanner.delete(key)
      // A model hidden by hand that is gone drops its key (config.ts hiddenModels): a copy downloaded again later shows.
      // Not while another copy of the same file still holds the key.
      if (!d.scanner.get(key) && isModelHidden(d.store.snapshot(), key)) d.store.update((cfg) => setModelHidden(cfg, key, false))
      return c.json({ ok: true, deleted })
    } catch (e2) {
      if (e2 instanceof ScannerError) return err(c, e2.code === 'unsafe_model_delete' ? 409 : 404, e2.code, e2.message)
      return err(c, 500, 'delete_failed', (e2 as Error).message)
    }
  })

  app.get('/api/v1/models/:key', (c) => {
    const e = d.scanner.get(c.req.param('key'))
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    const sys = getSysInfo()
    const snap = d.store.snapshot()
    // Per-engine profile (issue #35): the detail dialog passes ?engine=<id> for the engine
    // it's showing; fall back to the active engine, then the '*' migrated/global profile.
    const engineId = c.req.query('engine') || d.registry.active()?.id || '*'
    const saved = getModelProfile(snap, e.key, engineId) as Partial<LoadProfile> | undefined
    const profile = resolveProfile(e, sys, saved, undefined, snap.modelDefaults)
    // What the dialog needs to save only what the user set (userSetProfile): the fields of the saved
    // profile that are the user's, and the profile the model loads with when nothing is set, which a
    // preset applied in the dialog is merged onto.
    const autoProfile = automaticProfile(e, sys, snap.modelDefaults)
    const seed = legacySeedProfile(e, sys, snap.modelDefaults, autoProfile)
    // `gpu` (first GPU) kept for back-compat; `gpus` (full list) drives the multi-GPU
    // split controls (ADR-054).
    return c.json({
      ...overlayModel(e, d), profile, saved: userSetProfile(saved, seed) ?? {}, autoProfile,
      vramFit: estimateVram(profile, e, sys), gpu: sys.gpus[0] ?? null, gpus: sys.gpus, cores: sys.cores,
    })
  })

  app.put('/api/v1/models/:key/profile', async (c) => {
    const key = c.req.param('key')
    const e = d.scanner.get(key)
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    // jsonBody, not body(): validateLoadProfileFields refuses a body that is not an object ('profile must be a JSON
    // object.'), which body() would hand over as {} and get the 'ctx' refusal for instead.
    const p = await jsonBody(c) as LoadProfile
    // Field validation lives in profile-validate.ts because the preset routes are a SECOND way
    // into the same storage and must reject exactly the same things (ADR-353) — a bad field here
    // reaches profileToArgs and the engine command line.
    // A profile of only what the user set (userSetOnly, the dialog's) may leave the context out, as it
    // leaves out every control the user did not move; any other must still carry one.
    const invalid = validateLoadProfileFields(p, { requireCtx: !isUserSetOnly(p) })
    if (invalid) return err(c, 400, 'invalid_profile_value', invalid)
    // Per-engine profile (issue #35): save into the slot for the engine the client is
    // editing (?engine=<id>), falling back to the active engine, then the '*' fallback.
    const engineId = c.req.query('engine') || d.registry.active()?.id || '*'
    if (isUnsafeMapKey(engineId)) return err(c, 400, 'invalid_profile_value', 'Invalid engine id.')
    // Flags and files of the caller's own need a key (launchFieldsRefusal); the dialog's Save and
    // "Remember these settings" send back what GET /models/:key showed for this engine.
    const launchRefused = launchFieldsRefusal(c, d, p, loadsWithNow(d, key, engineId))
    if (launchRefused) return launchRefused
    d.store.update((cfg) => {
      setModelProfile(cfg, key, engineId, p)
      // An explicit manual save that CHANGES something supersedes the pin: PUT writes
      // modelProfiles, but getModelProfile returns the pin first, so a stale pin makes the save
      // look like it did nothing. Two exceptions, both found in review:
      //  - A save identical to the pinned preset is not a divergence. "Remember these settings"
      //    is ON by default and fires exactly this save on the draft the preset just filled in —
      //    unpinning there silently broke "your pick is remembered and auto-applied next load".
      //    Identical in what the user set (userSetProfile): the dialog saves only that, so a preset
      //    an earlier build stored whole is the same pick as the dialog's save of it.
      //  - The pin is per-MODEL, this save is per-ENGINE. Clearing a pin belonging to a DIFFERENT
      //    engine drops that engine's tune for an edit unrelated to it (issue #35's contract).
      const pinnedId = ownEntry(cfg.lastPresetId, key)
      if (pinnedId) {
        const pinned = (ownEntry(cfg.modelPresets, key) ?? []).find((x) => x.id === pinnedId)
        const thisEngine = !pinned || pinned.engineId === '' || pinned.engineId === engineId
        const seed = legacySeedProfile(e, getSysInfo(), cfg.modelDefaults)
        const same = !!pinned && profilesEqual(userSetProfile(pinned.profile as Partial<LoadProfile>, seed), userSetProfile(p, seed))
        if (thisEngine && !same) delete cfg.lastPresetId[key]
      }
    })
    return c.json(p)
  })

  // Hide a model by hand, or unhide it (Models → Library): a flag the daemon keeps per model (config.ts hiddenModels), so
  // it holds on every page and device. The web UI leaves a hidden model out of the Library list and its model pickers;
  // nothing else changes. Held to what the profile PUT above is: a remote token needs models:load (auth.ts
  // requiredCapability gives this route and the profile PUT that capability), and anyone else who may change a model's
  // profile may hide it. Only a scanned model's key is stored, so the list cannot be filled with keys no library has.
  app.put('/api/v1/models/:key/hidden', async (c) => {
    const key = c.req.param('key')
    if (!d.scanner.get(key)) return err(c, 404, 'no_such_model', 'No model with that key.')
    const b = await body<{ hidden?: unknown }>(c)
    if (typeof b.hidden !== 'boolean') return err(c, 400, 'invalid_config_value', 'hidden must be true or false.')
    const hidden = b.hidden
    if (isModelHidden(d.store.snapshot(), key) !== hidden) d.store.update((cfg) => setModelHidden(cfg, key, hidden))
    return c.json({ key, hidden })
  })

  app.post('/api/v1/models/:key/profile/reset', (c) => {
    const key = c.req.param('key')
    // Same model-existence guard as PUT above. Without it the raw key reached the config maps:
    // `constructor`/`__proto__` resolved to Object/Object.prototype, and the delete below removed
    // a built-in (`?engine=entries` → Object.entries) for the whole process.
    if (!d.scanner.get(key)) return err(c, 404, 'no_such_model', 'No model with that key.')
    // Per-engine profile (issue #35): reset only the edited engine's slot (?engine=<id>),
    // falling back to the active engine, then the '*' fallback.
    const engineId = c.req.query('engine') || d.registry.active()?.id || '*'
    d.store.update((cfg) => {
      deleteModelProfile(cfg, key, engineId)
      // A reset must not leave a stale pin shadowing the result — but only for the engine being
      // reset. The pin is per-MODEL and this reset is per-ENGINE, so clearing a pin that belongs
      // to a different engine would drop that engine's tune for an unrelated action (issue #35).
      const pinnedId = ownEntry(cfg.lastPresetId, key)
      if (pinnedId) {
        const pinned = (ownEntry(cfg.modelPresets, key) ?? []).find((x) => x.id === pinnedId)
        if (!pinned || pinned.engineId === '' || pinned.engineId === engineId) delete cfg.lastPresetId[key]
      }
    })
    return c.json({ ok: true })
  })

  app.get('/api/v1/sysinfo', (c) => c.json(getSysInfo()))

  // Live CPU/RAM/GPU usage (ADR-383): the freshest sample from the self-stopping sampler.
  // Deliberately NOT folded into status-view.ts — the Turbo Link façade must stay untouched
  // (spec D2), and a peer polling /status must not start GPU counter streams on this box.
  app.get('/api/v1/hwstats', async (c) => c.json(await requestUsage()))
}

/** What {@link overlayModel} reads from the config and the registry, taken once per request by
 *  the list endpoint (every registry lookup is a config snapshot too). The registry lookups are
 *  lazy and memoized: most rows only need `active`. */
type OverlayShared = { snap: DeepReadonly<Config>; registry: Pick<Registry, 'active' | 'layaEngine'> }

function overlayShared(d: Deps): OverlayShared {
  const once = <T>(f: () => T): (() => T) => {
    let v: { r: T } | undefined
    return () => (v ??= { r: f() }).r
  }
  return {
    snap: d.store.read(),
    registry: {
      active: once(() => d.registry.active()),
      layaEngine: once(() => d.registry.layaEngine()),
    },
  }
}

/** Overlay the live-dynamic flags (loaded, hasProfile) and tiered t/s (lastTps,
 *  liveTps) onto a scanned entry (spec 04 §5). `lastTps` is the most-recent gen
 *  t/s recorded for this model; pass the precomputed map on the list endpoint to
 *  avoid one DB query per row. `liveTps` is best-effort: there is no full live
 *  session-stats accumulator yet (that's a separate B4 task), so we surface the
 *  loaded model's last recorded gen t/s as its live figure — non-null only while
 *  that model is the one currently loaded. */
function overlayModel(
  e: ModelEntry, d: Deps, lastTpsMap?: Map<string, number>,
  { snap, registry }: OverlayShared = { snap: d.store.read(), registry: d.registry },
): ModelEntryView {
  const ms = d.manager.status()
  const loadedKey = ms.state === 'running' ? ms.model?.key : undefined
  const profiles = snap.modelProfiles
  const loadedInPrimary = loadedKey === e.path || loadedKey === e.key
  // F-033: a model loaded via gateway auto-swap (keepN > 1) lives in a separate Manager
  // in the keep-N pool, invisible to the primary manager's status() above. Consult the
  // router's pool-wide loaded set too — matching by both key and path (mirroring the
  // router's keysMatch) — so gateway-loaded models show as loaded on the Models page.
  const poolKeys = d.modelRouter.loadedModelKeys()
  const loaded = loadedInPrimary || poolKeys.has(e.key) || poolKeys.has(e.path)
  const lastTps = (lastTpsMap ?? d.db.lastGenTpsByModel()).get(e.key) ?? null
  // Best-effort live: only when this model is loaded AND a recent gen t/s exists.
  const liveTps = loaded && lastTps !== null ? lastTps : null
  // Best local benchmark result (spec 09 §2): "N tok/s on your machine". Overlaid
  // from the persisted benchResults so it survives restart (the scanner seeds null).
  const benchTps = snap.benchResults[e.key]?.tps ?? null
  // Whether the *active* engine can load this model (ADR-044) — drives the model-
  // list filter so e.g. only GGUFs show under a llama.cpp engine, safetensors under
  // MLX/vLLM. No active engine → everything is shown (compatible: true).
  // `incompatibleReason` is the short row text for why not (e.g. "Needs vLLM (Linux or WSL2)").
  // A Laya model is checked against the Laya engine it loads on, not the active one (engineForModel).
  const engine = engineForModel(registry, e)
  const inc = engine ? modelIncompatibility(engine, e) : null
  const compatibleWithActiveEngine = !inc
  const incompatibleReason = inc?.label ?? null
  // Source HF repo: confirmed from download provenance, else inferred from the
  // on-disk layout (LM Studio / huggingface-cli store models as
  // <root>/<owner>/<repo>/<file>). Lets the library open the model's HF page —
  // card + other quants — even for files imported outside TurboLLM. An inferred
  // guess that's wrong simply 404s when opened; it never marks anything downloaded.
  const provRepo = d.downloads.provenance().find((p) => p.dest === e.path && p.repo)?.repo
  const sourceRepo = provRepo ?? inferRepoFromPath(e.path, snap.modelDirs)
  // Per-engine profiles (issue #35): profiles[e.key] is now an { engineId → profile } map;
  // "has a saved profile" for the model-list badge means it has at least one engine slot.
  const hasProfile = !!profiles[e.key] && Object.keys(profiles[e.key]).length > 0
  // The context window this model would ACTUALLY be loaded with, from its saved profile/preset for
  // the active engine — as opposed to `nativeCtx`, which is only the maximum its metadata allows.
  //
  // Exposed for the config-file coding harnesses (pi/opencode/kilo), whose model pickers can only
  // show what TurboLLM writes into their config. Without this they had to fall back to `nativeCtx`
  // for every model except the one currently loaded, so a 262144-native model configured at 163328
  // advertised the wrong window until it happened to be loaded. Undefined when the model has no
  // profile for this engine — the caller then falls back to nativeCtx, which is the honest answer.
  const configuredCtxNow = configuredCtx(snap, e, engine?.id ?? '', getSysInfo())
  // Hidden by hand (Models → Library "Hide", config.ts hiddenModels): the web UI leaves it out of its lists and pickers.
  const hidden = isModelHidden(snap, e.key)
  // An engine that reads no images (the in-app SDK engine, G-2) is not offered a model's vision; the scanned entry
  // keeps it, for when another engine is selected.
  const vision = e.vision && !engineWithholdsVision(engine?.kind ?? '')
  return {
    ...e, vision, loaded, hasProfile, configuredCtx: configuredCtxNow, lastTps, liveTps, benchTps,
    compatibleWithActiveEngine, incompatibleReason, sourceRepo, hidden,
  }
}
