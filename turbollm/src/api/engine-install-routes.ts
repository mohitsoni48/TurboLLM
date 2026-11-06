// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { join } from 'node:path'
import type { Engine } from '../config/config'
import type { Deps } from '../deps'
import { provisionTurboquant } from '../engines/download'
import { computeUpdateStatus, type UpdateStatus } from '../engines/update'
import { releaseSwapBlockReason } from '../engines/update-apply'
import { ensureVllmEnv } from '../engines/vllm'
import { ensureSglangEnv } from '../engines/sglang'
import { ensureLitertLmEnv } from '../engines/litert-lm'
import { ensureKoboldcpp, koboldcppBinPath } from '../engines/koboldcpp'
import { ensureLlamafile, llamafileBinPath } from '../engines/llamafile'
import { catalogEngine } from '../engines/catalog'
import { isEngineInBuildDir } from '../engines/build-runner'
import { getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { stopEngineUsers } from '../engines/serving'
import { err } from './http'
import { engineWork, engineWorkBusy, autoTuneUpdateBlock, type EngineJobs } from './engine-work'

/** One-click installs of the vLLM, SGLang, LiteRT-LM, TurboQuant, KoboldCpp and llamafile engines. */
export function registerEngineInstallRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
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
        d.provision.start('vllm', 'runtime_env')
        const rt = await ensureVllmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addVllm(`vLLM (${rt.version})`, rt.python, rt.version)
        if (!upgrade || d.registry.active()?.kind === 'vllm') d.registry.activate(eng.id) // an update keeps the active engine, read now (see MLX)
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
        d.provision.start('sglang', 'runtime_env')
        const rt = await ensureSglangEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
        const eng = d.registry.addSglang(`SGLang (${rt.version})`, rt.python, rt.version)
        if (!upgrade || d.registry.active()?.kind === 'sglang') d.registry.activate(eng.id) // an update keeps the active engine, read now (see MLX)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install SGLang: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'sglang' }, 202)
  })

  // Provision the LiteRT-LM engine: uv → venv → `uv pip install litert-lm` (a small wheel that bundles its native
  // runtime — no torch/CUDA), then register as a kind='litert-lm' engine. 202 + progress via GET /status
  // engineProvision. ?update=1 upgrades litert-lm to the latest release (passes -U to uv pip install), but only
  // after an honest upstream check: when the registered engine is already at the real PyPI latest, the route
  // answers `alreadyLatest` WITHOUT provisioning — the old unconditional re-provision lit the global
  // "Downloading…" banner for a no-op every time "Check for update" was clicked (the llama.cpp backends
  // already behaved this way; see /engines/backends/:id/update above). Cancellable via the same channel.
  app.post('/api/v1/engines/litert-lm', async (c) => {
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    // Prefers the daemon's UpdateChecker — it shares the injectable fetcher the /engines/updates
    // route uses, keeps the honest-cache semantics (a cached real answer survives an offline
    // re-check), and lets tests stub the upstream.
    if (upgrade) {
      const registered = d.registry.list().engines.find((e) => e.kind === 'litert-lm')
      // The lookup holds the engine-work slot (up to 15 s), as the backend Update's does: a Disable or Purge of the
      // engine that arrived meanwhile was over before the re-check below, which then passed, and the pip install
      // registered the engine again (and rebuilt the purged venv). Released before that re-check; provision.start
      // then follows with no await.
      engineWork.engineUpdateInFlight = true
      let status: UpdateStatus | null
      try {
        status = registered
          ? await (d.updates
              ? d.updates.check(registered, AbortSignal.timeout(15_000))
              : computeUpdateStatus(registered, undefined, AbortSignal.timeout(15_000))
            ).catch(() => null)
          : null
      } finally {
        engineWork.engineUpdateInFlight = false
      }
      // Only a POSITIVE "already latest" short-circuits, and only when the versions were
      // actually COMPARABLE: update.ts answers `hasUpdate: false, comparable: false` when the
      // installed version can't be ordered against PyPI's latest (an odd or unparsable
      // version string) — answering `alreadyLatest` there would tell the user they're
      // current while quietly refusing the upgrade. Any check failure (offline, engine not
      // registered) still falls through to the old re-provision path, which surfaces its
      // own error.
      if (status && status.latest !== null && status.comparable && !status.hasUpdate) {
        return c.json({ accepted: false, alreadyLatest: true, version: status.latest, engine: 'litert-lm' })
      }
      // The check above let another engine job start (a scheduler auto-update): re-check, or two pip installs share the venv.
      { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    }
    const ac = new AbortController()
    jobs.provisionAbort = ac
    void (async () => {
      try {
        d.provision.start('litert-lm', 'runtime_env')
        // A loaded LiteRT-LM model holds the native library open (file-locked on Windows), so installing
        // into the venv under it fails midway. Keyed on what is RUNNING, not the active engine: an install
        // activates an engine without stopping what is loaded, so the two can differ. (PR #275 arrived
        // with the same guard keyed on the registry's active engine; main's v1.14.5 refinement is kept —
        // it is the stricter of the two and covers the PR's case.)
        if (d.manager.currentOpts()?.engine.kind === 'litert-lm') await d.manager.stopAndWait()
        // A .litertlm model auto-swapped into an extra pool slot holds the same library open while the primary runs
        // something else (or nothing), so it is stopped too, as this route already stops the primary. Not
        // stopEngineUsers: it also stops a primary that merely has LiteRT-LM active, which never held the library.
        for (const e of d.registry.list().engines) if (e.kind === 'litert-lm') await d.modelRouter.stopPoolSlotsOnEngine(e.id)
        const rt = await ensureLitertLmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade, ac.signal)
        const eng = d.registry.addLitertLm(`LiteRT-LM (${rt.version})`, rt.python, rt.version)
        // An update keeps the active engine, read now (see MLX) — for LiteRT-LM especially: an active LiteRT-LM is sent
        // every GGUF.
        if (!upgrade || d.registry.active()?.kind === 'litert-lm') d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') d.provision.done() // user cancelled — nothing failed
        else d.provision.fail(`Could not install LiteRT-LM: ${e instanceof Error ? e.message : e}`)
      } finally {
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })()
    return c.json({ accepted: true, engine: 'litert-lm' }, 202)
  })

  // Provision a catalog fork via GitHub release (ADR-044) — TurboQuant. Downloads
  // the prebuilt llama-server matching this OS/arch/GPU (CUDA on NVIDIA; see download.ts
  // turboquantCandidates), verifies the backend it promised actually loads (retrying the next
  // candidate if not), probes it (it IS llama-server compatible), and registers it as a
  // kind='llama-server' engine. 202 + progress via /status. Hardware with no prebuilt fails
  // with no_release_asset (→ build from source).
  // ?update=1 fetches the latest release and swaps it in only once it is on disk and probes.
  app.post('/api/v1/engines/turboquant', (c) => {
    const entry = catalogEngine('turboquant')
    if (!entry?.repo) return err(c, 500, 'internal', 'TurboQuant catalog entry is misconfigured.')
    if (!entry.platforms.includes(process.platform)) {
      return err(c, 409, 'unsupported_platform', 'TurboQuant has no prebuilt binary for this operating system yet.')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    // An update swaps the build auto-tune may be running on (the same engine as `cur` below; autoTuneUpdateBlock).
    if (upgrade) {
      const tuning = autoTuneUpdateBlock(d, (t) => isEngineInBuildDir(t.binPath, join(root, 'turboquant')))
      if (tuning) return err(c, 409, 'engine_in_use', tuning)
    }
    // Cancellable from the provision banner, like the backend install: the download takes the
    // signal, and an update only swaps the staged release in once it has fully arrived.
    const ac = new AbortController()
    jobs.provisionAbort = ac
    void (async () => {
      try {
        d.provision.start('turboquant', upgrade ? 'user_update' : 'user_install')
        // Update: stop what runs on the install, then let provisionTurboquant stage the latest
        // beside it and swap only on success. Deleting the dir first left the engine pointing at
        // nothing whenever the lookup or download failed (offline, GitHub rate limit, no asset).
        const cur = d.registry.list().engines.find((e) => isEngineInBuildDir(e.binPath, join(root, 'turboquant')))
        if (upgrade && cur) await stopEngineUsers(d, cur.id)
        // An update keeps the entry, and so does an Install that replaced a build this machine can no longer run
        // (needsTurboquantReprovision): re-probe it, or it keeps the old build's version and capabilities (flags and KV
        // types the new build added stay gated off). It is `cur`, found by the path it ran from: a release that moved
        // the binary within the archive lands elsewhere, where a lookup by the new path found nothing and added a
        // second "TurboQuant" (refused as a taken name). Moved to the new path then (repairBinPath probes it too). For
        // an update this runs while the old build is still parked (provisionTurboquant's verify): a new build that
        // fails the probe is swapped back out, and the entry keeps the old build and its version.
        const register = async (bin: string): Promise<Engine> => {
          const kept = cur ?? d.registry.list().engines.find((e) => e.binPath === bin)
          if (!kept) return (await d.registry.add('TurboQuant', bin)).engine
          return kept.binPath === bin ? d.registry.reprobe(kept.id) : d.registry.repairBinPath(kept.id, bin)
        }
        let updated: Engine | undefined
        const bin = await provisionTurboquant(
          root, entry.repo!,
          (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
          ac.signal, {
            replace: upgrade,
            verify: async (b) => { updated = await register(b) },
            // Re-checked at the swap: the download takes minutes, and a model may have been loaded on it meanwhile.
            blockSwap: cur ? () => releaseSwapBlockReason(d, cur) : undefined,
          },
        )
        const eng = updated ?? (await register(bin))
        // An update leaves the active engine as it was (as update-apply.ts and the backend update
        // do): activating it would switch engines under a model running on another. An install
        // activates it. Read now, not before the download: that takes minutes, the activate route
        // allows a switch meanwhile (the stop above left no model running), and a check read
        // before undid it.
        if (!upgrade || (!!cur && d.registry.active()?.id === cur.id)) d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return d.provision.done() // user cancelled
        const msg =
          e instanceof Error && e.message === 'no_release_asset'
            ? 'TurboQuant has no prebuilt binary for this system. Build llama-server from the fork, then use "Add your own engine".'
            : upgrade
              ? `Could not update TurboQuant — your existing build is unchanged: ${e instanceof Error ? e.message : e}`
              : `Could not install TurboQuant: ${e instanceof Error ? e.message : e}`
        d.provision.fail(msg)
      } finally {
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })()
    return c.json({ accepted: true, engine: 'turboquant' }, 202)
  })

  // Provision KoboldCpp (engine overhaul, Phase 4): download the single platform/GPU-
  // matching binary from its GitHub release, register as a kind='koboldcpp' engine.
  // 202 + progress via /status. ?update=1 re-downloads the latest, replacing the existing
  // binary only once the download completed. CUDA build is chosen on NVIDIA; portable build elsewhere.
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
    // Cancellable (as TurboQuant above): the download streams to a `.part`, so the old binary stays.
    const ac = new AbortController()
    jobs.provisionAbort = ac
    void (async () => {
      try {
        d.provision.start('koboldcpp', upgrade ? 'user_update' : 'user_install')
        // Update: stop what runs on the binary (Windows can't replace a running .exe), then
        // re-download over it — never delete it first. Active afterwards only if it still is (see
        // the TurboQuant route above).
        const cur = upgrade ? d.registry.list().engines.find((e) => e.kind === 'koboldcpp' && e.binPath === koboldcppBinPath(root)) : undefined
        if (cur) await stopEngineUsers(d, cur.id)
        const rt = await ensureKoboldcpp(root, hasNvidia, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), ac.signal, {
          replace: upgrade,
          blockSwap: cur ? () => releaseSwapBlockReason(d, cur) : undefined, // re-checked at the swap (see TurboQuant)
        })
        const eng = d.registry.addKoboldcpp(`KoboldCpp (${rt.version})`, rt.binPath, rt.version)
        if (!upgrade || (!!cur && d.registry.active()?.id === cur.id)) d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return d.provision.done() // user cancelled
        const msg =
          e instanceof Error && e.message === 'no_release_asset'
            ? 'KoboldCpp has no prebuilt binary for this operating system/architecture in its latest release.'
            : `Could not install KoboldCpp: ${e instanceof Error ? e.message : e}`
        d.provision.fail(msg)
      } finally {
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })()
    return c.json({ accepted: true, engine: 'koboldcpp' }, 202)
  })

  // Provision llamafile (engine overhaul, Phase 4): download the single portable
  // executable from its GitHub release, register as a kind='llamafile' engine. 202 +
  // progress via /status. ?update=1 re-downloads the latest, replacing the existing
  // binary only once the download completed.
  app.post('/api/v1/engines/llamafile', (c) => {
    const entry = catalogEngine('llamafile')
    if (!entry?.repo) return err(c, 500, 'internal', 'llamafile catalog entry is misconfigured.')
    if (!entry.platforms.includes(process.platform)) {
      return err(c, 409, 'unsupported_platform', 'llamafile is not available for this operating system yet.')
    }
    { const busy = engineWorkBusy(d); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const root = join(d.store.dir(), 'engines')
    const upgrade = c.req.query('update') === '1'
    // As for TurboQuant: not the binary auto-tune is running on (the same engine as `cur` below).
    if (upgrade) {
      const tuning = autoTuneUpdateBlock(d, (t) => t.kind === 'llamafile' && t.binPath === llamafileBinPath(root))
      if (tuning) return err(c, 409, 'engine_in_use', tuning)
    }
    const ac = new AbortController() // cancellable, as KoboldCpp above
    jobs.provisionAbort = ac
    void (async () => {
      try {
        d.provision.start('llamafile', upgrade ? 'user_update' : 'user_install')
        // Update: stop, then re-download over the binary — never delete it first; active
        // afterwards only if it still is (as above).
        const cur = upgrade ? d.registry.list().engines.find((e) => e.kind === 'llamafile' && e.binPath === llamafileBinPath(root)) : undefined
        if (cur) await stopEngineUsers(d, cur.id)
        const rt = await ensureLlamafile(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), ac.signal, {
          replace: upgrade,
          blockSwap: cur ? () => releaseSwapBlockReason(d, cur) : undefined, // re-checked at the swap (see TurboQuant)
        })
        const eng = d.registry.addLlamafile(`llamafile (${rt.version})`, rt.binPath, rt.version)
        if (!upgrade || (!!cur && d.registry.active()?.id === cur.id)) d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return d.provision.done() // user cancelled
        const msg =
          e instanceof Error && e.message === 'no_release_asset'
            ? 'llamafile has no downloadable binary in its latest release.'
            : `Could not install llamafile: ${e instanceof Error ? e.message : e}`
        d.provision.fail(msg)
      } finally {
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })()
    return c.json({ accepted: true, engine: 'llamafile' }, 202)
  })
}
