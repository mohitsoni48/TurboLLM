// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Engine } from '../config/config'
import type { Deps } from '../deps'
import { NotFoundError, customSourceKey } from '../engines/registry'
import { ProbeError } from '../engines/probe'
import { isLocalOrAuthenticated } from '../auth'
import { normalizeUpdatePolicy, resolveUpdateSource } from '../engines/update'
import { applyEngineUpdate } from '../engines/update-apply'
import { koboldcppDir } from '../engines/koboldcpp'
import { llamafileDir } from '../engines/llamafile'
import { isEngineInBuildDir, sourceBuildDirOf } from '../engines/build-runner'
import { engineDeleteBlocked } from './delete-guards'
import { err, body, regErr } from './http'
import { engineWork, engineWorkBusy, autoTuneUpdateBlock, engineBusy, ENGINE_ENABLE_BUSY, type EngineJobs } from './engine-work'
import { sweepPurgeTrash, discardPurgeTrash } from './engine-trash'

/** A registered engine: rename, Disable/purge, activate, update, reprobe, and the per-engine update status. */
export function registerEngineManageRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
  app.put('/api/v1/engines/:id', async (c) => {
    const b = await body<{ name?: string; sourceRepo?: string; sourceBranch?: string }>(c)
    const id = c.req.param('id')
    // The source repo and branch are what the owner's next Rebuild clones and compiles: the update
    // check compares that repo's head with the build and offers Rebuild, and its one click runs
    // /build/run with them. So setting either is a host-side action, held to /build/run's own
    // isLocalOrAuthenticated rule (ADR-394); without it a keyless Serve identity, Access JWT or
    // open-LAN peer, refused /build/run itself, picked the repo the owner then built. Checked before
    // anything is written, so a rename sent alongside is refused too. A rename alone stays open:
    // the name is a label and executes nothing.
    if ((b.sourceRepo !== undefined || b.sourceBranch !== undefined) && !isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', "Setting an engine's source repo requires a valid API key from a non-host device.")
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
    // Not during an Enable's probe (see engineEnableInFlight): a release card's Delete forgets its source and then
    // discards the install, which nothing claims any more.
    if (engineWork.engineEnableInFlight) return err(c, 409, 'engine_already_running', ENGINE_ENABLE_BUSY)
    // c.req.param() already URL-decodes path segments (Hono) — decoding again corrupts any
    // key containing a literal '%' (the binPath fallback key can) and throws on an invalid
    // escape, since a normal key's second decode is a harmless no-op that hid this on the
    // happy path.
    d.registry.forgetCustomSource(c.req.param('key'))
    return c.json({ ok: true })
  })

  app.delete('/api/v1/engines/:id', (c) => {
    const id = c.req.param('id')
    const purge = c.req.query('purge') === '1'
    // ?purge=1 deletes the engine's install folder (a source build costs a recompile), so it is held to
    // isLocalOrAuthenticated like DELETE /engines/build, the smaller delete of a Disabled build: a keyless
    // Serve identity, Access JWT or open-LAN peer could otherwise purge every engine on the box. A plain
    // Disable (no purge, recordSource included) only unregisters, keeps the files and stays open.
    // api_key_required: the web client opens its key prompt on it.
    if (purge && !isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', "Deleting an engine's files requires a valid API key.")
    const target = d.registry.get(id)
    if (target && engineDeleteBlocked(d, target)) {
      return err(c, 409, 'engine_in_use', 'Stop the engine before removing it.')
    }
    // Not while an update, download, upload or rebuild runs (a second tab, an API client, or the auto-update scheduler
    // starting while the confirm dialog was open; the Engines screen does not disable Purge during a rebuild). A purge
    // under an update made its swap hit a missing folder and report "your existing build is unchanged" while leaving
    // an orphan folder; under a rebuild it deleted build/<slug> but not the parked previous build, which the failing
    // build then moved back; a removed engine was registered again when the update finished.
    { const busy = engineWorkBusy(d, { engineChange: true }); if (busy) return err(c, 409, 'engine_already_running', busy) }
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
      // ?purge=1: also delete the engine's installed files from disk.
      // Only removes dirs under {dataDir}/engines/ — never touches model dirs.
      const enginesRoot = join(d.store.dir(), 'engines')
      // A folder another registered engine runs from stays, left to that engine: POST /engines registers any server
      // binary, so the same build can be added twice under two names, or a binary of a TurboQuant or llama.cpp install
      // added by hand, and the purge renamed the folder away from under the other one, still registered with its
      // binary gone. This engine is unregistered as for any purge; the last one on the folder deletes it. A Disabled
      // custom engine on the folder (another remembered source; this engine's own is forgotten below) keeps it too, as
      // DELETE /engines/build counts one: its Enable re-registers from that folder.
      const installDir = purge && eng ? engineInstallDir(eng, enginesRoot) : null
      const ownSource = eng ? customSourceKey(eng) : ''
      const shared = !!installDir && (
        d.registry.list().engines.some((e) => e.id !== id && isEngineInBuildDir(e.binPath, installDir)) ||
        d.registry.customSources().some((s) => customSourceKey(s) !== ownSource && isEngineInBuildDir(s.binPath, installDir)))
      const purgeDir = shared ? null : installDir
      // All or nothing: the folder is first renamed to a hidden sibling, which Windows refuses while any file under it
      // is open (Defender or the indexer still reading llama-server.exe or ggml-cuda.dll right after a Stop). The
      // recursive delete this replaces threw part-way instead, AFTER the engine was unregistered: the folder stayed
      // half deleted, the remembered custom source and LiteRT-LM configs were kept, the client got a 500, and with no
      // registry entry left the purge could not be repeated (a half-deleted official llama.cpp build was even taken
      // for an install later). A refused rename now answers 409 with the engine still registered and its files whole.
      let trash: string | null = null
      if (eng && purgeDir && existsSync(purgeDir)) {
        sweepPurgeTrash(dirname(purgeDir))
        trash = join(dirname(purgeDir), `.${basename(purgeDir)}.purge-${Date.now()}`)
        try {
          renameSync(purgeDir, trash)
        } catch (e) {
          return err(c, 409, 'engine_files_locked', `Some of ${eng.name}'s files are still in use — try again in a moment. (${(e as Error).message})`)
        }
      }
      try {
        d.registry.remove(id)
      } catch (e) {
        // Still registered (a config write failed): its files go back where its binPath points.
        if (trash && purgeDir) try { renameSync(trash, purgeDir) } catch { /* the error below already reports the failure */ }
        throw e
      }
      if (purge && eng) {
        // LiteRT-LM keeps one launch-config file per port next to its venv (engines/litert-lm/config-<port>.json).
        if (eng.kind === 'litert-lm') {
          const cfgDir = join(enginesRoot, 'litert-lm')
          try {
            for (const f of readdirSync(cfgDir)) {
              if (/^config-\d+\.json$/.test(f)) rmSync(join(cfgDir, f), { force: true })
            }
          } catch { /* directory already gone */ }
        }
        // A purge is a real delete, not a Disable — drop any remembered custom-engine
        // identity too, so a purged engine doesn't linger as a "disabled" card with a
        // now-broken Enable (its files are gone). A plain Disable (no purge) leaves this
        // record alone; that's the whole point of recordCustomSource.
        d.registry.forgetCustomSource(customSourceKey(eng))
        // Best effort, as the engine is gone either way, and in the background after the reply (discardPurgeTrash): a
        // lock that outlasts the retries, or a daemon exit mid-delete, leaves a hidden folder that nothing points at,
        // and the next purge or delete in the same folder sweeps it (sweepPurgeTrash).
        if (trash) void discardPurgeTrash(trash)
      }
      return c.json({ ok: true })
    } catch (e) {
      return regErr(c, e)
    }
  })

  app.post('/api/v1/engines/:id/activate', (c) => {
    if (engineBusy(d)) return err(c, 409, 'engine_running', 'Stop the running engine before switching the active engine.')
    // Auto-tune stops the primary between its probes, which engineBusy reads as idle, so a switch got through mid-run
    // and the rest of the run loaded the model on the new engine with the old one's flags. A run tunes the engine it
    // started on and stops when another is selected (BenchRunner.startEngine); the switch is refused here instead.
    if (d.bench.isRunning() && d.registry.active()?.id !== c.req.param('id'))
      return err(c, 409, 'engine_running', 'Stop auto-tune before switching the active engine.')
    try {
      d.registry.activate(c.req.param('id'))
      forgetAndroidSdkFallback(d)
      // Switching engines invalidates any prior load error (e.g. a failed vLLM load on an
      // engine that can't serve here) — clear it so the UI doesn't show a stale error.
      d.manager.clearError()
      return c.json(d.registry.get(c.req.param('id')) ?? {})
    } catch (e) {
      return regErr(c, e)
    }
  })

  // Manual one-click update of any engine that has an automatic update source (ADR-085).
  // The scheduler stops a loaded engine itself; the manual path refuses, like zip and delete do.
  app.post('/api/v1/engines/:id/update', async (c) => {
    // Downloads and probes (executes) a binary, so only the TurboLLM app itself may trigger it.
    const site = c.req.header('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none')
      return err(c, 403, 'forbidden', 'Engine updates must come from the TurboLLM app itself.')
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Updating an engine requires a valid API key from a non-host device.')
    const busy = engineWorkBusy(d)
    if (busy) return err(c, 409, 'engine_already_running', busy)
    const id = c.req.param('id')
    // The loaded model's engine counts too: an install or Enable activates another engine without stopping it.
    const running = [d.registry.active(), d.manager.currentOpts()?.engine].find((e) => e?.id === id)
    if (engineBusy(d) && running)
      return err(c, 409, 'engine_in_use', `Stop "${running.name}" before updating it.`)
    // Nor the engine auto-tune is running on, which engineBusy reads as idle between two probes (autoTuneUpdateBlock).
    { const tuning = autoTuneUpdateBlock(d, (t) => t.id === id); if (tuning) return err(c, 409, 'engine_in_use', tuning) }
    const engine = d.registry.get(id)
    if (!engine) return err(c, 404, 'engine_not_found', 'No engine with that id.')
    // So does an extra pool slot on it, whatever the primary is doing, as for delete (engineDeleteBlocked): every
    // non-release branch starts with stopEngineUsers, which stopped that slot's model without a word, and it stayed
    // gone when the update then failed. (A release update refused only later, as a failed job.)
    if (d.modelRouter.poolEngineIds().has(id))
      return err(c, 409, 'engine_in_use', `Stop "${engine.name}" before updating it.`)
    const source = resolveUpdateSource(engine)
    // applyEngineUpdate has no branch for a source-built engine (notify-only "rebuild") or for SGLang.
    if (!source || source.source === 'source' || engine.kind === 'sglang')
      return err(c, 409, 'no_update_source', 'This engine has no automatic update source.')
    const ac = new AbortController()
    // Only the release and GitHub-release branches take the signal: a pip upgrade cannot be cancelled.
    if (source.source !== 'pip') jobs.provisionAbort = ac
    engineWork.engineUpdateInFlight = true
    const startsBefore = d.provision.startCount()
    void applyEngineUpdate(
      { store: d.store, registry: d.registry, manager: d.manager, provision: d.provision, updates: d.updates, modelRouter: d.modelRouter, trigger: 'user_update' },
      engine,
      ac.signal,
    )
      .catch((e) => {
        if (d.provision.startCount() === startsBefore) reportPreStartUpdateFailure(d, engine, e)
      })
      .finally(() => {
        engineWork.engineUpdateInFlight = false
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      })
    return c.json({ accepted: true }, 202)
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
    d.updates.forgetChanged(engines)
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
}

/** A failure before provision.start has not been reported anywhere (applyEngineUpdate
 *  reports everything after it itself), so surface it here or the UI's "Updating…" would
 *  end with no outcome. Opens a user_update run first so the outcome carries the right
 *  trigger and backend. A cancelled update is not a failure. */
function reportPreStartUpdateFailure(d: Deps, engine: Engine, e: unknown): void {
  if ((e as Error)?.name === 'AbortError') return
  d.provision.start(engine.release ? 'github-release' : engine.id, 'user_update')
  d.provision.fail(`Could not update the engine: ${e instanceof Error ? e.message : e}`)
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
 *   - pip kind='mlx-vlm'    → engines/mlx-vlm/venv
 *   - pip kind='vllm'       → engines/vllm/venv
 *   - pip kind='laya'       → engines/laya/venv
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
  // pip: mlx-vlm venv
  if (eng.kind === 'mlx-vlm') {
    const d = join(enginesRoot, 'mlx-vlm', 'venv')
    return inside(d) ? d : null
  }
  // pip: laya venv
  if (eng.kind === 'laya') {
    const d = join(enginesRoot, 'laya', 'venv')
    return inside(d) ? d : null
  }
  // pip: litert-lm venv (its per-port config files are removed by the purge caller)
  if (eng.kind === 'litert-lm') {
    const d = join(enginesRoot, 'litert-lm', 'venv')
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

/** The user's pick ends an Android fallback to the CPU server, so the SDK's return does not undo it (MAJ-1). Called by
 *  the activate route, not Registry.activate, which the Android reconciler and the update paths call too. */
function forgetAndroidSdkFallback(d: Deps): void {
  if (!d.store.snapshot().androidSdkFallback) return
  d.store.update((cfg) => {
    delete cfg.androidSdkFallback
  })
}
