// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Deps } from '../deps'
import { customSourceKey } from '../engines/registry'
import { ProbeError } from '../engines/probe'
import { isLocalOrAuthenticated } from '../auth'
import { LLAMA_BUILD, availableBackends, backendDefAt, backendDir, deleteAllBackendBuilds, installedBackendBuild, provisionBackend, recommendBackendId } from '../engines/download'
import { readReleaseMarker } from '../engines/release-install'
import { tagFromManagedBinPath, latestTagForInstalled } from '../engines/update'
import { handOverBackendEngine } from '../engines/update-apply'
import type { BackendId } from '../engines/download'
import { ensureMlxEnv } from '../engines/mlx'
import { ensureRapidMlxEnv } from '../engines/rapid-mlx'
import { installLayaEngine, layaEngineBusy } from '../engines/laya-install'
import { ensureMlxVlmEnv } from '../engines/mlx-vlm'
import { koboldcppBinPath } from '../engines/koboldcpp'
import { llamafileBinPath } from '../engines/llamafile'
import { catalogForPlatform } from '../engines/catalog'
import { findCatalogBuildOnDisk, findEngineForCatalogEntry, findReleaseEngineForCatalogEntry, pickReleaseSource, sourceBuildDirOf, type ReleaseCatalogEntry } from '../engines/build-runner'
import { detectHardware } from '../engines/hardware'
import { recommendEngines } from '../engines/recommend'
import { amdApuOnly, getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { stopEngineUsers } from '../engines/serving'
import { err, body } from './http'
import { engineWork, engineWorkBusy, backendEnableBusy, autoTuneUpdateBlock, type EngineJobs } from './engine-work'

/** The engine list, llama.cpp backends, the macOS/Laya runtime installs, the catalog and the recommendation. */
export function registerEngineRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
  // ---- engine registry (A1) ----
  app.get('/api/v1/engines', (c) => {
    const { engines, activeEngineId } = d.registry.list()
    // Custom (non-catalog) engines that are currently DISABLED — recorded (recordCustomSource)
    // when added, kept across a plain Disable, dropped only on purge. Cross-referenced against
    // the LIVE registry by customSourceKey so a re-enabled/rebuilt entry doesn't show twice.
    // binPathExists lets the UI offer a real "Enable" (re-register, no rebuild) vs. a
    // "build no longer on disk, rebuild from source" state for one the user deleted by hand.
    const liveKeys = new Set(engines.map((e) => customSourceKey(e)))
    const customDisabled = d.registry
      .customSources()
      .filter((s) => !liveKeys.has(customSourceKey(s)))
      .map((s) => ({ ...s, binPathExists: existsSync(s.binPath) }))
    return c.json({ engines, activeEngineId, customDisabled })
  })

  // ---- engine backends (ADR-025): hardware-aware default + override ----

  app.get('/api/v1/engines/backends', (c) => {
    const sys = getSysInfo()
    const vendor = primaryVendor(sys)
    const recommended = recommendBackendId(vendor, sys.gpus.length > 0, undefined, amdApuOnly(sys))
    const root = join(d.store.dir(), 'engines')
    const active = d.registry.active()
    const regEngines = d.registry.list().engines
    // Backend state is REGISTRY-driven (the accurate source): a backend is installed when ANY
    // official llama.cpp build of it is registered — not just the pinned LLAMA_BUILD tag (which
    // a de-pinned update moves off, making the old check falsely report "not installed" and
    // prompting a confusing re-download). The backend's engine = its newest installed build.
    const backendOf = (p: string): string | undefined =>
      p.match(/llama\.cpp-[^/\\]+-(cuda|rocm|sycl|vulkan|metal|cpu)/i)?.[1]?.toLowerCase()
    const buildNumOf = (p: string): number => {
      const m = p.match(/llama\.cpp-b(\d+)/i)
      return m ? Number(m[1]) : -1
    }
    const backends = availableBackends().map((b) => {
      const builds = regEngines
        .filter((e) => backendOf(e.binPath) === b.id)
        .sort((x, y) => buildNumOf(y.binPath) - buildNumOf(x.binPath))
      const eng = builds[0]
      return {
        id: b.id,
        label: b.label,
        installed: !!eng,
        enabled: !!eng,
        recommended: b.id === recommended,
        active: !!eng && !!active && active.id === eng.id,
        engineId: eng?.id ?? '',
      }
    })
    // MLX: disk-installed = venv python exists; enabled = registered in registry.
    const mlxVenvPy = join(root, 'mlx', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const mlxInstalledOnDisk = existsSync(mlxVenvPy)
    const mlxEngine = regEngines.find((e) => e.kind === 'mlx')
    const mlx = {
      supported: process.platform === 'darwin',
      installed: mlxInstalledOnDisk,
      enabled: !!mlxEngine,
      active: !!mlxEngine && !!active && active.id === mlxEngine.id,
      engineId: mlxEngine?.id ?? '',
    }
    return c.json({ vendor, recommended, gpus: sys.gpus, backends, mlx })
  })

  // Provision (download if needed) + register + activate a backend. Long-running;
  // returns 202 immediately and reports progress via GET /status engineProvision.
  app.post('/api/v1/engines/backends/install', async (c) => {
    const b = await body<{ backend?: string }>(c)
    const def = availableBackends().find((x) => x.id === b.backend)
    if (!def) return err(c, 400, 'invalid_config_value', 'Unknown backend for this platform.')
    const root = join(d.store.dir(), 'engines')
    // First-install only: seed the pinned LLAMA_BUILD. When ANY build of this backend is
    // already on disk (tag-agnostic — an update may have de-pinned it off LLAMA_BUILD,
    // ADR-085), this is a no-op download-wise so we never re-download a working install. The
    // real upstream check is the Update path's job, which resolves the REAL latest tag honestly.
    // GitHub #102: "Disable" only unregisters the engine (files stay on disk, ManagedEngines.tsx),
    // so a disabled backend hits exactly this branch — re-register + activate it here too, or
    // "Download" on a disabled backend silently does nothing forever (the binary is already
    // there, so there was never anything to actually download).
    const existing = installedBackendBuild(root, def.id)
    if (existing) {
      // This is the backend's Enable, so it waits for the same jobs and holds the same slot (backendEnableBusy).
      { const busy = backendEnableBusy(d, def.id); if (busy) return err(c, 409, 'engine_already_running', busy) }
      engineWork.backendEnableInFlight = true
      try {
        let eng = d.registry.list().engines.find((e) => e.binPath === existing.bin)
        if (!eng) {
          // A build that no longer runs here: a clear 400, as POST /engines gives, not an opaque 500.
          try {
            eng = (await d.registry.add(`llama.cpp ${existing.tag} (${def.id})`, existing.bin)).engine
          } catch (e) {
            if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
            throw e
          }
        }
        d.registry.activate(eng.id)
        return c.json({ accepted: false, alreadyInstalled: true, build: existing.tag })
      } finally {
        engineWork.backendEnableInFlight = false
      }
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const ac = new AbortController()
    jobs.provisionAbort = ac
    void (async () => {
      try {
        d.provision.start(def.id)
        const bin = await provisionBackend(
          root, def, LLAMA_BUILD,
          (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
          ac.signal,
        )
        let eng = d.registry.list().engines.find((e) => e.binPath === bin)
        if (!eng) eng = (await d.registry.add(`llama.cpp ${LLAMA_BUILD} (${def.id})`, bin)).engine
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') d.provision.done() // user cancelled
        else d.provision.fail(`Could not install the ${def.id} engine: ${e instanceof Error ? e.message : e}`)
      } finally {
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })()
    return c.json({ accepted: true, backend: def.id }, 202)
  })

  // Cancel an in-progress engine download (backend or MLX).
  app.post('/api/v1/engines/backends/cancel', (c) => {
    if (jobs.provisionAbort) {
      jobs.provisionAbort.abort()
      return c.json({ ok: true })
    }
    return c.json({ ok: false })
  })

  // De-pinned, rollback-safe update for an official llama.cpp backend (ADR-085, Phase 6).
  // Resolves the REAL latest upstream build tag, downloads it into a NEW tag-keyed dir,
  // probes it (registry.add probes), and only on success registers + activates it and GCs
  // the old install. On any download/probe failure the OLD install is left untouched
  // (rollback) and the error is surfaced via the provision channel. Reports 'already latest'
  // ONLY when the real upstream check confirms it — never the old "is the pinned build on
  // disk?" lie. 202 + progress via GET /status engineProvision (same channel as install).
  app.post('/api/v1/engines/backends/:id/update', async (c) => {
    const def = availableBackends().find((x) => x.id === c.req.param('id'))
    if (!def) return err(c, 400, 'invalid_config_value', 'Unknown backend for this platform.')
    const root = join(d.store.dir(), 'engines')
    // Tag-agnostic: the currently-installed build may have been de-pinned off LLAMA_BUILD by a
    // prior update (ADR-085), so resolve the newest build on disk rather than the pinned tag.
    const oldBin = installedBackendBuild(root, def.id)?.bin ?? null
    if (!oldBin) return err(c, 409, 'not_installed', 'Backend is not installed — download it first.')
    // Android's build is TurboLLM's own, one pinned file at downloadBaseUrl (see availableBackends): upstream's newer
    // tags have no Android asset there, so updating to one always failed with HTTP 404.
    if (def.downloadBaseUrl)
      return err(c, 409, 'no_update_source', 'This build has no automatic update source: upstream llama.cpp publishes no Android build.')
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    // Not under auto-tune: the update stops this build's users and hands its place to a new id (autoTuneUpdateBlock).
    { const tuning = autoTuneUpdateBlock(d, (t) => t.binPath === oldBin); if (tuning) return err(c, 409, 'engine_in_use', tuning) }
    // Honest upstream check FIRST: resolve the real latest tag. Offline → clear 503.
    // Resolved in the INSTALLED tag's own format via the shared resolver: `releases/latest`
    // returns llama.cpp's semver release (`v0.4.0`), which publishes no per-backend assets, so
    // downloading it 404'd while the build the user actually wanted (b10818) was never fetched.
    const installedTag = tagFromManagedBinPath(oldBin)
    let latestTag: string
    // The lookup holds the engine-work slot (up to 15 s), as POST /engines/:id/update's does: a Delete of this backend
    // that arrived meanwhile, with no engine to stop, ended before the re-check below, which then passed, and the
    // update downloaded and registered the backend the user had just deleted. Released before that re-check, which
    // still catches a job that passed its own check before this one; provision.start then follows with no await.
    engineWork.engineUpdateInFlight = true
    try {
      latestTag = await latestTagForInstalled('ggml-org/llama.cpp', installedTag, AbortSignal.timeout(15_000))
    } catch {
      return err(c, 503, 'offline', "Couldn't reach GitHub to check for a newer build. Try again when online.")
    } finally {
      engineWork.engineUpdateInFlight = false
    }
    if (!latestTag) return err(c, 503, 'offline', "GitHub didn't report a latest build. Try again later.")
    // Already on the real latest → honest "already latest" (no download).
    if (installedTag && installedTag === latestTag) {
      return c.json({ accepted: false, alreadyLatest: true, build: latestTag })
    }
    const newDef = backendDefAt(def.id as BackendId, latestTag)
    if (!newDef) return err(c, 500, 'internal', 'No upstream build of this backend for your platform.')
    // A job that passed its own check before this one's could still start during the lookup (a scheduler auto-update in
    // its own lookup); re-check before taking the slot, or both would provision the same tag dir and share one
    // progress/Cancel channel.
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const ac = new AbortController()
    jobs.provisionAbort = ac
    void (async () => {
      try {
        d.provision.start(def.id, 'user_update')
        // Download the latest build into its OWN tag-keyed dir. The old dir is untouched,
        // so a failure here leaves the working install in place (rollback by construction).
        const newBin = await provisionBackend(
          root, newDef, latestTag,
          (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
          ac.signal,
        )
        // Probe + register the new build (add() probes the binary). Only now do we touch
        // the active engine / old install — if the probe throws, the old build still runs.
        let newEng = d.registry.list().engines.find((e) => e.binPath === newBin)
        if (!newEng) {
          try {
            // Selected only in place of the old build, below: never into an empty selection (see update-apply.ts).
            newEng = (await d.registry.add(`llama.cpp ${latestTag} (${def.id})`, newBin, undefined, { fillEmptySelection: false })).engine
          } catch (e) {
            // The new build doesn't run here: remove it. Left on disk with its completion marker,
            // installedBackendBuild (newest tag wins) would pick it over the working build, so
            // Update would claim "already latest" and Enable/Download would hit the failing probe.
            // Retries: the probe just ran this tree's exe/DLLs, and a Windows AV/indexer handle can still be
            // open. Best effort — a failed cleanup must not replace the probe error as the reported cause.
            try { rmSync(backendDir(root, def.id as BackendId, latestTag), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
            throw e
          }
        }
        // Stop the engine if the OLD build of this backend is the running active one, so the
        // swap doesn't leave a stale process pointing at a dir we're about to delete.
        const oldEng = d.registry.list().engines.find((e) => e.binPath === oldBin)
        // The new build takes the old one's place: active only if the old one still is (updating a
        // fallback backend must not switch the user's engine), and with everything kept under its id
        // (handOverBackendEngine). Read after stopEngineUsers: stopping a pool slot leaves the manager
        // idle, so the activate route allows a switch meanwhile, and a check read before it undid that
        // switch.
        if (oldEng) await stopEngineUsers(d, oldEng.id)
        if (oldEng && d.registry.active()?.id === oldEng.id) d.registry.activate(newEng.id)
        // From here the new build has replaced the old one: what follows is best effort, never "your existing build is
        // unchanged". GC the old install: unregister its engine entry + delete its tag-keyed dir.
        if (oldEng && oldEng.id !== newEng.id) {
          handOverBackendEngine(d, oldEng, newEng.id, installedTag ? `llama.cpp ${installedTag} (${def.id})` : null)
        }
        if (installedTag && installedTag !== latestTag) {
          // Best effort, as in update-apply.ts: a Windows lock on the old build (retried here, as it is brief) must not
          // report the finished update as failed.
          try { rmSync(backendDir(root, def.id as BackendId, installedTag), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
        }
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') d.provision.done() // user cancelled — old install intact
        else d.provision.fail(`Could not update the ${def.id} engine (your existing build is unchanged): ${e instanceof Error ? e.message : e}`)
      } finally {
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })()
    return c.json({ accepted: true, backend: def.id, build: latestTag }, 202)
  })

  // Enable (register without re-downloading) an installed llama.cpp backend.
  // Fast path: the binary already exists on disk; we just add it to the registry
  // and activate it. Returns 409 when the backend is not installed on disk.
  app.post('/api/v1/engines/backends/:id/enable', async (c) => {
    const def = availableBackends().find((x) => x.id === c.req.param('id'))
    if (!def) return err(c, 400, 'invalid_config_value', 'Unknown backend for this platform.')
    // Taken synchronously after the check (backendEnableBusy) and held through the probe (see backendEnableInFlight),
    // so a Delete, an update and every other engine job waits for it.
    { const busy = backendEnableBusy(d, def.id); if (busy) return err(c, 409, 'engine_already_running', busy) }
    engineWork.backendEnableInFlight = true
    try {
      const root = join(d.store.dir(), 'engines')
      // Tag-agnostic: enable whatever build is on disk (a de-pinned update may have left a
      // non-LLAMA_BUILD tag), naming the registry entry after that build's real tag.
      const build = installedBackendBuild(root, def.id)
      if (!build) return err(c, 409, 'not_installed', 'Backend is not installed on disk — download it first.')
      let eng = d.registry.list().engines.find((e) => e.binPath === build.bin)
      if (!eng) {
        try {
          eng = (await d.registry.add(`llama.cpp ${build.tag} (${def.id})`, build.bin)).engine
        } catch (e) {
          if (e instanceof ProbeError) return err(c, 400, e.code, e.message) // as POST /engines
          throw e
        }
      }
      d.registry.activate(eng.id)
      return c.json({ ok: true, engineId: eng.id })
    } finally {
      engineWork.backendEnableInFlight = false
    }
  })

  // Delete an installed backend's files + unregister its engine. Stops the engine
  // first if it's the active, running one.
  app.delete('/api/v1/engines/backends/:id', async (c) => {
    // Deletes every build of the backend from disk, so it needs a key from a non-host caller like the purge of
    // DELETE /engines/:id below and DELETE /engines/build. api_key_required: the web client opens its key prompt.
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', "Deleting an engine's files requires a valid API key.")
    const def = availableBackends().find((x) => x.id === c.req.param('id'))
    if (!def) return err(c, 400, 'invalid_config_value', 'Unknown backend for this platform.')
    // Never under an update or download (see DELETE /engines/:id): an update of this backend would register the build
    // it swaps in again right after the delete.
    { const busy = engineWorkBusy(d, { engineChange: true }); if (busy) return err(c, 409, 'engine_already_running', busy) }
    // Taken synchronously after the check and held until the builds are gone: the stops below are awaited, and a job
    // started meanwhile would otherwise pass its own check (see backendDeleteInFlight).
    engineWork.backendDeleteInFlight = true
    try {
      const root = join(d.store.dir(), 'engines')
      // Tag-agnostic: unregister + delete EVERY build of this backend (an update may have left
      // more than one tag-keyed dir / registry entry). Stop first if the active engine is one of them.
      // `[^\\/]+` (not `.+`) so the tag can't greedily span path separators into another segment.
      const backendDirRe = new RegExp(`[\\\\/]engines[\\\\/]llama\\.cpp-[^\\\\/]+-${def.id}[\\\\/]`)
      const engs = d.registry.list().engines.filter((e) => backendDirRe.test(e.binPath))
      for (const e of engs) await stopEngineUsers(d, e.id)
      for (const e of engs) {
        try { d.registry.remove(e.id) } catch { /* already gone */ }
      }
      deleteAllBackendBuilds(root, def.id)
      return c.json({ ok: true })
    } finally {
      engineWork.backendDeleteInFlight = false
    }
  })

  // Provision the MLX engine (macOS-only, ADR-025 Phase 3): uv → venv → mlx-lm,
  // then register as a kind='mlx' engine. 202 + progress via /status.
  // ?update=1 upgrades mlx-lm to the latest release (passes --upgrade to uv pip install).
  app.post('/api/v1/engines/mlx', (c) => {
    if (process.platform !== 'darwin') {
      return err(c, 409, 'unsupported_platform', 'MLX is only available on macOS (Apple Silicon).')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('mlx', 'runtime_env')
        const rt = await ensureMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addMlx(`MLX (${rt.version})`, rt.python, rt.version)
        // An update leaves the active engine as it was (as update-apply.ts does): activating it would switch engines
        // under a model running on another. An install activates it. Each pip engine has one registration, replaced
        // in place by its venv path, so its kind identifies it. Read now, not before the upgrade: that takes minutes,
        // the activate route allows a switch meanwhile whenever no model is loaded, and a check read before undid it.
        if (!upgrade || d.registry.active()?.kind === 'mlx') d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install MLX: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'mlx' }, 202)
  })

  // Provision the Rapid-MLX engine (macOS-only): uv → venv → rapid-mlx, then register as a
  // kind='rapid-mlx' engine. 202 + progress via /status. ?update=1 upgrades to the latest
  // release (passes --upgrade to uv pip install). Mirrors the MLX endpoint above.
  app.post('/api/v1/engines/rapid-mlx', (c) => {
    if (process.platform !== 'darwin') {
      return err(c, 409, 'unsupported_platform', 'Rapid-MLX is only available on macOS (Apple Silicon).')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('rapid-mlx', 'runtime_env')
        const rt = await ensureRapidMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addRapidMlx(`Rapid-MLX (${rt.version})`, rt.bin, rt.version)
        if (!upgrade || d.registry.active()?.kind === 'rapid-mlx') d.registry.activate(eng.id) // an update keeps the active engine, read now (see MLX)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install Rapid-MLX: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'rapid-mlx' }, 202)
  })

  // Provision the MLX-VLM engine (macOS-only): uv → venv → mlx-vlm, then register as a
  // kind='mlx-vlm' engine. 202 + progress via /status. ?update=1 upgrades to the latest
  // release (passes --upgrade to uv pip install). Mirrors the MLX/Rapid-MLX endpoints above.
  app.post('/api/v1/engines/mlx-vlm', (c) => {
    if (process.platform !== 'darwin') {
      return err(c, 409, 'unsupported_platform', 'MLX-VLM is only available on macOS (Apple Silicon).')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('mlx-vlm', 'runtime_env')
        const rt = await ensureMlxVlmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addMlxVlm(`MLX-VLM (${rt.version})`, rt.python, rt.version)
        if (!upgrade || d.registry.active()?.kind === 'mlx-vlm') d.registry.activate(eng.id) // an update keeps the active engine, read now (see MLX)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install MLX-VLM: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'mlx-vlm' }, 202)
  })

  // Provision the Laya engine (every desktop platform): uv → venv → laya[serve], then register it as a
  // kind='laya' engine. Never activated: Laya models load on it whichever engine is active. 202 + progress
  // via /status; ?update=1 upgrades within the pinned line.
  app.post('/api/v1/engines/laya', (c) => {
    { const busy = engineWorkBusy(d) ?? layaEngineBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    void installLayaEngine(d, join(d.store.dir(), 'engines'), c.req.query('update') === '1')
    return c.json({ accepted: true, engine: 'laya' }, 202)
  })

  // Engine catalog (ADR-044): the hardcoded, browsable list of installable
  // engines for this platform. Per-entry `installed` is disk-based (files exist);
  // `enabled` is registry-based (a registered engine entry exists for this kind).
  // Optional `branch` query param — when provided, source-built matching is scoped to
  // that branch so each branch gets its own installed/enabled state on the card.
  app.get('/api/v1/engines/catalog', (c) => {
    const regEngines = d.registry.list().engines
    const enginesRoot = join(d.store.dir(), 'engines')
    const branchParam = (c.req.query('branch') ?? '').trim() || undefined
    // A Disabled release install: a remembered custom source whose on-disk marker names this card's repo.
    const findDisabledReleaseInstall = (entry: ReleaseCatalogEntry, branch?: string) => {
      const live = new Set(regEngines.map((x) => x.binPath))
      const found = d.registry.customSources().flatMap((s) => {
        const release = readReleaseMarker(sourceBuildDirOf(s.binPath, enginesRoot))
        return release && !live.has(s.binPath) && existsSync(s.binPath) ? [{ ...s, release }] : []
      })
      const claimed = found.filter((s) => findReleaseEngineForCatalogEntry([{ id: s.binPath, release: s.release }], entry, branch))
      return pickReleaseSource(claimed)
    }
    const items = catalogForPlatform().map((e) => {
      let installed: boolean | undefined
      let enabled: boolean | undefined
      if (e.provision === 'pip') {
        // pip engines: installed = venv python exists on disk; enabled = registered in registry.
        // Every pip catalog id names its own venv subdir 1:1 (mlx/rapid-mlx/mlx-vlm/vllm/sglang/laya/litert-lm).
        const pyPath = join(enginesRoot, e.id, 'venv',
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
        installed = existsSync(pyPath)
        enabled = regEngines.some((x) => x.kind === e.kind)
      } else if (e.id === 'turboquant') {
        // TurboQuant is a llama-server fork: installed = its dir exists on disk;
        // enabled = a registry engine has a binPath inside engines/turboquant/.
        const tqDir = join(enginesRoot, 'turboquant')
        installed = existsSync(tqDir)
        enabled = regEngines.some((x) => /[\\/]engines[\\/]turboquant[\\/]/.test(x.binPath))
      } else if (e.id === 'koboldcpp') {
        // KoboldCpp: single binary under engines/koboldcpp/; enabled = a registered
        // engine of kind 'koboldcpp' exists.
        installed = existsSync(koboldcppBinPath(enginesRoot))
        enabled = regEngines.some((x) => x.kind === 'koboldcpp')
      } else if (e.id === 'llamafile') {
        // llamafile: single binary under engines/llamafile/; enabled = a registered
        // engine of kind 'llamafile' exists.
        installed = existsSync(llamafileBinPath(enginesRoot))
        enabled = regEngines.some((x) => x.kind === 'llamafile')
      }
      // Source-built recognition (ADR-100): a fork the user compiled from THIS catalog repo
      // (matched by the engine's sourceRepo) is installed + enabled — so the card shows the
      // manage menu (rebuild/disable/delete) instead of a stale "Build from source". Also
      // detect a built-but-disabled engine (registry entry removed, build output still on disk)
      // so Enable can re-register it.
      // A repo-only match isn't enough for a catalog entry that pins a commit/patch (e.g.
      // solar-open2 vs. the plain llama.cpp entry — both build ggml-org/llama.cpp): without also
      // requiring the SAME commit + patch, a plain unpatched llama.cpp build would falsely read
      // as "solar-open2 already installed" and hand out a binary with no solar_open2 support at
      // all. Branch is compared as an EFFECTIVE branch (a blank recorded branch means the entry's
      // `defaultBranch`), so an engine recorded as the default and one recorded blank both belong
      // to the card, while one on any other branch stays a distinct custom engine. A pinned
      // commit/patch entry ignores the branch entirely. See findEngineForCatalogEntry.
      // Skip entirely for `excludeFromSourceMatch` entries (ADR-388) — the backend-picker
      // `llama.cpp` card's installed state comes from LlamaCppBackendRows, not this. Without the
      // guard, a manually source-built plain `ggml-org/llama.cpp` (no commit/patch — the same
      // identity this card matches with) got its registry id silently claimed here, hiding it
      // from BOTH the custom-engine card list AND this card's own UI (which never reads
      // `sourceEngineId`) — founder-reported: "now it is only visible for selection in dropdown".
      const srcEng = e.excludeFromSourceMatch ? undefined : findEngineForCatalogEntry(regEngines, e, branchParam)
      // A release-installed engine of this card's repo (ADR-453) is the card's fallback: a source
      // build is the exact identity for the branch and wins; a registered release engine beats a
      // build that is merely on disk. It never sets sourceBuilt/sourceEngineId (ADR-088: Rebuild
      // must stay unreachable for it).
      const relEng = !srcEng ? findReleaseEngineForCatalogEntry(regEngines, e, branchParam, d.registry.active()?.id) : undefined
      const onDisk = !srcEng && !relEng && !e.excludeFromSourceMatch ? findCatalogBuildOnDisk(enginesRoot, e, branchParam) : undefined
      const disabledRelease = !srcEng && !relEng && !onDisk ? findDisabledReleaseInstall(e, branchParam) : undefined
      const sourceBinPath: string | undefined = srcEng?.binPath ?? onDisk?.binPath
      const sourceBuilt = !!srcEng || !!sourceBinPath
      if (srcEng || relEng) {
        installed = true
        enabled = true
      } else if (sourceBinPath || disabledRelease) {
        installed = true
        enabled = enabled ?? false
      }
      return {
        ...e,
        installed,
        enabled,
        sourceBuilt,
        sourceEngineId: srcEng?.id,
        sourceBranch: srcEng?.sourceBranch ?? onDisk?.branch ?? '',
        sourceBinPath: sourceBinPath ?? '',
        releaseEngineId: relEng?.id,
        release: relEng?.release ?? disabledRelease?.release,
        releaseBinPath: relEng?.binPath ?? disabledRelease?.binPath,
      }
    })
    return c.json({ engines: items })
  })

  // Engine recommendation (engine overhaul, Phase 2): the hardware-level fit for the
  // WHOLE catalog. Deliberately NOT OS-prefiltered — incompatible engines come back
  // WITH a reason so the UI can grey them rather than hide them (ADR-083 "grey +
  // reason, don't hide"). Pure read; pass the full CatalogEngine[] (drop the
  // per-platform `supportedHere` flag the catalog endpoint adds).
  app.get('/api/v1/engines/recommendation', (c) => {
    const hw = detectHardware()
    const rec = recommendEngines(hw, catalogForPlatform().map(({ supportedHere, ...e }) => e))
    return c.json({ hardware: hw, recommendation: rec })
  })
}
