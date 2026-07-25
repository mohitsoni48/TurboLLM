// Internal API routes (/api/v1/*) per spec 02. Thin handlers over config/engines.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { GATE_VERSION, gateNodeSource } from '../comfyui/gate-template'
import { randomUUID } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { ValueError, getModelProfile, setModelProfile, deleteModelProfile, VRAM_HEADROOM_MIN_MB, VRAM_HEADROOM_MAX_MB, VRAM_HEADROOM_SPILL_MB, type ApiKey, type Engine, type McpServer } from '../config/config'
import type { Deps } from '../deps'
import { type ModelInfo, type StartOpts } from '../engines/manager'
import { abortAllInFlightChats } from '../chat/chat-routes'
import { NameTakenError, NotFoundError, customSourceKey } from '../engines/registry'
import { ProbeError, probe } from '../engines/probe'
import { resolveServerBinary, suggestEngineName } from '../engines/scan'
import { generateApiKey, isLocalRequest } from '../auth'
import { enabledFeatures } from '../features'
import {
  LLAMA_BUILD,
  availableBackends,
  backendDefAt,
  backendDir,
  deleteAllBackendBuilds,
  installedBackendBuild,
  latestReleaseTag,
  provisionBackend,
  provisionTurboquant,
  recommendBackendId,
} from '../engines/download'
import {
  normalizeUpdatePolicy,
  tagFromManagedBinPath,
} from '../engines/update'
import type { BackendId } from '../engines/download'
import { ensureMlxEnv, mlxSamplingArgs } from '../engines/mlx'
import { ensureRapidMlxEnv } from '../engines/rapid-mlx'
import { ensureVllmEnv } from '../engines/vllm'
import { ensureSglangEnv } from '../engines/sglang'
import { ensureKoboldcpp, koboldcppBinPath, koboldcppDir, koboldcppProfileToArgs } from '../engines/koboldcpp'
import { ensureLlamafile, llamafileBinPath, llamafileDir } from '../engines/llamafile'
import { catalogForPlatform, catalogEngine } from '../engines/catalog'
import { checkBuildPrereqs } from '../engines/build-prereqs'
import { runBuild, buildDirName, sameRepo, sourceBuildBinary, sourceBuildDirOf } from '../engines/build-runner'
import { provisionCuda } from '../engines/cuda-provision'
import { detectHardware } from '../engines/hardware'
import { recommendEngines } from '../engines/recommend'
import { engineAcceptsFormat, engineRejectsAudioModel } from '../engines/compat'
import { ScannerError, type ModelEntry } from '../models/scanner'
import { estimateVram, type LoadProfile, profileToArgs, resolveProfile, vllmProfileToArgs } from '../models/profile'
import { getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { HfError, type HfSortOption } from '../hf/hf'
import { DownloadError } from '../downloads/downloads'
import { BenchError } from '../bench/bench'
import { inferRepoFromPath } from './path-utils'
import { screenshotArtifact, findChrome } from '../artifacts/screenshot'

type Status = 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 500 | 501 | 503

function err(c: Context, status: Status, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

export function registerApi(app: Hono, d: Deps): void {
  // ---- meta ----
  app.get('/api/v1/status', (c) => {
    const ms = d.manager.status()
    const active = d.registry.active()
    const engine: Record<string, unknown> = {
      id: active?.id ?? '',
      name: active?.name ?? '',
      kind: active?.kind ?? '',
      state: ms.state,
      port: ms.port,
      pid: ms.pid,
    }
    if (ms.err) engine.error = ms.err
    const launchCommand = d.manager.launchCommand()
    if (launchCommand) engine.launchCommand = launchCommand
    const model = ms.model
      ? { key: ms.model.key, name: ms.model.name, quant: ms.model.quant, ctx: ms.model.ctx, vision: ms.model.vision, loadElapsedMs: ms.loadElapsedMs }
      : null
    // Live running-session stats (B4): only meaningful while the engine runs.
    const engineStats = ms.state === 'running' ? d.manager.sessionStats() : null
    // Live per-request progress for the engine card (prefill % / live token count).
    const liveGeneration = ms.state === 'running' ? d.manager.liveGeneration() : null
    return c.json({
      version: d.version,
      engine,
      model,
      // Last model the user loaded (config-tracked) — lets `turbollm launch` auto-load the
      // true last-used model instead of guessing the first library entry (F-034).
      lastLoaded: d.store.snapshot().lastLoaded,
      engineStats,
      liveGeneration,
      // Auto-tune runner state (spec 09 §1): real progress while a sweep runs, then
      // a lingering done/error snapshot the detail dialog reads to show the result.
      bench: d.bench.status(),
      downloads: { active: d.downloads.activeCount() },
      engineProvision: d.provision.get(),
      // Background agent tasks (reviewer + skill distill): running + recently-finished,
      // so the UI can show them inline in the conversation + a side panel on click.
      agentTasks: d.agentTasks?.list() ?? [],
      // In-app compile-from-source status (ADR-100): live phase + log tail while a build runs.
      engineBuild: d.build.get(),
      // ComfyUI GPU coordination: lets the UI explain a paused/unloaded engine.
      // Also expose the installed gate node version so the UI can prompt an upgrade.
      comfyui: (() => {
        const snap = d.comfy?.snapshot() ?? null
        if (!snap) return null
        const gatePath = d.store.snapshot().comfyui.gatePath
        let installedVersion: number | null = null
        if (gatePath) {
          try {
            const src = readFileSync(join(gatePath, '__init__.py'), 'utf-8')
            const m = src.match(/^GATE_VERSION\s*=\s*(\d+)/m)
            if (m) installedVersion = Number(m[1])
          } catch { /* file missing or unreadable */ }
        }
        return { ...snap, installedVersion, currentVersion: GATE_VERSION }
      })(),
      telemetryLevel: d.store.snapshot().telemetry.level,
      uptimeSec: Math.floor((Date.now() - d.startedAt) / 1000),
      // Cloud Launch tunnel (ADR-045/152): null until --tunnel is active.
      tunnel: d.tunnel ? d.tunnel.snapshot() : null,
      // Local feature flags (TURBOLLM_FEATURES env var) — deliberately undocumented
      // in any user-facing README; see features.ts.
      features: enabledFeatures(),
    })
  })

  // ---- artifact screenshot (faithful export) ----
  // Pixel-perfect raster of an HTML artifact via a real headless Chrome (ADR-121 follow-up).
  // Local-only (renders arbitrary HTML in a browser); LAN clients fall back to client-side
  // html2canvas. Returns 503 when no system browser is found so the caller falls back too.
  app.get('/api/v1/artifacts/screenshot/available', (c) => c.json({ available: findChrome() !== null }))
  app.post('/api/v1/artifacts/screenshot', async (c) => {
    if (!isLocalRequest(c, d)) return err(c, 403, 'forbidden', 'Screenshot is local-only.')
    const { html, width } = await body<{ html?: string; width?: number }>(c)
    if (!html || typeof html !== 'string') return err(c, 400, 'bad_request', 'html is required')
    const w = Math.max(360, Math.min(Math.round(width || 1000), 1280))
    const h = Math.max(480, Math.round((w * 800) / 1280))
    const png = await screenshotArtifact(html, { width: w, height: h })
    if (!png) return err(c, 503, 'no_browser', 'No system Chrome/Chromium/Edge found.')
    return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
  })

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
  // Tracks the in-flight backend download so it can be cancelled.
  let provisionAbort: AbortController | null = null
  // Tracks the in-flight 1-click build so it can be cancelled (ADR-100).
  let buildAbort: AbortController | null = null

  app.get('/api/v1/engines/backends', (c) => {
    const sys = getSysInfo()
    const vendor = primaryVendor(sys)
    const recommended = recommendBackendId(vendor, sys.gpus.length > 0)
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
    // ADR-085), this is a no-op so we never re-download a working install. The real upstream
    // check is the Update path's job, which resolves the REAL latest tag honestly.
    const existing = installedBackendBuild(root, def.id)
    if (existing) {
      return c.json({ accepted: false, alreadyInstalled: true, build: existing.tag })
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const ac = new AbortController()
    provisionAbort = ac
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
        if (provisionAbort === ac) provisionAbort = null
      }
    })()
    return c.json({ accepted: true, backend: def.id }, 202)
  })

  // Cancel an in-progress engine download (backend or MLX).
  app.post('/api/v1/engines/backends/cancel', (c) => {
    if (provisionAbort) {
      provisionAbort.abort()
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
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    // Honest upstream check FIRST: resolve the real latest tag. Offline → clear 503.
    let latestTag: string
    try {
      latestTag = await latestReleaseTag('ggml-org/llama.cpp', AbortSignal.timeout(15_000))
    } catch {
      return err(c, 503, 'offline', "Couldn't reach GitHub to check for a newer build. Try again when online.")
    }
    if (!latestTag) return err(c, 503, 'offline', "GitHub didn't report a latest build. Try again later.")
    const installedTag = tagFromManagedBinPath(oldBin)
    // Already on the real latest → honest "already latest" (no download).
    if (installedTag && installedTag === latestTag) {
      return c.json({ accepted: false, alreadyLatest: true, build: latestTag })
    }
    const newDef = backendDefAt(def.id as BackendId, latestTag)
    if (!newDef) return err(c, 500, 'internal', 'No upstream build of this backend for your platform.')
    const ac = new AbortController()
    provisionAbort = ac
    void (async () => {
      try {
        d.provision.start(def.id)
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
        if (!newEng) newEng = (await d.registry.add(`llama.cpp ${latestTag} (${def.id})`, newBin)).engine
        // Stop the engine if the OLD build of this backend is the running active one, so the
        // swap doesn't leave a stale process pointing at a dir we're about to delete.
        const oldEng = d.registry.list().engines.find((e) => e.binPath === oldBin)
        if (oldEng && d.registry.active()?.id === oldEng.id) await d.manager.stopAndWait()
        d.registry.activate(newEng.id)
        // GC the old install: unregister its engine entry + delete its tag-keyed dir.
        if (oldEng && oldEng.id !== newEng.id) {
          try { d.registry.remove(oldEng.id) } catch { /* already gone */ }
        }
        if (installedTag && installedTag !== latestTag) {
          rmSync(backendDir(root, def.id as BackendId, installedTag), { recursive: true, force: true })
        }
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') d.provision.done() // user cancelled — old install intact
        else d.provision.fail(`Could not update the ${def.id} engine (your existing build is unchanged): ${e instanceof Error ? e.message : e}`)
      } finally {
        if (provisionAbort === ac) provisionAbort = null
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
    const root = join(d.store.dir(), 'engines')
    // Tag-agnostic: enable whatever build is on disk (a de-pinned update may have left a
    // non-LLAMA_BUILD tag), naming the registry entry after that build's real tag.
    const build = installedBackendBuild(root, def.id)
    if (!build) return err(c, 409, 'not_installed', 'Backend is not installed on disk — download it first.')
    let eng = d.registry.list().engines.find((e) => e.binPath === build.bin)
    if (!eng) eng = (await d.registry.add(`llama.cpp ${build.tag} (${def.id})`, build.bin)).engine
    d.registry.activate(eng.id)
    return c.json({ ok: true, engineId: eng.id })
  })

  // Delete an installed backend's files + unregister its engine. Stops the engine
  // first if it's the active, running one.
  app.delete('/api/v1/engines/backends/:id', async (c) => {
    const def = availableBackends().find((x) => x.id === c.req.param('id'))
    if (!def) return err(c, 400, 'invalid_config_value', 'Unknown backend for this platform.')
    const root = join(d.store.dir(), 'engines')
    // Tag-agnostic: unregister + delete EVERY build of this backend (an update may have left
    // more than one tag-keyed dir / registry entry). Stop first if the active engine is one of them.
    // `[^\\/]+` (not `.+`) so the tag can't greedily span path separators into another segment.
    const backendDirRe = new RegExp(`[\\\\/]engines[\\\\/]llama\\.cpp-[^\\\\/]+-${def.id}[\\\\/]`)
    const engs = d.registry.list().engines.filter((e) => backendDirRe.test(e.binPath))
    const activeId = d.registry.active()?.id
    if (engs.some((e) => e.id === activeId)) await d.manager.stopAndWait()
    for (const e of engs) {
      try { d.registry.remove(e.id) } catch { /* already gone */ }
    }
    deleteAllBackendBuilds(root, def.id)
    return c.json({ ok: true })
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
        d.provision.start('mlx')
        const rt = await ensureMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addMlx(`MLX (${rt.version})`, rt.python, rt.version)
        d.registry.activate(eng.id)
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
        d.provision.start('rapid-mlx')
        const rt = await ensureRapidMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addRapidMlx(`Rapid-MLX (${rt.version})`, rt.bin, rt.version)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install Rapid-MLX: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'rapid-mlx' }, 202)
  })

  // Engine catalog (ADR-044): the hardcoded, browsable list of installable
  // engines for this platform. Per-entry `installed` is disk-based (files exist);
  // `enabled` is registry-based (a registered engine entry exists for this kind).
  app.get('/api/v1/engines/catalog', (c) => {
    const regEngines = d.registry.list().engines
    const enginesRoot = join(d.store.dir(), 'engines')
    const items = catalogForPlatform().map((e) => {
      let installed: boolean | undefined
      let enabled: boolean | undefined
      if (e.provision === 'pip') {
        // pip engines: installed = venv python exists on disk; enabled = registered in registry.
        // Every pip catalog id names its own venv subdir 1:1 (mlx/rapid-mlx/vllm/sglang).
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
      // all. Entries with no commit/patch pin (sourceCommit/patchUrl both '') still match each
      // other exactly as before.
      const srcEng = regEngines.find(
        (x) =>
          sameRepo(x.sourceRepo, e.homepage) &&
          (x.sourceCommit ?? '') === (e.sourceCommit ?? '') &&
          (x.sourcePatchUrl ?? '') === (e.patchUrl ?? ''),
      )
      let sourceBinPath: string | undefined = srcEng?.binPath
      if (!srcEng) sourceBinPath = sourceBuildBinary(enginesRoot, e.homepage, undefined, e.sourceCommit) ?? undefined
      const sourceBuilt = !!srcEng || !!sourceBinPath
      if (srcEng) {
        installed = true
        enabled = true
      } else if (sourceBinPath) {
        installed = true
        enabled = enabled ?? false
      }
      return {
        ...e,
        installed,
        enabled,
        sourceBuilt,
        sourceEngineId: srcEng?.id,
        sourceBranch: srcEng?.sourceBranch ?? '',
        sourceBinPath: sourceBinPath ?? '',
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

  // Compile-from-source prereq check (ADR-089, macOS/Metal port). Read-only: detects the
  // Windows/Linux + CUDA (or macOS + Metal) build toolchain (git / cmake / CUDA-or-compiler)
  // so the build guide can show what's missing + install links. The configured toolchain
  // dirs (ADR-100) are prepended to PATH so a conda-env / custom-path CUDA Toolkit is found.
  app.get('/api/v1/build/prereqs', async (c) =>
    c.json(await checkBuildPrereqs(d.store.snapshot().build.toolchainDirs)),
  )

  // 1-click compile-from-source (ADR-100, Windows/Linux + CUDA, or macOS + Metal). Clones the
  // repo, runs cmake, compiles llama-server, then registers + activates the built binary.
  // Long-running; 202 immediately + live phase/log via GET /status engineBuild. Gated to the
  // local host — it executes a compiler from a user-supplied repo, so a LAN client must not
  // trigger it.
  app.post('/api/v1/build/run', async (c) => {
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Building an engine is only available on the machine running TurboLLM.')
    if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin')
      return err(c, 409, 'unsupported_platform', 'In-app build is currently Windows, Linux, or macOS only.')
    const b = await body<{ repoUrl?: string; branch?: string; commit?: string; name?: string; patchUrl?: string; patchSha256?: string }>(c)
    const repoUrl = (b.repoUrl ?? '').trim()
    if (!/^https?:\/\//i.test(repoUrl))
      return err(c, 400, 'invalid_config_value', 'A http(s) repo URL is required.')
    const branch = (b.branch ?? '').trim() || undefined
    // A branch beginning with '-' would be parsed by git as an option (it sits before the
    // positional URL). Reject it — belt-and-suspenders, even though builds are local-only.
    if (branch && branch.startsWith('-'))
      return err(c, 400, 'invalid_config_value', 'Branch name cannot start with "-".')
    const commit = (b.commit ?? '').trim() || undefined
    if (commit && !/^[0-9a-f]{7,40}$/i.test(commit))
      return err(c, 400, 'invalid_config_value', 'commit must be a hex SHA (7-40 chars).')
    // Optional pinned patch (solar_open2-class engines): both-or-neither — a patch is only ever
    // applied with a checksum to verify it against (build-runner enforces this too; validate here
    // so a bad request fails fast with a clear 400 instead of failing mid-build).
    const patchUrl = (b.patchUrl ?? '').trim() || undefined
    const patchSha256 = (b.patchSha256 ?? '').trim() || undefined
    if (!!patchUrl !== !!patchSha256)
      return err(c, 400, 'invalid_config_value', 'patchUrl and patchSha256 must be provided together — a patch may only be applied with a pinned checksum.')
    if (patchUrl && !/^https?:\/\//i.test(patchUrl))
      return err(c, 400, 'invalid_config_value', 'patchUrl must be an http(s) URL.')
    if (patchSha256 && !/^[0-9a-f]{64}$/i.test(patchSha256))
      return err(c, 400, 'invalid_config_value', 'patchSha256 must be a 64-char hex SHA-256.')
    const busy = engineWorkBusy(d)
    if (busy) return err(c, 409, 'engine_already_running', busy)
    const name = (b.name ?? '').trim() || undefined
    const enginesRoot = join(d.store.dir(), 'engines')
    const toolchainDirs = d.store.snapshot().build.toolchainDirs
    const buildRoot = join(enginesRoot, 'build', buildDirName(repoUrl, branch, commit))
    // Reserve the build slot SYNCHRONOUSLY (before returning 202) so two near-simultaneous
    // POSTs can't both pass the busy-check and race on the same buildRoot / clobber buildAbort.
    const ac = new AbortController()
    buildAbort = ac
    d.build.start(name ?? repoUrl)
    void (async () => {
      try {
        let out
        try {
          out = await runBuild(
            { repoUrl, branch, commit, patchUrl, patchSha256, enginesRoot, toolchainDirs },
            { phase: (p) => d.build.phase(p), log: (line) => d.build.log(line) },
            ac.signal,
          )
        } catch (e) {
          // The BUILD step (clone/configure/compile) failed or was cancelled: GC the partial
          // tree so repeated attempts don't fill the disk with multi-GB CUDA objects. Only
          // here — never after a binary was successfully produced (that would throw away a
          // good build over a mere registration hiccup).
          try { rmSync(buildRoot, { recursive: true, force: true }) } catch { /* best effort */ }
          if ((e as Error)?.name === 'AbortError') {
            d.build.log('Build cancelled.')
            d.build.fail('Build cancelled.')
          } else {
            // Friendlier message for the common "fork needs a GAS/MinGW assembler" case: some
            // forks (e.g. TurboQuant) enable the generic CMake `ASM` language, which on Windows
            // requires a GAS assembler — MSVC can't provide it, so the build can't run here.
            const asmIssue = d.build.get().log.some((l) => /No CMAKE_ASM_COMPILER could be found|ASM compiler identification is unknown/i.test(l))
            const raw = e instanceof Error ? e.message : String(e)
            d.build.fail(
              asmIssue
                ? "This fork needs a GAS/MinGW assembler (it enables CMake's generic ASM language), which isn't available with the MSVC toolchain — so it can't be built here on Windows. Use a prebuilt binary, or build it under MSYS2/MinGW and add it via “Add your own engine.”"
                : raw,
            )
          }
          return
        }
        // Build SUCCEEDED — the binary is good. Register (probe) it, carrying its source
        // provenance for the ADR-088 "newer source → rebuild" check. For a REBUILD, match the
        // existing engine by binPath OR by source repo+branch (a fresh compile can land at a
        // slightly different binPath) and replace it in place (stop it first if it's the
        // running active one) so we re-probe fresh capabilities without a NameTaken clash.
        // A commit-pinned build (req.commit set) is a DELIBERATELY DISTINCT snapshot — it must
        // never match/replace a plain branch-tip build of the same repo+branch (or vice versa),
        // only a prior build pinned to that SAME commit, else A/B-ing an old commit against the
        // current build silently deletes the current one's registration (its files on disk are
        // untouched, but it vanishes from the engine list).
        // A failure HERE keeps the built binary on disk (no GC) so it isn't thrown away.
        const engines = d.registry.list().engines
        const prior =
          engines.find((e) => e.binPath === out.binPath) ??
          engines.find(
            (e) =>
              e.sourceRepo === repoUrl &&
              (e.sourceBranch ?? '') === (branch ?? '') &&
              (e.sourceCommit ?? '') === (commit ?? ''),
          )
        if (prior) {
          if (d.registry.active()?.id === prior.id) await d.manager.stopAndWait()
          try { d.registry.remove(prior.id) } catch { /* already gone */ }
        }
        const eng = (await d.registry.add(prior?.name ?? name ?? '', out.binPath, {
          sourceRepo: repoUrl,
          sourceBranch: branch,
          sourceCommit: commit,
          sourcePatchUrl: patchUrl,
        })).engine
        d.registry.activate(eng.id)
        // A genuinely custom repo (not one of the catalog's own known projects) needs its
        // identity remembered independent of the live registration — see recordCustomSource's
        // own doc comment. A catalog repo already gets equivalent treatment from the /catalog
        // endpoint's own disk scan, so it's deliberately excluded here.
        if (!isCatalogRepo(repoUrl)) {
          d.registry.recordCustomSource({ name: eng.name, binPath: eng.binPath, kind: eng.kind, sourceRepo: repoUrl, sourceBranch: branch, sourceCommit: commit, sourcePatchUrl: patchUrl })
        }
        d.build.log(`Registered "${eng.name}" — built from ${out.commit.slice(0, 8)}.`)
        d.build.done()
      } catch (e) {
        // Registration/probe failed AFTER a successful build: keep the binary (no GC), but
        // tell the user it built yet couldn't be registered so they can retry/inspect.
        d.build.fail(`Built successfully, but couldn't register the engine: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (buildAbort === ac) buildAbort = null
      }
    })()
    return c.json({ accepted: true }, 202)
  })

  // Cancel an in-progress 1-click build (ADR-100). Kills the child compiler/clone.
  app.post('/api/v1/build/cancel', (c) => {
    if (buildAbort) {
      buildAbort.abort()
      return c.json({ ok: true })
    }
    return c.json({ ok: false })
  })

  // Auto-download a CUDA Toolkit from NVIDIA's redistributable archives (ADR-101) when the
  // user has no CUDA installed, so the 1-click build can compile. Streams via the same
  // engineBuild channel (phase 'provisioning'); on success the toolkit's bin dir is added to
  // build.toolchainDirs so the prereq check + build immediately find nvcc. Local-host + Win gated.
  app.post('/api/v1/build/cuda', async (c) => {
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Downloading CUDA is only available on the machine running TurboLLM.')
    if (process.platform !== 'win32')
      return err(c, 409, 'unsupported_platform', 'Automatic CUDA download is currently Windows x86_64 only.')
    const busy = engineWorkBusy(d)
    if (busy) return err(c, 409, 'engine_already_running', busy)
    const dataDir = d.store.dir()
    const ac = new AbortController()
    buildAbort = ac
    d.build.start('CUDA Toolkit')
    d.build.phase('provisioning')
    void (async () => {
      try {
        const tk = await provisionCuda(
          dataDir,
          (p) => d.build.log(p.pct != null ? `${p.message} ${Math.round(p.pct * 100)}%` : p.message),
          ac.signal,
        )
        // Persist the toolkit bin dir so detection + the build find nvcc + the runtime DLLs.
        d.store.update((cfg) => {
          if (!cfg.build.toolchainDirs.includes(tk.binDir)) cfg.build.toolchainDirs.unshift(tk.binDir)
        })
        d.build.log(`CUDA ${tk.version} installed and added to your build environment.`)
        d.build.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          d.build.log('CUDA download cancelled.')
          d.build.fail('CUDA download cancelled.')
        } else {
          d.build.fail(`Could not download CUDA: ${e instanceof Error ? e.message : String(e)}`)
        }
      } finally {
        if (buildAbort === ac) buildAbort = null
      }
    })()
    return c.json({ accepted: true }, 202)
  })

  // Provision the vLLM engine (ADR-044): uv → venv → `uv pip install vllm`, then
  // register as a kind='vllm' engine. 202 + progress via GET /status engineProvision.
  // Not platform-blocked (vLLM fails loudly where unsupported); the catalog marks
  // support level so the UI can warn before the user commits to a multi-GB install.
  // ?update=1 upgrades vllm to the latest release (passes -U to uv pip install).
  app.post('/api/v1/engines/vllm', (c) => {
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('vllm')
        const rt = await ensureVllmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addVllm(`vLLM (${rt.version})`, rt.python, rt.version)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install vLLM: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'vllm' }, 202)
  })

  // Provision the SGLang engine (ADR-120): uv → venv → `uv pip install sglang[all]`,
  // then register as a kind='sglang' engine. 202 + progress via GET /status engineProvision.
  // ?update=1 upgrades sglang to the latest release (passes -U to uv pip install).
  app.post('/api/v1/engines/sglang', (c) => {
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('sglang')
        const rt = await ensureSglangEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addSglang(`SGLang (${rt.version})`, rt.python, rt.version)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install SGLang: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'sglang' }, 202)
  })

  // Provision a catalog fork via GitHub release (ADR-044) — TurboQuant. Downloads
  // the platform-matching prebuilt llama-server, probes it (it IS llama-server
  // compatible), and registers it as a kind='llama-server' engine. 202 + progress
  // via /status. The fork currently ships macOS prebuilts only, so the install is
  // platform-guarded to where an asset actually exists (matches the OS prefilter).
  // ?update=1 removes the existing install dir so the latest release is re-downloaded.
  app.post('/api/v1/engines/turboquant', (c) => {
    const entry = catalogEngine('turboquant')
    if (!entry?.repo) return err(c, 500, 'internal', 'TurboQuant catalog entry is misconfigured.')
    if (!entry.platforms.includes(process.platform)) {
      return err(c, 409, 'unsupported_platform', 'TurboQuant has no prebuilt binary for this operating system yet.')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('turboquant')
        // For update: remove existing dir so provisionTurboquant re-downloads the latest.
        if (upgrade) {
          const tqDir = join(root, 'turboquant')
          if (existsSync(tqDir)) rmSync(tqDir, { recursive: true, force: true })
        }
        // Per-platform resolver: Windows build is on HuggingFace, macOS/Linux on GitHub.
        const bin = await provisionTurboquant(root, entry.repo!, (p) =>
          d.provision.progress(p.phase, p.pct, p.part, p.parts),
        )
        let eng = d.registry.list().engines.find((e) => e.binPath === bin)
        if (!eng) eng = (await d.registry.add('TurboQuant', bin)).engine
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        const msg =
          e instanceof Error && e.message === 'no_release_asset'
            ? 'TurboQuant has no prebuilt binary for this operating system in its latest release.'
            : `Could not install TurboQuant: ${e instanceof Error ? e.message : e}`
        d.provision.fail(msg)
      }
    })()
    return c.json({ accepted: true, engine: 'turboquant' }, 202)
  })

  // Provision KoboldCpp (engine overhaul, Phase 4): download the single platform/GPU-
  // matching binary from its GitHub release, register as a kind='koboldcpp' engine.
  // 202 + progress via /status. ?update=1 removes the existing binary so the latest is
  // re-downloaded. CUDA build is chosen on NVIDIA; portable build elsewhere.
  app.post('/api/v1/engines/koboldcpp', (c) => {
    const entry = catalogEngine('koboldcpp')
    if (!entry?.repo) return err(c, 500, 'internal', 'KoboldCpp catalog entry is misconfigured.')
    if (!entry.platforms.includes(process.platform)) {
      return err(c, 409, 'unsupported_platform', 'KoboldCpp has no prebuilt binary for this operating system yet.')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    const hasNvidia = primaryVendor(getSysInfo()) === 'nvidia'
    void (async () => {
      try {
        d.provision.start('koboldcpp')
        if (upgrade) {
          const dir = koboldcppDir(root)
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        }
        const rt = await ensureKoboldcpp(root, hasNvidia, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts))
        const eng = d.registry.addKoboldcpp(`KoboldCpp (${rt.version})`, rt.binPath, rt.version)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        const msg =
          e instanceof Error && e.message === 'no_release_asset'
            ? 'KoboldCpp has no prebuilt binary for this operating system/architecture in its latest release.'
            : `Could not install KoboldCpp: ${e instanceof Error ? e.message : e}`
        d.provision.fail(msg)
      }
    })()
    return c.json({ accepted: true, engine: 'koboldcpp' }, 202)
  })

  // Provision llamafile (engine overhaul, Phase 4): download the single portable
  // executable from its GitHub release, register as a kind='llamafile' engine. 202 +
  // progress via /status. ?update=1 removes the existing binary so the latest is
  // re-downloaded.
  app.post('/api/v1/engines/llamafile', (c) => {
    const entry = catalogEngine('llamafile')
    if (!entry?.repo) return err(c, 500, 'internal', 'llamafile catalog entry is misconfigured.')
    if (!entry.platforms.includes(process.platform)) {
      return err(c, 409, 'unsupported_platform', 'llamafile is not available for this operating system yet.')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    void (async () => {
      try {
        d.provision.start('llamafile')
        if (upgrade) {
          const dir = llamafileDir(root)
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        }
        const rt = await ensureLlamafile(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts))
        const eng = d.registry.addLlamafile(`llamafile (${rt.version})`, rt.binPath, rt.version)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        const msg =
          e instanceof Error && e.message === 'no_release_asset'
            ? 'llamafile has no downloadable binary in its latest release.'
            : `Could not install llamafile: ${e instanceof Error ? e.message : e}`
        d.provision.fail(msg)
      }
    })()
    return c.json({ accepted: true, engine: 'llamafile' }, 202)
  })

  app.post('/api/v1/engines', async (c) => {
    // Adding an engine probes (executes) a caller-supplied binary — a local-admin action.
    // Refuse it from non-loopback callers even with a key (defense in depth).
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Engines can only be added from the machine running TurboLLM.')
    const b = await body<{ name?: string; binPath?: string; sourceRepo?: string; sourceBranch?: string; sourceCommit?: string }>(c)
    if (!b.binPath || !b.binPath.trim()) return err(c, 400, 'invalid_config_value', 'binPath is required.')
    try {
      const { engine, warning } = await d.registry.add(b.name ?? '', b.binPath, {
        sourceRepo: b.sourceRepo,
        sourceBranch: b.sourceBranch,
        sourceCommit: b.sourceCommit,
      })
      // Same custom-source tracking as the 1-click build completion above — a manually
      // pointed-at binary (with or without a sourceRepo) is just as much a "custom engine"
      // as a self-service build, and deserves the same Disable-survives-as-Enable treatment.
      if (!isCatalogRepo(b.sourceRepo)) {
        d.registry.recordCustomSource({ name: engine.name, binPath: engine.binPath, kind: engine.kind, sourceRepo: b.sourceRepo, sourceBranch: b.sourceBranch, sourceCommit: b.sourceCommit })
      }
      // `probe_no_version` is non-blocking (spec 03 §2): the engine is saved, but
      // the response carries a warning flag so the dialog can prompt the user.
      return c.json({ ...engine, warning: warning ?? null }, 201)
    } catch (e) {
      if (e instanceof NameTakenError) return err(c, 400, 'name_already_taken', e.message)
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return err(c, 500, 'internal', (e as Error).message)
    }
  })

  // Guided add (engine overhaul, Phase 3): scan a chosen FOLDER (or a binary file)
  // for the server binary and probe it — read-only preflight for the Add-engine
  // flow. Registration still happens via POST /api/v1/engines. `{found:false}` (200)
  // when no binary turns up; ProbeError → 400 so wrong-OS / timeout reach the UI.
  app.post('/api/v1/engines/scan', async (c) => {
    // Scanning probes (executes) the binary it finds — gate to the local host so a LAN
    // client can't trigger arbitrary execution by pointing at any path (matches POST /engines).
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Engine scanning is only available on the machine running TurboLLM.')
    const b = await body<{ path?: string }>(c)
    const path = (b.path ?? '').trim()
    if (!path) return err(c, 400, 'invalid_config_value', 'path is required.')
    const binPath = resolveServerBinary(path)
    if (!binPath) return c.json({ found: false })
    try {
      const { version, capabilities } = await probe(binPath)
      return c.json({
        found: true,
        binPath,
        version,
        capabilities,
        suggestedName: suggestEngineName(binPath, version),
      })
    } catch (e) {
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return err(c, 500, 'internal', (e as Error).message)
    }
  })

  app.put('/api/v1/engines/:id', async (c) => {
    const b = await body<{ name?: string; sourceRepo?: string; sourceBranch?: string }>(c)
    const id = c.req.param('id')
    try {
      // Source-repo provenance (ADR-088): a user can attach the GitHub repo an existing
      // build came from so TurboLLM can detect "newer source available → rebuild". Set
      // it (alone or alongside a rename) when either source field is present.
      if (b.sourceRepo !== undefined || b.sourceBranch !== undefined) {
        d.registry.setSource(id, { sourceRepo: b.sourceRepo, sourceBranch: b.sourceBranch })
      }
      // Only rename when a name was supplied (rename rejects an empty name); a
      // source-only PUT just returns the updated engine.
      if (b.name !== undefined && b.name.trim()) {
        return c.json(d.registry.rename(id, b.name))
      }
      const eng = d.registry.get(id)
      if (!eng) throw new NotFoundError()
      return c.json(eng)
    } catch (e) {
      return regErr(c, e)
    }
  })

  // Forget a DISABLED custom engine's remembered identity (customEngineSources) — no live
  // registry entry to delete (that's the whole point: it's disabled, not registered), so this
  // is distinct from DELETE /api/v1/engines/:id?purge=1 below. Never touches files on disk.
  // Registered BEFORE the :id route below — Hono matches in registration order, and :id would
  // otherwise swallow "custom-sources" as its own param value.
  app.delete('/api/v1/engines/custom-sources/:key', (c) => {
    // c.req.param() already URL-decodes path segments (Hono) — decoding again corrupts any
    // key containing a literal '%' (the binPath fallback key can) and throws on an invalid
    // escape, since a normal key's second decode is a harmless no-op that hid this on the
    // happy path.
    d.registry.forgetCustomSource(c.req.param('key'))
    return c.json({ ok: true })
  })

  app.delete('/api/v1/engines/:id', (c) => {
    const id = c.req.param('id')
    const { activeEngineId } = d.registry.list()
    if (id === activeEngineId && engineBusy(d)) {
      return err(c, 409, 'engine_in_use', 'Stop the engine before removing it.')
    }
    const purge = c.req.query('purge') === '1'
    // Set by the frontend's custom-engine Disable (never alongside purge): a custom engine
    // added before customEngineSources tracking existed has no recorded identity, so a plain
    // Disable would otherwise vanish it with no Enable path back. recordCustomSource is a
    // record-or-refresh, so this is a no-op when a record already exists.
    const recordSource = c.req.query('recordSource') === '1'
    try {
      const eng = d.registry.get(id)
      if (recordSource && !purge && eng) {
        d.registry.recordCustomSource({
          name: eng.name, binPath: eng.binPath, kind: eng.kind,
          sourceRepo: eng.sourceRepo, sourceBranch: eng.sourceBranch, sourceCommit: eng.sourceCommit, sourcePatchUrl: eng.sourcePatchUrl,
        })
      }
      d.registry.remove(id)
      // ?purge=1: also delete the engine's installed files from disk.
      // Only removes dirs under {dataDir}/engines/ — never touches model dirs.
      if (purge && eng) {
        const enginesRoot = join(d.store.dir(), 'engines')
        const purgeDir = engineInstallDir(eng, enginesRoot)
        if (purgeDir && existsSync(purgeDir)) {
          rmSync(purgeDir, { recursive: true, force: true })
        }
        // A purge is a real delete, not a Disable — drop any remembered custom-engine
        // identity too, so a purged engine doesn't linger as a "disabled" card with a
        // now-broken Enable (its files are gone). A plain Disable (no purge) leaves this
        // record alone; that's the whole point of recordCustomSource.
        d.registry.forgetCustomSource(customSourceKey(eng))
      }
      return c.json({ ok: true })
    } catch (e) {
      return regErr(c, e)
    }
  })

  app.post('/api/v1/engines/:id/activate', (c) => {
    if (engineBusy(d)) return err(c, 409, 'engine_running', 'Stop the running engine before switching the active engine.')
    try {
      d.registry.activate(c.req.param('id'))
      // Switching engines invalidates any prior load error (e.g. a failed vLLM load on an
      // engine that can't serve here) — clear it so the UI doesn't show a stale error.
      d.manager.clearError()
      return c.json(d.registry.get(c.req.param('id')) ?? {})
    } catch (e) {
      return regErr(c, e)
    }
  })

  app.post('/api/v1/engines/:id/reprobe', async (c) => {
    try {
      return c.json(await d.registry.reprobe(c.req.param('id')))
    } catch (e) {
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return regErr(c, e)
    }
  })

  // ---- honest per-engine update status (ADR-085, Phase 6) ----
  // Per-engine installed/latest/hasUpdate/checkedAt(/error). Offline-first: works
  // without network by returning each engine's cached or "couldn't check" state — it
  // NEVER fabricates a "latest" it didn't actually fetch. `?refresh=1` forces a live
  // re-check (otherwise the cache is served and a background refresh is kicked off).
  app.get('/api/v1/engines/updates', async (c) => {
    if (!d.updates) return c.json({ updates: {}, policies: {} })
    const engines = d.registry.list().engines
    const refresh = c.req.query('refresh') === '1'
    d.updates.prune(new Set(engines.map((e) => e.id)))
    if (refresh) {
      await d.updates.checkAll(engines, AbortSignal.timeout(20_000)).catch(() => {})
    } else {
      // Kick a background check for any engine we've never checked, but return immediately.
      const unchecked = engines.filter((e) => !d.updates!.get(e.id))
      if (unchecked.length) void d.updates.checkAll(unchecked).catch(() => {})
    }
    const updates = d.updates.all()
    // Surface each engine's current policy alongside (default 'notify').
    const policies: Record<string, string> = {}
    for (const e of engines) policies[e.id] = normalizeUpdatePolicy(e.updatePolicy)
    return c.json({ updates, policies })
  })

  // ---- app self-update check (F-006, ADR-031) ----
  // Is a newer TurboLLM published on npm than the running version? Informational only —
  // npm does the upgrade (`npm i -g turbollm`); we never auto-update the app. Offline-first:
  // serves the cached answer and NEVER fabricates a "latest" it didn't fetch. Non-blocking —
  // a stale (or `?refresh=1`) cache kicks a background re-check and returns the cache now.
  app.get('/api/v1/app/update', (c) => {
    const fallback = { installed: d.version, latest: null, hasUpdate: false, checkedAt: new Date().toISOString(), comparable: false }
    if (!d.appUpdates) return c.json(fallback)
    const refresh = c.req.query('refresh') === '1'
    if (refresh || d.appUpdates.isStale()) {
      void d.appUpdates.check(AbortSignal.timeout(10_000)).catch(() => {})
    }
    return c.json(d.appUpdates.get() ?? fallback)
  })

  // Set an engine's per-engine auto-update policy (off | notify | auto). Default notify.
  app.put('/api/v1/engines/:id/update-policy', async (c) => {
    const b = await body<{ policy?: string }>(c)
    if (b.policy !== 'off' && b.policy !== 'notify' && b.policy !== 'auto') {
      return err(c, 400, 'invalid_config_value', 'policy must be off, notify, or auto.')
    }
    try {
      return c.json(d.registry.setUpdatePolicy(c.req.param('id'), b.policy))
    } catch (e) {
      return regErr(c, e)
    }
  })

  // ---- filesystem browser (spec 03 §9): pick an engine binary/folder by navigating
  // the disk from the browser. LOCAL-ONLY (isLocalRequest, matching /engines/scan): a
  // page on the LAN — even with a valid key — cannot read the filesystem through the
  // daemon; only the browser on the machine running TurboLLM can. Deliberately NOT
  // home-confined, so an engine that lives on another drive (D:\) or outside home is
  // reachable — the local user already picks (and executes) arbitrary binaries via scan.
  app.get('/api/v1/fs/browse', (c) => {
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Browsing the filesystem is only available on the machine running TurboLLM.')
    const raw = (c.req.query('path') ?? '').trim()
    // Windows "This PC": a virtual root above the drive letters, so the user can hop
    // between drives (C:\, D:\, …). Reached by going "up" from a drive root.
    if (raw === FS_DRIVES_ROOT && process.platform === 'win32') {
      return c.json({ path: FS_DRIVES_ROOT, parent: null, entries: listWindowsDrives() })
    }
    // Default to the home dir (a sensible starting point); any path is allowed.
    const target = raw ? resolve(raw) : homedir()
    // Canonicalize symlinks; fall back to the lexical path if it doesn't exist yet
    // (it then fails the readdir below cleanly).
    let real: string
    try {
      real = realpathSync(target)
    } catch {
      real = target
    }
    let entries: { name: string; path: string; isDir: boolean }[]
    try {
      entries = readdirSync(real, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.')) // hide dotfiles
        .map((d) => {
          // A dirent can be a symlink — resolve its target type so symlinked dirs
          // still navigate. Errors (dangling links) fall back to file.
          let isDir = d.isDirectory()
          if (d.isSymbolicLink()) {
            try {
              isDir = statSync(join(real, d.name)).isDirectory()
            } catch {
              isDir = false
            }
          }
          return { name: d.name, path: join(real, d.name), isDir }
        })
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    } catch {
      return err(c, 400, 'fs_read_failed', 'Could not read that folder (permission denied or not a directory).')
    }
    // Parent: the containing dir; at a filesystem/drive root, go up to the Windows drive
    // list (so the user can switch drives) or stop (null) on a single-root OS.
    const parentDir = dirname(real)
    const parent =
      parentDir === real ? (process.platform === 'win32' ? FS_DRIVES_ROOT : null) : parentDir
    return c.json({ path: real, parent, entries })
  })

  // ---- git info for the Code repo picker: current branch + known local branches ----
  // LOCAL-ONLY, same gate as fs/browse — a LAN client never gets to run git on this
  // machine's disk. Best-effort: any folder that isn't a git repo (or has no commits
  // yet) just reports isRepo:false rather than erroring, so the picker still works for
  // a plain scratch folder.
  app.get('/api/v1/fs/git-branch', (c) => {
    if (!isLocalRequest(c, d))
      return err(c, 403, 'forbidden', 'Reading git info is only available on the machine running TurboLLM.')
    const raw = (c.req.query('path') ?? '').trim()
    if (!raw) return err(c, 400, 'invalid_input', 'path is required.')
    const cwd = resolve(raw)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return c.json({ isRepo: false, branch: '', branches: [] })
    }
    const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim()
    try {
      // Confirms we're inside a real work tree (not just a bare/.git dir).
      if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return c.json({ isRepo: false, branch: '', branches: [] })
      let branch = ''
      try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) } catch { /* unborn HEAD (no commits yet) */ }
      if (branch === 'HEAD') branch = '' // detached HEAD — no meaningful branch name
      let branches: string[] = []
      try {
        branches = git(['branch', '--format=%(refname:short)']).split('\n').map((s) => s.trim()).filter(Boolean)
      } catch { /* no branches yet */ }
      return c.json({ isRepo: true, branch, branches })
    } catch {
      return c.json({ isRepo: false, branch: '', branches: [] })
    }
  })

  // ---- lifecycle (A2) ----
  app.post('/api/v1/engine/start', async (c) => {
    const b = await body<{
      modelKey?: string
      profileOverrides?: Partial<LoadProfile>
      modelPath?: string
      extraArgs?: string[]
      modelName?: string
    }>(c)
    const active = d.registry.active()
    if (!active) return err(c, 409, 'no_active_engine', 'Register and select an engine first.')
    // ComfyUI guard: while ComfyUI is rendering it owns the GPU, so refuse to load a
    // model (it would thrash/OOM VRAM). The guard reloads automatically once idle.
    if (d.comfy?.isBlocked()) return err(c, 409, 'comfyui_busy', 'ComfyUI is rendering — model loading is paused until its queue finishes.')
    // Kill switch: loading a model takes over the engine — cancel any auto-tune and abort
    // in-flight chats, then wait for auto-tune to release the engine so the load can't race
    // the runner's teardown.
    d.bench.cancel()
    abortAllInFlightChats()
    await d.bench.waitIdle()
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
        return err(
          c,
          409,
          'engine_model_mismatch',
          'Rapid-MLX cannot load models with an audio tower (a confirmed upstream mlx-vlm bug) — switch to the MLX engine instead.',
        )
      }
      let opts: StartOpts
      if (entry.format !== 'gguf') {
        // MLX / vLLM: the model dir is the launch target (no llama.cpp -ngl/ctx knobs).
        // MLX honors sampling defaults; vLLM honors its own load controls (F-027,
        // --max-model-len/--gpu-memory-utilization/--dtype/…) built via vllmProfileToArgs,
        // plus the multi-GPU shard count (ADR-054) mapped to --tensor-parallel-size below.
        const savedProfile = getModelProfile(cfg, entry.key, active.id) as Partial<LoadProfile> | undefined
        const extraArgs =
          active.kind === 'mlx'
            ? mlxSamplingArgs(savedProfile?.sampling)
            : active.kind === 'vllm'
              ? vllmProfileToArgs(resolveProfile(entry, sys, savedProfile, b.profileOverrides, cfg.modelDefaults), entry.nativeCtx)
              : []
        opts = {
          engine: active,
          model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: entry.vision },
          modelPath: entry.path,
          extraArgs,
          tensorParallelSize: savedProfile?.gpu?.tensorParallelSize,
          preferredPort: savedProfile?.port,
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
            : profileToArgs(profile, entry, active.capabilities, sys.cores)
        opts = {
          engine: active,
          model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
          modelPath: entry.path,
          extraArgs,
          preferredPort: profile.port,
        }
      }
      // Single chokepoint (rule 3): load() stops the current model, runs the reverse
      // gate (F-011: ask ComfyUI to free VRAM first), spawns, and waits for readiness —
      // all under the global load lock so this can't race another load. Fire-and-forget:
      // the UI polls /status for the starting→running/error transition, so we return 202
      // immediately rather than blocking the HTTP request on a multi-second load.
      void d.manager
        .load(opts, { beforeStart: () => d.comfy?.freeComfyUIBeforeLoad() ?? Promise.resolve() })
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
    const opts: StartOpts = { engine: active, model: deriveModel(modelPath, name, extra), modelPath, extraArgs: extra }
    // Same single-chokepoint, fire-and-forget load as the resolved-model branch above.
    void d.manager
      .load(opts, { beforeStart: () => d.comfy?.freeComfyUIBeforeLoad() ?? Promise.resolve() })
      .catch((e) => console.warn(`engine load failed: ${e}`))
    return c.json({ ok: true }, 202)
  })

  app.post('/api/v1/engine/stop', (c) => {
    // Kill switch: stopping the engine cancels auto-tune and aborts in-flight chats too —
    // they all depend on the engine that's going away.
    d.bench.cancel()
    abortAllInFlightChats()
    d.manager.stop()
    return c.json({ ok: true }, 202)
  })

  app.post('/api/v1/engine/restart', (c) => {
    // Kill switch: cancel auto-tune + abort chats, wait for the runner to release the engine,
    // then restart — so the reload doesn't race auto-tune's teardown.
    d.bench.cancel()
    abortAllInFlightChats()
    void (async () => {
      await d.bench.waitIdle()
      await d.manager.restart()
    })().catch(() => {})
    return c.json({ ok: true }, 202)
  })

  // ---- ComfyUI GPU gate (push coordination) ----
  // The installed ComfyUI node calls these. acquire() blocks until VRAM is freed so
  // ComfyUI can safely start; release() reloads the model. Both are loopback calls
  // from the local ComfyUI process (lanAuth exempts loopback — no key needed).
  app.post('/api/v1/comfyui/acquire', async (c) => {
    if (!d.comfy) return c.json({ ok: true, held: false })
    await d.comfy.acquire()
    return c.json({ ok: true, ...d.comfy.snapshot() })
  })

  app.post('/api/v1/comfyui/release', async (c) => {
    if (d.comfy) await d.comfy.release()
    return c.json({ ok: true })
  })

  // In-app installer (ADR: one-time setup): write the push-gate node into the user's
  // ComfyUI custom_nodes dir, with TurboLLM's own URL baked in. `path` is the ComfyUI
  // folder (or its custom_nodes dir). The daemon's actual reachable port comes from the
  // request URL, so it's correct even when started with --port.
  app.post('/api/v1/comfyui/install', async (c) => {
    const b = await body<{ path?: string }>(c)
    const raw = (b.path ?? '').trim()
    if (!raw) return err(c, 400, 'invalid_config_value', 'Enter the path to your ComfyUI folder.')

    const root = resolve(raw)
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return err(c, 400, 'invalid_config_value', 'That folder does not exist.')
    }
    // Accept either the ComfyUI root (contains custom_nodes) or the custom_nodes dir.
    let customNodes: string
    if (basename(root).toLowerCase() === 'custom_nodes') customNodes = root
    else if (existsSync(join(root, 'custom_nodes'))) customNodes = join(root, 'custom_nodes')
    else {
      return err(c, 400, 'invalid_config_value', "No 'custom_nodes' folder here. Point me at your ComfyUI folder or its custom_nodes folder.")
    }

    // TurboLLM's reachable origin from ComfyUI's perspective: same machine → loopback,
    // on whatever port this request arrived on (honors a --port override).
    const reqUrl = new URL(c.req.url)
    const port = reqUrl.port || (reqUrl.protocol === 'https:' ? '443' : '80')
    const base = `http://127.0.0.1:${port}`

    const gateDir = join(customNodes, 'turbollm_gate')
    try {
      mkdirSync(gateDir, { recursive: true })
      writeFileSync(join(gateDir, '__init__.py'), gateNodeSource(base))
    } catch (e) {
      return err(c, 500, 'fs_write_failed', `Could not write the gate node: ${e instanceof Error ? e.message : e}`)
    }
    d.store.update((x) => {
      x.comfyui.gatePath = gateDir
    })
    return c.json({ ok: true, path: gateDir, base, note: 'Restart ComfyUI to activate the gate.' })
  })

  // Remove the installed gate node and forget its path.
  app.post('/api/v1/comfyui/uninstall', (c) => {
    const dir = d.store.snapshot().comfyui.gatePath
    if (dir && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        return err(c, 500, 'fs_write_failed', `Could not remove the gate node: ${e instanceof Error ? e.message : e}`)
      }
    }
    d.store.update((x) => {
      x.comfyui.gatePath = ''
    })
    return c.json({ ok: true })
  })

  // ---- daemon self-restart (spec 08 §2) ----
  // Re-execs the whole daemon so port / LAN-bind changes take effect. Schedule on a
  // short timeout so this 202 flushes before the listen socket is torn down; the UI
  // then shows a "Restarting…" overlay and polls /status until the new process is up.
  app.post('/api/v1/daemon/restart', (c) => {
    if (!d.requestRestart) {
      return err(c, 501, 'not_supported', 'Daemon restart is not available in this run mode.')
    }
    const restart = d.requestRestart
    setTimeout(() => restart(), 200).unref()
    return c.json({ ok: true, restarting: true }, 202)
  })

  app.get('/api/v1/engine/logs', (c) => {
    const tail = Math.min(Number(c.req.query('tail')) || 200, 2000)
    return c.json({ lines: readTail(d.manager.logPath(), tail) })
  })

  app.get('/api/v1/engine/logs/stream', (c) =>
    streamSSE(c, async (stream) => {
      let sent = 0
      let aborted = false
      let ticks = 0
      stream.onAbort(() => {
        aborted = true
      })
      while (!aborted) {
        const path = d.manager.logPath()
        if (path && existsSync(path)) {
          const lines = readFileSync(path, 'utf8').split('\n')
          for (; sent < lines.length - 1; sent++) {
            await stream.writeSSE({ event: 'line', data: JSON.stringify({ line: lines[sent].replace(/\r$/, '') }) })
          }
        }
        if (++ticks % 37 === 0) await stream.writeSSE({ data: '', event: 'ping' })
        await stream.sleep(400)
      }
    }),
  )

  // ---- auto-benchmark + auto-tune (M3, spec 09 §1) ----
  // Start a sweep for a model. 202 + poll /status `bench`. 409 when a run is already
  // active or the engine is busy (the UI offers "Stop & benchmark" to free it first).
  app.post('/api/v1/bench', async (c) => {
    const b = await body<{ modelKey?: string; base?: Partial<LoadProfile> }>(c)
    const key = (b.modelKey ?? '').trim()
    if (!key) return err(c, 400, 'invalid_config_value', 'modelKey is required.')
    // A sweep loads the model repeatedly — same GPU contention as a normal load.
    if (d.comfy?.isBlocked()) return err(c, 409, 'comfyui_busy', 'ComfyUI is rendering — benchmarking is paused until its queue finishes.')
    // Reverse gate (F-011): a sweep loads the model repeatedly, so free ComfyUI's VRAM
    // once before it begins — the sweep then owns the GPU. No-op unless the reverse gate
    // is enabled and ComfyUI is idle; non-fatal on failure (benchmarks anyway).
    await d.comfy?.freeComfyUIBeforeLoad()
    try {
      // `base` is the user's current config (dialog draft): auto-tune fixes its ctx +
      // KV quant and sweeps only offload on top (spec 09 §1, honoring the user's config).
      d.bench.start(key, b.base && typeof b.base === 'object' ? b.base : undefined)
      return c.json({ accepted: true }, 202)
    } catch (e) {
      return benchError(c, e)
    }
  })

  // Cancel the active run: stops after the current step, leaves the engine stopped,
  // keeps the partial results (spec 09 AC#3). Always 200 (no-op when none running).
  app.post('/api/v1/bench/cancel', (c) => {
    d.bench.cancel()
    return c.json({ ok: true })
  })

  // Persist the finished auto-tune's winning profile (the user clicked Save in the results dialog).
  app.post('/api/v1/bench/save', (c) => {
    const saved = d.bench.saveResult()
    if (!saved) return err(c, 409, 'no_bench_result', 'No auto-tune result to save.')
    return c.json({ ok: true })
  })

  app.get('/api/v1/bench/log', (c) => {
    const log = d.bench.getLog()
    if (!log) return err(c, 404, 'no_bench_log', 'No auto-tune log available.')
    const slug = log.modelKey.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0, 60)
    c.header('Content-Disposition', `attachment; filename="autotune-${slug}-${log.startedAt.slice(0, 10)}.json"`)
    return c.json(log)
  })

  // ---- models (A3, spec 04) ----
  app.get('/api/v1/models', (c) => {
    const { models, scanning, lastScanAt } = d.scanner.list()
    const lastTps = d.db.lastGenTpsByModel()
    return c.json({ models: models.map((m) => overlayModel(m, d, lastTps)), scanning, lastScanAt })
  })

  app.post('/api/v1/models/rescan', (c) => {
    void d.scanner.rescan()
    return c.json({ ok: true }, 202)
  })

  // Delete a model's file(s) from disk (spec 05). Split GGUFs delete all shards.
  // Blocked while the model is the one currently loaded in the running engine.
  app.delete('/api/v1/models/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const e = d.scanner.get(key)
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    const ms = d.manager.status()
    const loadedKey = ms.state === 'running' || ms.state === 'starting' ? ms.model?.key : undefined
    if (loadedKey === e.path || loadedKey === e.key) {
      return err(c, 409, 'model_loaded', 'This model is currently loaded. Eject it before deleting.')
    }
    try {
      const deleted = await d.scanner.delete(key)
      return c.json({ ok: true, deleted })
    } catch (e2) {
      if (e2 instanceof ScannerError) return err(c, 404, e2.code, e2.message)
      return err(c, 500, 'delete_failed', (e2 as Error).message)
    }
  })

  app.get('/api/v1/models/:key', (c) => {
    const e = d.scanner.get(decodeURIComponent(c.req.param('key')))
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    const sys = getSysInfo()
    const snap = d.store.snapshot()
    // Per-engine profile (issue #35): the detail dialog passes ?engine=<id> for the engine
    // it's showing; fall back to the active engine, then the '*' migrated/global profile.
    const engineId = c.req.query('engine') || d.registry.active()?.id || '*'
    const saved = getModelProfile(snap, e.key, engineId) as Partial<LoadProfile> | undefined
    const profile = resolveProfile(e, sys, saved, undefined, snap.modelDefaults)
    // `gpu` (first GPU) kept for back-compat; `gpus` (full list) drives the multi-GPU
    // split controls (ADR-054).
    return c.json({ ...overlayModel(e, d), profile, vramFit: estimateVram(profile, e, sys), gpu: sys.gpus[0] ?? null, gpus: sys.gpus, cores: sys.cores })
  })

  app.put('/api/v1/models/:key/profile', async (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const e = d.scanner.get(key)
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    const p = await body<LoadProfile>(c)
    if (!p || typeof p.ctx !== 'number' || p.ctx < 256) {
      return err(c, 400, 'invalid_profile_value', 'ctx must be at least 256.')
    }
    // Multi-GPU split settings (ADR-054). Validate only when present so older clients
    // that omit `gpu` still save cleanly.
    if (p.gpu) {
      const g = p.gpu
      if (!['layer', 'row', 'none'].includes(g.splitMode)) {
        return err(c, 400, 'invalid_profile_value', 'gpu.splitMode must be layer, row, or none.')
      }
      if (!Array.isArray(g.tensorSplit) || g.tensorSplit.some((n) => typeof n !== 'number' || !(n >= 0))) {
        return err(c, 400, 'invalid_profile_value', 'gpu.tensorSplit must be an array of non-negative numbers.')
      }
      if (!Number.isInteger(g.mainGpu) || g.mainGpu < -1) {
        return err(c, 400, 'invalid_profile_value', 'gpu.mainGpu must be an integer ≥ -1.')
      }
      if (!Number.isInteger(g.tensorParallelSize) || g.tensorParallelSize < 1) {
        return err(c, 400, 'invalid_profile_value', 'gpu.tensorParallelSize must be an integer ≥ 1.')
      }
    }
    // Per-engine profile (issue #35): save into the slot for the engine the client is
    // editing (?engine=<id>), falling back to the active engine, then the '*' fallback.
    const engineId = c.req.query('engine') || d.registry.active()?.id || '*'
    d.store.update((cfg) => {
      setModelProfile(cfg, key, engineId, p)
    })
    return c.json(p)
  })

  app.post('/api/v1/models/:key/profile/reset', (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    // Per-engine profile (issue #35): reset only the edited engine's slot (?engine=<id>),
    // falling back to the active engine, then the '*' fallback.
    const engineId = c.req.query('engine') || d.registry.active()?.id || '*'
    d.store.update((cfg) => {
      deleteModelProfile(cfg, key, engineId)
    })
    return c.json({ ok: true })
  })

  app.get('/api/v1/sysinfo', (c) => c.json(getSysInfo()))

  // ── daemon settings (UI-exposed subset) ──
  app.get('/api/v1/settings', (c) => c.json(settingsPayload(d)))

  app.patch('/api/v1/settings', async (c) => {
    const b = await body<{
      idleTtlMinutes?: number
      port?: number
      theme?: string
      autoGenerateTitles?: boolean
      autoMemoryEnabled?: boolean
      openBrowserOnStart?: boolean
      autoLoadOnStart?: boolean
      vramHeadroomMb?: number
      lanBind?: boolean
      requireApiKey?: boolean
      telemetryLevel?: string
      modelDefaults?: { ctx?: number; ngl?: number; imageMaxTokens?: number; maxTokens?: number }
      hfToken?: string
      comfyui?: { enabled?: boolean; url?: string; reverseGate?: boolean }
      gateway?: { autoSwap?: boolean; keepN?: number }
      tavilyApiKey?: string
      search?: { provider?: string; tavilyApiKey?: string; kagiApiKey?: string; searxngUrl?: string }
      build?: { toolchainDirs?: string[] }
      code?: { agentsMdProjectCandidates?: string[]; agentsMdGlobalCandidates?: string[] }
      toolPolicies?: Record<string, string>
      autoAllowAll?: boolean
      cloudDeploy?: { runpodTemplateId?: string }
      experimental?: { memory?: boolean; code?: boolean; cloudDeploy?: boolean }
    }>(c)

    const updates: Record<string, unknown> = {}
    if (b.idleTtlMinutes !== undefined) {
      const v = Number(b.idleTtlMinutes)
      if (!Number.isFinite(v) || v < 0) return err(c, 400, 'invalid_config_value', 'idleTtlMinutes must be a non-negative number.')
      updates.idleTtlMinutes = v
    }
    // Listen port (spec 08 §2). Takes effect on the next daemon restart; the UI shows
    // a "restart required" note. config.validate() also enforces the 1024–65535 floor.
    if (b.port !== undefined) {
      const v = Number(b.port)
      // config.validate() enforces 1024–65535 and would throw on update() otherwise;
      // reject out-of-range here so the client gets a clean 400, not a 500.
      if (!Number.isInteger(v) || v < 1024 || v > 65535) return err(c, 400, 'invalid_config_value', 'port must be 1024–65535.')
      updates.port = v
    }
    if (b.theme !== undefined) {
      if (!['system', 'light', 'dark'].includes(b.theme)) return err(c, 400, 'invalid_config_value', 'theme must be system, light, or dark.')
      updates.theme = b.theme
    }
    if (b.autoGenerateTitles !== undefined) updates.autoGenerateTitles = !!b.autoGenerateTitles
    if (b.autoMemoryEnabled !== undefined) updates.autoMemoryEnabled = !!b.autoMemoryEnabled
    if (b.openBrowserOnStart !== undefined) updates.openBrowserOnStart = !!b.openBrowserOnStart

    // VRAM headroom slider for auto-tune (bench.ts's overHeadroom). config.validate() also
    // enforces this range and would throw on update() otherwise; reject here for a clean 400.
    let vramHeadroomMb: number | undefined
    if (b.vramHeadroomMb !== undefined) {
      const v = Number(b.vramHeadroomMb)
      // VRAM_HEADROOM_SPILL_MB (0) is a distinct, valid opt-in value — not part of the
      // MIN_MB–MAX_MB safety-margin range, but not out-of-range either.
      const valid = v === VRAM_HEADROOM_SPILL_MB || (v >= VRAM_HEADROOM_MIN_MB && v <= VRAM_HEADROOM_MAX_MB)
      if (!Number.isFinite(v) || !valid) {
        return err(c, 400, 'invalid_config_value', `vramHeadroomMb must be ${VRAM_HEADROOM_SPILL_MB} (allow VRAM spill) or ${VRAM_HEADROOM_MIN_MB}–${VRAM_HEADROOM_MAX_MB}.`)
      }
      vramHeadroomMb = Math.round(v)
    }
    // LAN expose toggle (spec 08 §2). Persist only; auto daemon-restart is deferred —
    // the UI tells the user to restart to apply.
    if (b.lanBind !== undefined) updates.lanBind = !!b.lanBind
    // Require-API-key toggle (spec 06 §5). Off → open/unauthenticated LAN access.
    if (b.requireApiKey !== undefined) updates.requireApiKey = !!b.requireApiKey

    // Telemetry consent level (spec 09 §3): off | anon | full. Validate the enum.
    let telemetryLevel: string | undefined
    if (b.telemetryLevel !== undefined) {
      if (!['off', 'anon', 'full'].includes(b.telemetryLevel)) {
        return err(c, 400, 'invalid_config_value', 'telemetryLevel must be off, anon, or full.')
      }
      telemetryLevel = b.telemetryLevel
    }

    // Global model defaults (spec 05 §3): validate the supplied fields; missing
    // fields keep their current value (partial patch).
    const md = b.modelDefaults
    const mdUpdates: { ctx?: number; ngl?: number; imageMaxTokens?: number; maxTokens?: number } = {}
    if (md) {
      if (md.ctx !== undefined) {
        const v = Number(md.ctx)
        if (!Number.isFinite(v) || v < 256) return err(c, 400, 'invalid_config_value', 'modelDefaults.ctx must be at least 256.')
        mdUpdates.ctx = Math.floor(v)
      }
      if (md.ngl !== undefined) {
        const v = Number(md.ngl)
        if (!Number.isFinite(v) || v < 0 || v > 99) return err(c, 400, 'invalid_config_value', 'modelDefaults.ngl must be 0–99.')
        mdUpdates.ngl = Math.floor(v)
      }
      if (md.imageMaxTokens !== undefined) {
        const v = Number(md.imageMaxTokens)
        if (!Number.isFinite(v) || v < 0) return err(c, 400, 'invalid_config_value', 'modelDefaults.imageMaxTokens must be a non-negative number.')
        mdUpdates.imageMaxTokens = Math.floor(v)
      }
      if (md.maxTokens !== undefined) {
        const v = Number(md.maxTokens)
        if (!Number.isFinite(v) || v < 0) return err(c, 400, 'invalid_config_value', 'modelDefaults.maxTokens must be a non-negative number (0 = unlimited).')
        mdUpdates.maxTokens = Math.floor(v)
      }
    }

    // ComfyUI coordination: the master toggle + the reverse-gate fields (F-011) are set
    // here — the gate node's install path is owned by the /comfyui/install + /uninstall
    // endpoints. `url` is validated by config.validate() (empty or http(s):// origin);
    // reject a malformed origin here so the client gets a clean 400, not a 500.
    // KV prompt-cache persistence (F-014, cachePersist) is PARKED (ADR-053): the code is
    // kept but intentionally not exposed — no Settings toggle and not writable here, so the
    // product never enables it. It defaults off and is only reachable by hand-editing
    // config.json. See src/engines/slot-cache.ts.
    const cuUpdates: { enabled?: boolean; url?: string; reverseGate?: boolean } = {}
    if (b.comfyui?.enabled !== undefined) cuUpdates.enabled = !!b.comfyui.enabled
    if (b.comfyui?.reverseGate !== undefined) cuUpdates.reverseGate = !!b.comfyui.reverseGate
    if (b.comfyui?.url !== undefined) {
      const u = b.comfyui.url.trim()
      if (u && !/^https?:\/\//i.test(u)) {
        return err(c, 400, 'invalid_config_value', 'comfyui.url must be an http(s):// origin (e.g. http://127.0.0.1:8188).')
      }
      cuUpdates.url = u
    }

    // Gateway intelligence (v0.6.0): auto-swap toggle + keep-N pool size.
    const gwUpdates: { autoSwap?: boolean; keepN?: number } = {}
    if (b.gateway?.autoSwap !== undefined) gwUpdates.autoSwap = !!b.gateway.autoSwap
    if (b.gateway?.keepN !== undefined) {
      const v = Number(b.gateway.keepN)
      if (!Number.isInteger(v) || v < 1 || v > 4) return err(c, 400, 'invalid_config_value', 'gateway.keepN must be 1–4.')
      gwUpdates.keepN = v
    }

    // Build toolchain dirs (ADR-100): absolute folders prepended to PATH for the prereq
    // probe + 1-click build, so a conda-env / custom-path CUDA Toolkit is found. Validate
    // here for a clean 400 (config.validate() would otherwise throw a 500 on update()).
    let toolchainDirs: string[] | undefined
    if (b.build?.toolchainDirs !== undefined) {
      if (!Array.isArray(b.build.toolchainDirs)) {
        return err(c, 400, 'invalid_config_value', 'build.toolchainDirs must be an array of paths.')
      }
      const dirs = b.build.toolchainDirs.map((p) => String(p).trim()).filter(Boolean)
      for (const dir of dirs) {
        if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) {
          return err(c, 400, 'invalid_config_value', `build.toolchainDirs: "${dir}" must be an absolute path.`)
        }
      }
      toolchainDirs = dirs
    }

    // AGENTS.md candidate lists (Code's standing-context injection, persona.ts) — the OPPOSITE
    // constraint from toolchainDirs: must be RELATIVE, not absolute. Clean-400 convenience only;
    // persona.ts containment-checks each entry again at read time regardless (see config.ts's
    // CodeConfig doc comment for why route-level validation alone isn't the real boundary).
    const MAX_AGENTS_MD_CANDIDATES = 8
    let agentsMdProjectCandidates: string[] | undefined
    let agentsMdGlobalCandidates: string[] | undefined
    for (const [key, out] of [
      ['agentsMdProjectCandidates', (v: string[]) => { agentsMdProjectCandidates = v }],
      ['agentsMdGlobalCandidates', (v: string[]) => { agentsMdGlobalCandidates = v }],
    ] as const) {
      const raw = b.code?.[key]
      if (raw === undefined) continue
      if (!Array.isArray(raw)) return err(c, 400, 'invalid_config_value', `code.${key} must be an array of filenames.`)
      const list = raw.map((p) => String(p).trim()).filter(Boolean)
      if (list.length > MAX_AGENTS_MD_CANDIDATES) return err(c, 400, 'invalid_config_value', `code.${key}: at most ${MAX_AGENTS_MD_CANDIDATES} candidates.`)
      for (const entry of list) {
        if (/^([a-zA-Z]:[\\/]|[\\/])/.test(entry)) {
          return err(c, 400, 'invalid_config_value', `code.${key}: "${entry}" must be a relative filename/path, not absolute.`)
        }
      }
      out(list)
    }

    // Tool-call approval gate: global per-tool policy map. Validate every value is
    // one of 'ask' | 'allow' | 'deny' so a garbled patch gets a clean 400, not a
    // silently-dropped/garbage config.
    let toolPolicies: Record<string, 'ask' | 'allow' | 'deny'> | undefined
    if (b.toolPolicies !== undefined) {
      if (typeof b.toolPolicies !== 'object' || b.toolPolicies === null || Array.isArray(b.toolPolicies)) {
        return err(c, 400, 'invalid_config_value', 'toolPolicies must be an object mapping tool name to ask, allow, or deny.')
      }
      const validated: Record<string, 'ask' | 'allow' | 'deny'> = {}
      for (const [toolName, v] of Object.entries(b.toolPolicies)) {
        if (v !== 'ask' && v !== 'allow' && v !== 'deny') {
          return err(c, 400, 'invalid_config_value', `toolPolicies.${toolName} must be ask, allow, or deny.`)
        }
        validated[toolName] = v
      }
      toolPolicies = validated
    }

    const before = d.store.snapshot().daemon
    d.store.update((cfg) => {
      Object.assign(cfg.daemon, updates)
      Object.assign(cfg.modelDefaults, mdUpdates)
      Object.assign(cfg.comfyui, cuUpdates)
      Object.assign(cfg.gateway, gwUpdates)
      if (toolchainDirs !== undefined) cfg.build.toolchainDirs = toolchainDirs
      if (agentsMdProjectCandidates !== undefined) cfg.code.agentsMdProjectCandidates = agentsMdProjectCandidates
      if (agentsMdGlobalCandidates !== undefined) cfg.code.agentsMdGlobalCandidates = agentsMdGlobalCandidates
      if (toolPolicies !== undefined) cfg.tools.toolPolicies = toolPolicies
      if (b.autoAllowAll !== undefined) cfg.tools.autoAllowAll = !!b.autoAllowAll
      if (b.autoLoadOnStart !== undefined) cfg.autoLoadOnStart = !!b.autoLoadOnStart
      if (vramHeadroomMb !== undefined) cfg.vramHeadroomMb = vramHeadroomMb
      if (telemetryLevel !== undefined) cfg.telemetry.level = telemetryLevel
      // Cloud Launch deploy-link settings (ADR-153): the RunPod Template ID the user
      // published themselves (deploy/runpod/README.md) — not a secret, just an id.
      if (b.cloudDeploy?.runpodTemplateId !== undefined) {
        cfg.cloudDeploy.runpodTemplateId = String(b.cloudDeploy.runpodTemplateId).trim()
      }
      // Experimental feature flags (2026-07-14, Settings → Experimental): per-field merge, not
      // Object.assign(cfg.daemon, updates) — a patch touching only one flag must not clobber
      // the other back to whatever `updates.experimental` would otherwise silently overwrite it
      // with (same reasoning as cloudDeploy's own per-field handling just above).
      if (b.experimental?.memory !== undefined) cfg.daemon.experimental.memory = !!b.experimental.memory
      if (b.experimental?.code !== undefined) cfg.daemon.experimental.code = !!b.experimental.code
      if (b.experimental?.cloudDeploy !== undefined) cfg.daemon.experimental.cloudDeploy = !!b.experimental.cloudDeploy
      // HF token (spec 10 §4): write-only. An explicit '' clears it. Never logged.
      if (b.hfToken !== undefined) cfg.hf.token = String(b.hfToken).trim()
      // Search provider config (F-020). All key/URL fields are write-only; '' clears them.
      // `search` is the canonical block; legacy top-level `tavilyApiKey` still works as an alias.
      cfg.tools.search ??= { provider: 'tavily' }
      const s = cfg.tools.search
      if (b.search?.provider === 'tavily' || b.search?.provider === 'kagi' || b.search?.provider === 'searxng') {
        s.provider = b.search.provider
      }
      const trimmed = (v: string): string | undefined => v.trim() || undefined
      if (b.search?.tavilyApiKey !== undefined) s.tavilyApiKey = trimmed(b.search.tavilyApiKey)
      if (b.search?.kagiApiKey !== undefined) s.kagiApiKey = trimmed(b.search.kagiApiKey)
      if (b.search?.searxngUrl !== undefined) s.searxngUrl = trimmed(b.search.searxngUrl)
      // Legacy alias: top-level tavilyApiKey maps onto search.tavilyApiKey + keeps tools.tavily for read.
      if (b.tavilyApiKey !== undefined) {
        const key = String(b.tavilyApiKey).trim()
        cfg.tools.tavily = key ? { apiKey: key } : undefined
        s.tavilyApiKey = key || undefined
      }
    })
    // Keep ToolRegistry in sync when tools config changes.
    if (b.tavilyApiKey !== undefined || b.search !== undefined) {
      d.tools?.updateConfig(d.store.snapshot().tools)
      // Rebuild tool definitions so the engine picks up new/changed search providers
      // without requiring a full daemon restart.
      await d.tools?.buildToolDefinitions()
    }
    const after = d.store.snapshot().daemon

    // A LAN-bind or port change re-points the HTTP listener. Rather than a full daemon
    // restart (which unloads the model), do an in-place rebind that keeps everything
    // loaded (spec 08 §2). Schedule it AFTER this response flushes — the rebind drops
    // in-flight connections. A LAN-only change (same port) is seamless for the browser;
    // a port change needs the client to hop to the new port (it reads `rebind` below).
    const lanChanged = after.lanBind !== before.lanBind
    const portChanged = after.port !== before.port
    let rebind: { portChanged: boolean; port: number; lanBind: boolean } | undefined
    if ((lanChanged || portChanged) && d.rebind) {
      const doRebind = d.rebind
      setTimeout(() => doRebind(), 250)
      rebind = { portChanged, port: after.port, lanBind: after.lanBind }
    }
    return c.json({ ...settingsPayload(d), rebind })
  })

  // ── MCP server management (v0.7.0) ────────────────────────────────────────

  app.post('/api/v1/mcp/servers', async (c) => {
    const b = await body<Partial<McpServer>>(c)
    const transport = b.transport === 'sse' ? 'sse' : 'stdio'
    if (!b.name?.trim()) return err(c, 400, 'invalid_config_value', 'name is required.')
    if (transport === 'stdio' && !b.command?.trim()) return err(c, 400, 'invalid_config_value', 'command is required for stdio transport.')
    if (transport === 'sse' && !b.url?.trim()) return err(c, 400, 'invalid_config_value', 'url is required for sse transport.')
    if (transport === 'sse' && !/^https?:\/\//i.test(b.url ?? '')) return err(c, 400, 'invalid_config_value', 'url must be an http(s):// address.')
    const { randomUUID } = await import('node:crypto')
    const server: McpServer = {
      id: randomUUID(),
      name: b.name.trim(),
      transport,
      enabled: b.enabled !== false,
      ...(transport === 'stdio'
        ? { command: b.command!.trim(), args: b.args ?? [], env: b.env ?? {} }
        : { url: b.url!.trim(), ...(b.apiKey ? { apiKey: b.apiKey } : {}) }),
    }
    // Auto-set MEMORY_FILE_PATH for @modelcontextprotocol/server-memory so users never need to
    // configure it. The package name lands in args (command is "npx"), so check both.
    const isMemoryServer = server.transport === 'stdio' &&
      (server.command?.includes('server-memory') || server.args?.some((a) => a.includes('server-memory')))
    if (isMemoryServer && !server.env?.MEMORY_FILE_PATH) {
      server.env = { ...server.env, MEMORY_FILE_PATH: join(homedir(), '.turbollm', 'mcp-memory.jsonl') }
    }
    d.store.update((cfg) => { cfg.mcp.servers.push(server) })
    if (server.enabled) {
      await d.tools?.syncMcpServers(d.store.snapshot().mcp.servers).catch(() => {})
      await d.tools?.buildToolDefinitions()
    }
    // apiKey is write-only: never echo the Bearer token back, even on the create response.
    const { apiKey: _created, ...safeServer } = server
    return c.json(safeServer, 201)
  })

  app.put('/api/v1/mcp/servers/:id', async (c) => {
    const id = c.req.param('id')
    const b = await body<Partial<McpServer>>(c)
    const cfg = d.store.snapshot()
    if (!cfg.mcp.servers.some((s) => s.id === id)) return err(c, 404, 'not_found', 'MCP server not found.')
    if (b.transport && b.transport !== 'stdio' && b.transport !== 'sse') return err(c, 400, 'invalid_config_value', 'transport must be stdio or sse.')
    if (b.url && !/^https?:\/\//i.test(b.url)) return err(c, 400, 'invalid_config_value', 'url must be an http(s):// address.')
    d.store.update((c2) => {
      const s = c2.mcp.servers.find((x) => x.id === id)!
      if (b.name !== undefined) s.name = b.name.trim()
      if (b.transport !== undefined) s.transport = b.transport
      if (b.enabled !== undefined) s.enabled = !!b.enabled
      if (b.command !== undefined) s.command = b.command
      if (b.args !== undefined) s.args = b.args
      if (b.env !== undefined) s.env = b.env
      if (b.url !== undefined) s.url = b.url
      if (b.apiKey !== undefined) s.apiKey = b.apiKey || undefined
    })
    await d.tools?.syncMcpServers(d.store.snapshot().mcp.servers).catch(() => {})
    await d.tools?.buildToolDefinitions()
    // apiKey is write-only: strip the Bearer token from the update response too.
    const updated = d.store.snapshot().mcp.servers.find((s) => s.id === id)!
    const { apiKey: _updated, ...safeUpdated } = updated
    return c.json(safeUpdated)
  })

  app.delete('/api/v1/mcp/servers/:id', async (c) => {
    const id = c.req.param('id')
    const cfg = d.store.snapshot()
    if (!cfg.mcp.servers.some((s) => s.id === id)) return err(c, 404, 'not_found', 'MCP server not found.')
    d.store.update((c2) => { c2.mcp.servers = c2.mcp.servers.filter((s) => s.id !== id) })
    void d.tools?.syncMcpServers(d.store.snapshot().mcp.servers)
    await d.tools?.buildToolDefinitions()
    return c.json({ ok: true })
  })

  // ── telemetry preview (spec 09 §4): a representative example of exactly what
  // each consent level would send. Illustrative only — built from getSysInfo() + a
  // sample bench record; nothing is transmitted and no real data leaves the machine.
  app.get('/api/v1/telemetry/preview', (c) => {
    const raw = (c.req.query('level') ?? '').trim()
    const level = ['off', 'anon', 'full'].includes(raw) ? raw : 'off'
    return c.json(telemetryPreview(level, d.version))
  })

  // ── network info (spec 08 §2): LAN expose state + the reachable LAN URL + whether
  // an API key exists (non-local access requires one). `requireApiKey` + `isHost` (added
  // alongside the /api/v1/keys host gate above) let the UI honestly reflect that same rule
  // instead of just hiding a button while the underlying route is still reachable.
  app.get('/api/v1/settings/network', (c) => {
    const cfg = d.store.snapshot()
    return c.json({
      lanBind: cfg.daemon.lanBind,
      lanUrl: `http://${getLanIp()}:${cfg.daemon.port}`,
      hasApiKey: cfg.apiKeys.length > 0,
      requireApiKey: cfg.daemon.requireApiKey,
      isHost: isLocalRequest(c, d),
    })
  })

  // ---- model directories (spec 02 §5; primary dir spec 01 §3 / ADR-035) ----
  app.get('/api/v1/modeldirs', (c) => c.json(modelDirsPayload(d)))

  app.post('/api/v1/modeldirs', async (c) => {
    const b = await body<{ dir?: string }>(c)
    const dir = (b.dir ?? '').trim()
    if (!dir || !/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) return err(c, 400, 'invalid_config_value', 'Path must be absolute.')
    if (!existsSync(dir)) return err(c, 400, 'invalid_config_value', 'That folder does not exist.')
    try {
      d.store.update((cfg) => {
        if (!cfg.modelDirs.includes(dir)) cfg.modelDirs.push(dir)
      })
    } catch (e) {
      return regErr(c, e)
    }
    void d.scanner.rescan()
    return c.json(modelDirsPayload(d), 201)
  })

  app.delete('/api/v1/modeldirs', async (c) => {
    const b = await body<{ dir?: string }>(c)
    d.store.update((cfg) => {
      cfg.modelDirs = cfg.modelDirs.filter((x) => x !== b.dir)
      // If the removed folder was the configured primary, reset to the effective
      // default (first remaining dir). validate() also guards this on load.
      if (cfg.primaryModelDir === b.dir) cfg.primaryModelDir = ''
    })
    void d.scanner.rescan()
    return c.json(modelDirsPayload(d))
  })

  // Set the primary download/import folder. Must be one of the configured dirs.
  app.post('/api/v1/modeldirs/primary', async (c) => {
    const b = await body<{ dir?: string }>(c)
    const dir = (b.dir ?? '').trim()
    if (!dir || !d.store.snapshot().modelDirs.includes(dir)) {
      return err(c, 400, 'invalid_config_value', 'Primary folder must be one of your model folders.')
    }
    d.store.update((cfg) => {
      cfg.primaryModelDir = dir
    })
    return c.json(modelDirsPayload(d))
  })

  // ── Hugging Face discovery (spec 10 §2–4, §7 rewrite) ────────────────────
  // Search (q set) or browse (q blank — the live equivalent of
  // huggingface.co/models?library=<engine-adapted>&sort=<sort>, replacing what used to be
  // a hardcoded "Featured" list) HF repos. `localCount` is overlaid from the scan cache so
  // a row can show a "↓ N in library" chip without a second round-trip.
  const SORT_OPTIONS: HfSortOption[] = ['best-match', 'trending', 'downloads', 'likes', 'modified', 'created']
  app.get('/api/v1/hf/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    const rawSort = c.req.query('sort') ?? ''
    const sort: HfSortOption = (SORT_OPTIONS as string[]).includes(rawSort) ? (rawSort as HfSortOption) : 'best-match'
    try {
      const results = q
        ? await d.hf.searchModels(q, d.registry.active()?.kind, sort)
        : await d.hf.browseModels(sort, d.registry.active()?.kind)
      const withLocal = results.map((r) => ({ ...r, localCount: localCountFor(d, r.repo) }))
      return c.json({ results: withLocal })
    } catch (e) {
      return hfErr(c, e)
    }
  })

  // Repo detail (files + sizes + gated). The id contains a '/', so capture the
  // wildcard tail. Each file is annotated `downloaded` + `localKey` so the SAME
  // model+quant from a different repo is correctly NOT marked downloaded. Two
  // signals (spec 10 §3): (1) download provenance for files pulled via TurboLLM
  // (sha256 exact, or repo+filename); (2) for imported / pre-existing files with no
  // provenance, a content sha256 match — computed lazily and only for a local file
  // whose byte size exactly matches a repo file (so we almost never hash). While a
  // hash is still being computed the response carries `verifying:true` and the UI
  // re-polls until the badge resolves.
  app.get('/api/v1/hf/models/:owner/:name', async (c) => {
    const repo = `${c.req.param('owner')}/${c.req.param('name')}`
    try {
      const detail = await d.hf.getRepo(repo)
      const prov = d.downloads.provenance()
      const models = d.scanner.list().models
      const bySize = new Map<number, typeof models>()
      for (const m of models) {
        const arr = bySize.get(m.sizeBytes) ?? []
        arr.push(m)
        bySize.set(m.sizeBytes, arr)
      }

      let verifying = false
      const files = detail.files.map((f) => {
        // 1) Provenance: downloaded via TurboLLM.
        const pmatch = prov.find(
          (p) =>
            (!!p.sha256 && !!f.sha256 && p.sha256 === f.sha256) ||
            (p.repo === repo && p.filename === f.name),
        )
        let local = pmatch ? models.find((m) => m.path === pmatch.dest) : undefined

        // 2) Content hash: imported / pre-existing files with no provenance. Gated
        //    on exact byte size + single-part to avoid needless hashing and split
        //    ambiguity. Uncached candidates are hashed in the background.
        if (!local && f.sha256 && f.parts === 1) {
          for (const cand of bySize.get(f.sizeBytes) ?? []) {
            const mt = new Date(cand.mtime).getTime()
            const h = d.hashes.get(cand.path, cand.sizeBytes, mt)
            if (h === undefined) {
              d.hashes.ensure(cand.path, cand.sizeBytes, mt)
              verifying = true
            } else if (h === f.sha256) {
              local = cand
              break
            }
          }
        }
        return { ...f, downloaded: !!local, localKey: local?.key ?? null }
      })
      return c.json({ ...detail, files, verifying })
    } catch (e) {
      return hfErr(c, e)
    }
  })

  // Validate an HF token against whoami-v2 (spec 10 §4). Never 5xx on a bad token.
  app.post('/api/v1/hf/token/test', async (c) => {
    const b = await body<{ token?: string }>(c)
    try {
      return c.json(await d.hf.testToken(b.token ?? ''))
    } catch (e) {
      return hfErr(c, e)
    }
  })

  // ── Downloads (spec 10 §5–6, §8) ──────────────────────────────────────────
  app.get('/api/v1/downloads', (c) => c.json({ downloads: d.downloads.list() }))

  // Enqueue from an HF repo file {repo, rfilename} OR a raw URL {url}. 202.
  app.post('/api/v1/downloads', async (c) => {
    const b = await body<{ repo?: string; rfilename?: string; url?: string; size?: number; sha256?: string; subdir?: string }>(c)
    try {
      // One request may fan out into several files (split shards + a shared mmproj) —
      // return every record created so the UI reflects the full queued set.
      const recs = await d.downloads.enqueue(b)
      return c.json({ downloads: recs }, 202)
    } catch (e) {
      return dlErr(c, e)
    }
  })

  app.post('/api/v1/downloads/:id/cancel', (c) => {
    const ok = d.downloads.cancel(c.req.param('id'))
    if (!ok) return err(c, 404, 'no_such_download', 'No download with that id.')
    return c.json({ ok: true })
  })

  app.post('/api/v1/downloads/:id/resume', (c) => {
    const ok = d.downloads.resume(c.req.param('id'))
    if (!ok) return err(c, 404, 'no_such_download', 'No paused or errored download with that id.')
    return c.json({ ok: true })
  })

  app.delete('/api/v1/downloads/:id', (c) => {
    const ok = d.downloads.remove(c.req.param('id'))
    if (!ok) return err(c, 404, 'no_such_download', 'No download with that id.')
    return c.json({ ok: true })
  })

  // ── API keys (spec 06 §5) ────────────────────────────────────────────────
  // Host-only while the LAN is open and unauthenticated (lanBind on, requireApiKey off):
  // lanAuth's bypassesAuth deliberately lets that combination through with NO credential at
  // all (spec 06 §5's "opted into open LAN access"), which is fine for chat/models but would
  // let any device that can merely load the page list key names or mint itself a durable
  // `tllm-...` key with zero credential — a real self-escalation (that key keeps working even
  // after requireApiKey is later turned on), not just an info leak. Once requireApiKey IS on,
  // a non-host caller only reaches this handler at all by already having presented a valid key
  // (lanAuth ran first), so self-service key management from another device is fine then.
  function keysHostGate(c: Context): boolean {
    return isLocalRequest(c, d) || d.store.snapshot().daemon.requireApiKey
  }

  app.get('/api/v1/keys', (c) => {
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'API keys are only visible from this machine until "Require an API key" is turned on.')
    const keys = d.store.snapshot().apiKeys.map(({ id, name, prefix, createdAt, lastUsedAt }) => ({
      id,
      name,
      prefix,
      createdAt,
      lastUsedAt,
    }))
    return c.json({ keys })
  })

  app.post('/api/v1/keys', async (c) => {
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'API keys can only be created from this machine until "Require an API key" is turned on.')
    const b = await body<{ name?: string }>(c)
    const name = (b.name ?? '').trim()
    if (!name) return err(c, 400, 'invalid_config_value', 'name is required.')
    const { full, hash, prefix } = generateApiKey()
    const key: ApiKey = {
      id: randomUUID(),
      name,
      hash,
      prefix,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }
    d.store.update((cfg) => cfg.apiKeys.push(key))
    return c.json(
      { key: full, meta: { id: key.id, name: key.name, prefix, createdAt: key.createdAt, lastUsedAt: null } },
      201,
    )
  })

  app.delete('/api/v1/keys/:id', (c) => {
    const id = c.req.param('id')
    d.store.update((cfg) => {
      cfg.apiKeys = cfg.apiKeys.filter((k) => k.id !== id)
    })
    return c.json({ ok: true })
  })

  // ── CLI connect snippets (spec 06 §6) ────────────────────────────────────
  // Same host gate as /api/v1/keys above, and for the same reason — arguably more urgent here:
  // this route doesn't just expose existing key metadata, it MINTS a brand-new live key (below)
  // and returns its full raw value embedded in the setup snippets on every single call while
  // lanBind is on, with no action beyond loading the page (ConnectSection queries it eagerly for
  // the default-selected CLI). Ungated, a non-host viewer on an open, unauthenticated LAN could
  // get a real credential just by opening Developer — worse than the list/create case, since it
  // requires no explicit "create" click at all.
  app.get('/api/v1/connect/:cli', (c) => {
    if (!keysHostGate(c)) return err(c, 403, 'forbidden', 'Connect setup is only available from this machine until "Require an API key" is turned on.')
    const cli = c.req.param('cli')
    const cfg = d.store.snapshot()
    const { port, lanBind } = cfg.daemon
    const host = lanBind ? getLanIp() : '127.0.0.1'
    const base = `http://${host}:${port}`
    const ms = d.manager.status()
    const modelName = ms.state === 'running' ? (ms.model?.name ?? 'local') : 'local'
    const modelKey = ms.state === 'running' ? (ms.model?.key ?? modelName) : modelName

    let apiKey = 'not-needed-on-localhost'
    if (lanBind) {
      const keyName = `cli-${cli}`
      const { full, hash, prefix } = generateApiKey()
      const fresh: ApiKey = {
        id: randomUUID(),
        name: keyName,
        hash,
        prefix,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      }
      d.store.update((cfgMut) => {
        cfgMut.apiKeys = cfgMut.apiKeys.filter((k) => k.name !== keyName)
        cfgMut.apiKeys.push(fresh)
      })
      apiKey = full
    }

    return c.json(buildConnectSnippets(cli, base, apiKey, modelName, modelKey))
  })
}

/** Overlay the live-dynamic flags (loaded, hasProfile) and tiered t/s (lastTps,
 *  liveTps) onto a scanned entry (spec 04 §5). `lastTps` is the most-recent gen
 *  t/s recorded for this model; pass the precomputed map on the list endpoint to
 *  avoid one DB query per row. `liveTps` is best-effort: there is no full live
 *  session-stats accumulator yet (that's a separate B4 task), so we surface the
 *  loaded model's last recorded gen t/s as its live figure — non-null only while
 *  that model is the one currently loaded. */
function overlayModel(e: ModelEntry, d: Deps, lastTpsMap?: Map<string, number>) {
  const ms = d.manager.status()
  const loadedKey = ms.state === 'running' ? ms.model?.key : undefined
  const snap = d.store.snapshot()
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
  const active = d.registry.active()
  const compatibleWithActiveEngine = active
    ? engineAcceptsFormat(active.kind, e.format) && !(e.audio && engineRejectsAudioModel(active.kind))
    : true
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
  return { ...e, loaded, hasProfile, lastTps, liveTps, benchTps, compatibleWithActiveEngine, sourceRepo }
}

// ---- helpers ----

/** User-facing message when the active engine can't load a model's format (ADR-044). */
function formatMismatchMessage(engineKind: string, format: 'gguf' | 'mlx'): string {
  if (engineKind === 'mlx')
    return 'The active engine is MLX — pick a safetensors model, or switch to a llama.cpp engine for GGUF.'
  if (engineKind === 'rapid-mlx')
    return 'The active engine is Rapid-MLX — pick a safetensors model, or switch to a llama.cpp engine for GGUF.'
  if (engineKind === 'vllm')
    return 'The active engine is vLLM — pick a safetensors / HF model, or switch to a llama.cpp engine for GGUF.'
  // llama.cpp / fork active, model is a safetensors dir.
  return format === 'mlx'
    ? 'This is a safetensors model — activate an MLX or vLLM engine to load it.'
    : 'The active engine can only load GGUF models.'
}

/** The /modeldirs response: the configured folders plus the EFFECTIVE primary
 *  (spec 01 §3, ADR-035) — the configured primary when it's still a valid dir,
 *  otherwise the first folder. Empty string when no folders are configured. */
function modelDirsPayload(d: Deps): { dirs: string[]; primaryDir: string } {
  const cfg = d.store.snapshot()
  const primaryDir =
    cfg.primaryModelDir && cfg.modelDirs.includes(cfg.primaryModelDir)
      ? cfg.primaryModelDir
      : (cfg.modelDirs[0] ?? '')
  return { dirs: cfg.modelDirs, primaryDir }
}

/** The UI-exposed settings subset. Telemetry is surfaced as the 3-option enum;
 *  the stored first-run sentinel 'unset' maps to 'off' here (consent UX reads the
 *  raw value off /status separately). */
function settingsPayload(d: Deps) {
  const cfg = d.store.snapshot()
  const lvl = cfg.telemetry.level
  const telemetryLevel = lvl === 'anon' || lvl === 'full' ? lvl : 'off'
  return {
    idleTtlMinutes: cfg.daemon.idleTtlMinutes,
    port: cfg.daemon.port,
    theme: cfg.daemon.theme,
    autoGenerateTitles: cfg.daemon.autoGenerateTitles,
    autoMemoryEnabled: cfg.daemon.autoMemoryEnabled,
    openBrowserOnStart: cfg.daemon.openBrowserOnStart,
    autoLoadOnStart: cfg.autoLoadOnStart,
    vramHeadroomMb: cfg.vramHeadroomMb,
    lanBind: cfg.daemon.lanBind,
    requireApiKey: cfg.daemon.requireApiKey,
    telemetryLevel,
    modelDefaults: cfg.modelDefaults,
    comfyui: cfg.comfyui,
    gateway: cfg.gateway,
    // The HF token is write-only over the wire (spec 10 §4): we never echo it back,
    // only whether one is set, so the UI can show "configured" without leaking it.
    hfTokenSet: cfg.hf.token.length > 0,
    // Tavily API key is write-only: expose only whether it is set (legacy field, kept for compat).
    tavilyKeySet: !!(cfg.tools.search?.tavilyApiKey ?? cfg.tools.tavily?.apiKey),
    // Search provider config (F-020): provider + which credentials are set. Keys are write-only
    // (booleans only); searxngUrl is not a secret so it is echoed for the form to display.
    search: {
      provider: cfg.tools.search?.provider ?? 'tavily',
      tavilyKeySet: !!cfg.tools.search?.tavilyApiKey,
      kagiKeySet: !!cfg.tools.search?.kagiApiKey,
      searxngUrl: cfg.tools.search?.searxngUrl ?? '',
    },
    // apiKey is write-only: strip before echoing so Bearer tokens never reach the frontend.
    mcp: { ...cfg.mcp, servers: cfg.mcp.servers.map(({ apiKey: _k, ...s }) => s) },
    // Build environment (ADR-100): folders prepended to PATH for compile-from-source so a
    // conda-env / custom-path CUDA Toolkit + compiler are found. Not secret — echoed back.
    build: { toolchainDirs: cfg.build.toolchainDirs },
    // Code's AGENTS.md-style standing-context candidate lists (config.ts's CodeConfig):
    // not secret — echoed back.
    code: cfg.code,
    // Cloud Launch deploy-link settings (ADR-153): not secret — echoed back.
    cloudDeploy: cfg.cloudDeploy,
    // Experimental feature flags (2026-07-14): not secret — echoed back for Settings →
    // Experimental and for the frontend to decide whether to show the Code entry point at all.
    experimental: cfg.daemon.experimental,
    // Tool-call approval gate: global per-tool policy ('ask' | 'allow' | 'deny').
    // Not secret — echoed back directly so Settings can render Tool Permissions.
    toolPolicies: cfg.tools.toolPolicies ?? {},
    autoAllowAll: cfg.tools.autoAllowAll ?? false,
  }
}

/** A REPRESENTATIVE illustration of exactly what each telemetry level would send
 *  (spec 09 §3–4). Built from real hardware (getSysInfo) + a sample bench record so
 *  the user can see the shape. NOTHING is transmitted; 'off' sends nothing. Forbidden
 *  fields (prompts, paths, dir names, tokens, IPs, hostnames, usernames) are excluded
 *  by construction — only whitelisted fields are placed here. */
function telemetryPreview(level: string, version: string) {
  if (level === 'off') {
    return { level, sends: false, note: 'Telemetry is off. Nothing is collected or sent.', payload: null }
  }
  const sys = getSysInfo()
  const hw = {
    cpu: sys.cpu,
    ramMb: sys.ramMB,
    gpus: sys.gpus.map((g) => ({ name: g.name, vramMb: g.vramMb })),
  }
  const benchEvent = {
    schema: 1,
    event: 'bench_result',
    ts: new Date().toISOString(),
    machineId: '00000000-0000-0000-0000-000000000000', // random per-install uuid (example)
    app: { version, os: sys.os },
    hw,
    payload: {
      model: { name: 'Qwen3.6-35B', quant: 'Q4_K_M', sizeBytes: 21_000_000_000, arch: 'qwen3moe', moe: true },
      engine: { version: 'b1234' },
      params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
      result: { tps: 48.2, ttftMs: 310, vramMb: 15800, outcome: 'ok' },
    },
  }
  const events: unknown[] = [benchEvent]
  if (level === 'full') {
    events.push({
      schema: 1,
      event: 'crash_report',
      ts: new Date().toISOString(),
      machineId: '00000000-0000-0000-0000-000000000000',
      app: { version, os: sys.os },
      hw,
      // Error fingerprint only — exit code + first matching error line, never full logs.
      payload: { engineExitCode: 1, errorFingerprint: 'CUDA error: out of memory' },
    })
  }
  const note =
    level === 'anon'
      ? 'Anonymized hardware + benchmark speed only. No prompts, paths, identifiers, or keys.'
      : 'Anonymous benchmarks plus crash/error fingerprints. Still no prompts, paths, or content.'
  return { level, sends: true, note, payload: events }
}

/** Heuristic count of local quant variants that plausibly belong to an HF repo
 *  (spec 10 §2 `localCount`). Scanned entries carry no HF repo id, so we match the
 *  repo's name segment (after the owner) against the local model name/path,
 *  case-insensitively. Best-effort — drives a "↓ N in library" hint only. */
function localCountFor(d: Deps, repo: string): number {
  const seg = (repo.split('/')[1] ?? repo).toLowerCase().replace(/-gguf$/i, '')
  if (!seg) return 0
  const needle = seg.replace(/[-_.\s]+/g, '')
  let n = 0
  for (const m of d.scanner.list().models) {
    const hay = `${m.name} ${basename(m.path)}`.toLowerCase().replace(/[-_.\s]+/g, '')
    if (hay.includes(needle)) n++
  }
  return n
}

/** A download (engine provision) OR a 1-click build writes under `<dataDir>/engines` and
 *  ends by mutating the registry + flipping the active engine. They must not run at once
 *  (ADR-100). Returns a user-facing message when either is in flight, else null. */
function engineWorkBusy(d: Deps): string | null {
  if (d.provision.get().active) return 'An engine download is in progress — wait for it to finish.'
  if (d.build.isActive()) return 'A build is in progress — wait for it to finish.'
  return null
}

function hfErr(c: Context, e: unknown) {
  if (e instanceof HfError) {
    const status: Status =
      e.code === 'hf_unauthorized' ? 401 : e.code === 'hf_gated' ? 403 : e.code === 'hf_not_found' ? 404 : 503
    return err(c, status, e.code, e.message)
  }
  return err(c, 500, 'internal', (e as Error).message)
}

function dlErr(c: Context, e: unknown) {
  if (e instanceof DownloadError) {
    const status: Status =
      e.code === 'no_model_dir' ? 409 : e.code === 'hf_unauthorized' ? 401 : e.code === 'hf_gated' ? 403 : 400
    return err(c, status, e.code, e.message)
  }
  return err(c, 500, 'internal', (e as Error).message)
}

function benchError(c: Context, e: unknown) {
  if (e instanceof BenchError) {
    const status: Status =
      e.code === 'bench_running' || e.code === 'engine_in_use' || e.code === 'no_active_engine' ? 409
        : e.code === 'no_such_model' ? 404
        : 400
    return err(c, status, e.code, e.message)
  }
  return err(c, 500, 'internal', (e as Error).message)
}

function engineBusy(d: Deps): boolean {
  const s = d.manager.status().state
  return s === 'running' || s === 'starting' || s === 'stopping'
}

/** True when `repoUrl` matches a known catalog engine's homepage (llama.cpp, TurboQuant, …).
 *  Gates {@link Registry.recordCustomSource}: a catalog repo already gets its own re-enable
 *  detection (the /catalog endpoint's `sourceBuildBinary(enginesRoot, e.homepage)` scan, keyed
 *  by that fixed, hardcoded URL) — recording it as a "custom" source too would just duplicate
 *  that, and could show the SAME build as two different cards. */
function isCatalogRepo(repoUrl: string | undefined): boolean {
  if (!repoUrl) return false
  return catalogForPlatform().some((e) => sameRepo(repoUrl, e.homepage))
}

function regErr(c: Context, e: unknown) {
  if (e instanceof NotFoundError) return err(c, 404, 'engine_not_found', 'No engine with that id.')
  if (e instanceof ValueError) return err(c, 400, 'invalid_config_value', e.message)
  return err(c, 500, 'internal', (e as Error).message)
}

/**
 * Derive the on-disk install directory for a registered engine, for use with
 * the ?purge=1 delete path. Returns a path only when it is safely inside
 * `{enginesRoot}/` — never an arbitrary user path. Returns null for user-added
 * engines (arbitrary binPath not under enginesRoot) so they are never purged.
 *
 * Mapping:
 *   - pip kind='mlx'        → engines/mlx/venv (and its uv sibling stays; we only
 *                             wipe the venv that holds the package)
 *   - pip kind='rapid-mlx'  → engines/rapid-mlx/venv
 *   - pip kind='vllm'       → engines/vllm/venv
 *   - TurboQuant fork       → engines/turboquant (detected by its binPath pattern)
 *   - llama.cpp backends    → engines/llama.cpp-{tag}-{id} (via DELETE /backends/:id)
 *
 * For safety: the returned path MUST start with `{enginesRoot}{sep}`.
 */
function engineInstallDir(eng: Engine, enginesRoot: string): string | null {
  const norm = enginesRoot.replace(/[\\/]+$/, '')
  const inside = (p: string) => {
    const n = p.replace(/[\\/]+$/, '')
    return n.startsWith(norm + '/') || n.startsWith(norm + '\\')
  }
  // pip: mlx venv
  if (eng.kind === 'mlx') {
    const d = join(enginesRoot, 'mlx', 'venv')
    return inside(d) ? d : null
  }
  // pip: rapid-mlx venv
  if (eng.kind === 'rapid-mlx') {
    const d = join(enginesRoot, 'rapid-mlx', 'venv')
    return inside(d) ? d : null
  }
  // pip: vllm venv
  if (eng.kind === 'vllm') {
    const d = join(enginesRoot, 'vllm', 'venv')
    return inside(d) ? d : null
  }
  // TurboQuant fork (llama-server kind, binPath under engines/turboquant/)
  if (/[\\/]engines[\\/]turboquant[\\/]/.test(eng.binPath)) {
    const d = join(enginesRoot, 'turboquant')
    return inside(d) ? d : null
  }
  // KoboldCpp single binary (engines/koboldcpp/)
  if (eng.kind === 'koboldcpp') {
    const d = koboldcppDir(enginesRoot)
    return inside(d) ? d : null
  }
  // llamafile single binary (engines/llamafile/)
  if (eng.kind === 'llamafile') {
    const d = llamafileDir(enginesRoot)
    return inside(d) ? d : null
  }
  // Source-built engine (ADR-100): binary lives under engines/build/<slug>/ — purge the
  // whole build dir (clone + objects + binary), which can be several GB.
  const srcDir = sourceBuildDirOf(eng.binPath, enginesRoot)
  if (srcDir) return inside(srcDir) ? srcDir : null
  // Official llama.cpp build (engines/llama.cpp-<tag>-<backend>/): purge THIS specific
  // version's dir so a user can delete an individual build (e.g. an old b9744) without
  // touching others. The generic backend-delete only knows the pinned tag, so without this
  // a per-version delete would leave the files on disk.
  const llamaMatch = eng.binPath.replace(/\\/g, '/').match(/\/(llama\.cpp-[^/]+)\//i)
  if (llamaMatch) {
    const d = join(enginesRoot, llamaMatch[1])
    return inside(d) ? d : null
  }
  return null
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

function readTail(path: string, n: number): string[] {
  if (!path || !existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '').split('\n').map((l) => l.replace(/\r$/, ''))
    return lines.length > n ? lines.slice(-n) : lines
  } catch {
    return []
  }
}

// ── API key helpers ────────────────────────────────────────────────────────

// ── filesystem browser helpers (spec 03 §9) ─────────────────────────────────

/** Sentinel path for the Windows "This PC" drive list — a virtual root above the
 *  drive letters (C:\, D:\, …) so the browser can hop between drives. */
const FS_DRIVES_ROOT = '::drives'

/** Available Windows drive roots (C:\, D:\, …) as browsable entries. Probes A–Z;
 *  only the drives that exist on the box respond, missing ones are skipped. */
function listWindowsDrives(): { name: string; path: string; isDir: boolean }[] {
  const drives: { name: string; path: string; isDir: boolean }[] = []
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`
    try {
      if (existsSync(root)) drives.push({ name: root, path: root, isDir: true })
    } catch {
      /* unreadable drive (e.g. an empty removable slot) — skip */
    }
  }
  return drives
}

function getLanIp(): string {
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

// ── CLI connect snippet builders ───────────────────────────────────────────

type ConnectStep = { label: string; snippet: string; lang: string }
type ConnectResult = { cli: string; title: string; steps: ConnectStep[] }

export function buildConnectSnippets(cli: string, base: string, apiKey: string, modelName: string, modelKey: string = modelName): ConnectResult {
  switch (cli) {
    case 'claude-code':
      return {
        cli,
        title: 'Claude Code',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch claude`,
            lang: 'bash',
          },
          {
            label: 'PowerShell one-liner',
            snippet: `$env:ANTHROPIC_BASE_URL="${base}"; $env:ANTHROPIC_AUTH_TOKEN="${apiKey}"; $env:ANTHROPIC_MODEL="${modelName}"; claude`,
            lang: 'powershell',
          },
          {
            label: 'bash / zsh',
            snippet: `ANTHROPIC_BASE_URL="${base}" ANTHROPIC_AUTH_TOKEN="${apiKey}" ANTHROPIC_MODEL="${modelName}" claude`,
            lang: 'bash',
          },
        ],
      }
    case 'opencode':
      return {
        cli,
        title: 'opencode',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch opencode`,
            lang: 'bash',
          },
          {
            label: 'Merge into ~/.config/opencode/opencode.json',
            snippet: JSON.stringify(
              {
                provider: {
                  turbollm: {
                    npm: '@ai-sdk/openai-compatible',
                    options: {
                      baseURL: `${base}/v1`,
                      ...(apiKey !== 'not-needed-on-localhost' ? { apiKey } : {}),
                    },
                    models: { [modelName]: { id: modelName } },
                  },
                },
              },
              null,
              2,
            ),
            lang: 'json',
          },
        ],
      }
    case 'kilo':
      return {
        cli,
        title: 'Kilo Code',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch kilo`,
            lang: 'bash',
          },
          {
            label: 'Add to ~/.config/kilo/kilo.jsonc providers array',
            snippet: JSON.stringify(
              {
                id: 'turbollm',
                name: 'TurboLLM (local)',
                type: 'openai-compatible',
                baseURL: `${base}/v1`,
                apiKey: apiKey !== 'not-needed-on-localhost' ? apiKey : 'not-required',
                models: [{ id: modelName, name: modelName }],
              },
              null,
              2,
            ),
            lang: 'jsonc',
          },
        ],
      }
    case 'openclaw':
      return {
        cli,
        title: 'openclaw',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch openclaw`,
            lang: 'bash',
          },
          {
            label: 'Merge into ~/.config/openclaw/openclaw.json',
            snippet: JSON.stringify(
              {
                models: {
                  providers: {
                    turbollm: {
                      baseUrl: `${base}/v1`,
                      apiKey: apiKey !== 'not-needed-on-localhost' ? apiKey : 'not-required',
                      api: 'openai-completions',
                      models: [{ id: modelKey, name: modelName }],
                    },
                  },
                },
                agents: { defaults: { model: { primary: `turbollm/${modelKey}` } } },
              },
              null,
              2,
            ),
            lang: 'json',
          },
        ],
      }
    case 'hermes':
      return {
        cli,
        title: 'Hermes Agent',
        steps: [
          {
            label: 'Quickest — one command (ships with TurboLLM)',
            snippet: `turbollm launch hermes`,
            lang: 'bash',
          },
          {
            label: 'PowerShell',
            snippet: `hermes config set model.provider custom; hermes config set model.base_url ${base}/v1; hermes config set model.default "${modelKey}"`,
            lang: 'powershell',
          },
          {
            label: 'bash / zsh',
            snippet: `hermes config set model.provider custom && hermes config set model.base_url ${base}/v1 && hermes config set model.default "${modelKey}"`,
            lang: 'bash',
          },
        ],
      }
    case 'qwen':
      return {
        cli,
        title: 'Qwen Code',
        steps: [
          {
            label: 'PowerShell one-liner',
            snippet: `$env:OPENAI_BASE_URL="${base}/v1"; $env:OPENAI_API_KEY="${apiKey}"; $env:OPENAI_MODEL="${modelName}"; qwen`,
            lang: 'powershell',
          },
          {
            label: 'bash / zsh',
            snippet: `OPENAI_BASE_URL="${base}/v1" OPENAI_API_KEY="${apiKey}" OPENAI_MODEL="${modelName}" qwen`,
            lang: 'bash',
          },
        ],
      }
    default:
      return { cli, title: cli, steps: [] }
  }
}
