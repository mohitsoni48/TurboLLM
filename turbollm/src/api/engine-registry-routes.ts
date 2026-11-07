// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Deps } from '../deps'
import { NameTakenError } from '../engines/registry'
import { ProbeError, probe } from '../engines/probe'
import { resolveServerBinary, suggestEngineName } from '../engines/scan'
import { isLocalOrAuthenticated } from '../auth'
import { readReleaseMarker } from '../engines/release-install'
import { markBuildComplete, isEngineInBuildDir, sourceBuildDirOf } from '../engines/build-runner'
import { gcAbandonedZipInstalls, installZipEngine, MAX_ZIP_BYTES, packagedAndroidApp, SwapBlockedError, ZipError, ZIP_BUILD_MARKER, zipBuildDirName } from '../engines/zip-install'
import { err, body } from './http'
import { engineWork, engineWorkBusy, autoTuneUpdateBlock, engineBusy, ENGINE_ENABLE_BUSY, type EngineJobs } from './engine-work'
import { sweepPurgeTrash, discardPurgeTrash } from './engine-trash'
import { isCatalogRepo } from './build-routes'

/** Adding an engine: by path, by scan, or by .zip upload; and deleting a Disabled build. */
export function registerEngineRegistryRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
  app.post('/api/v1/engines', async (c) => {
    // Adding an engine probes (executes) a caller-supplied binary. Same isLocalOrAuthenticated
    // rule as the build routes (ADR-394): an OPEN, keyless LAN still can't trigger this, but a
    // caller presenting a verified API key from another device can — the same trust level Code
    // sessions already get for host execution.
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Adding an engine requires a valid API key from a non-host device.')
    const b = await body<{ name?: string; binPath?: string; sourceRepo?: string; sourceBranch?: string; sourceCommit?: string; sourcePatchUrl?: string }>(c)
    if (!b.binPath || !b.binPath.trim()) return err(c, 400, 'invalid_config_value', 'binPath is required.')
    // Not while an update, download, upload or rebuild runs, like DELETE /engines/:id below (an Enable is the undo of
    // a Disable, refused then too). A Disabled source-built card's Delete no longer comes through here: it used to
    // re-register the engine (a probe) and then purge it, and DELETE /engines/build now removes the folder directly.
    { const busy = engineWorkBusy(d, { engineChange: true }); if (busy) return err(c, 409, 'engine_already_running', busy) }
    // Provenance comes from the marker this flow wrote on disk, never from the request body.
    const release = readReleaseMarker(sourceBuildDirOf(b.binPath, join(d.store.dir(), 'engines')))
    // A release install is identified by its marker, never by a source repo (ADR-088, ADR-388):
    // a source repo would hide it from the disabled-engine list and offer a pointless Rebuild.
    const source: Pick<typeof b, 'sourceRepo' | 'sourceBranch' | 'sourceCommit' | 'sourcePatchUrl'> = release
      ? {}
      : { sourceRepo: b.sourceRepo, sourceBranch: b.sourceBranch, sourceCommit: b.sourceCommit, sourcePatchUrl: b.sourcePatchUrl }
    // Held through the probe until the route answers (see engineEnableInFlight); nothing above awaits since the check.
    engineWork.engineEnableInFlight = true
    try {
      const { engine, warning } = await d.registry.add(b.name ?? '', b.binPath, { release: release ?? undefined, ...source })
      // A 1-click build whose own registration failed (a taken name, a probe that timed out) stays marked unfinished on
      // disk. Its Enable (or Add) has just passed the probe: it is this engine's working build now, for boot recovery
      // too. Only a binary in this daemon's own build directory: sourceBuildDirOf maps any .../engines/build/<name>/
      // path (another or a legacy data dir) onto ours, whose build/<name> may be a cut-short tree.
      const buildDir = sourceBuildDirOf(b.binPath, join(d.store.dir(), 'engines'))
      if (buildDir && isEngineInBuildDir(b.binPath, buildDir)) markBuildComplete(buildDir)
      // Same custom-source tracking as the 1-click build completion above — a manually
      // pointed-at binary (with or without a sourceRepo) is just as much a "custom engine"
      // as a self-service build, and deserves the same Disable-survives-as-Enable treatment.
      if (!isCatalogRepo(source.sourceRepo)) {
        d.registry.recordCustomSource({ name: engine.name, binPath: engine.binPath, kind: engine.kind, ...source })
      }
      const confirmed = jobs.releaseJob.get().result
      if (confirmed?.found && confirmed.binPath === b.binPath) jobs.releaseJob.clear()
      // `probe_no_version` is non-blocking (spec 03 §2): the engine is saved, but
      // the response carries a warning flag so the dialog can prompt the user.
      return c.json({ ...engine, warning: warning ?? null }, 201)
    } catch (e) {
      if (e instanceof NameTakenError) return err(c, 400, 'name_already_taken', e.message)
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return err(c, 500, 'internal', (e as Error).message)
    } finally {
      engineWork.engineEnableInFlight = false
    }
  })

  // Guided add (engine overhaul, Phase 3): scan a chosen FOLDER (or a binary file)
  // for the server binary and probe it — read-only preflight for the Add-engine
  // flow. Registration still happens via POST /api/v1/engines. `{found:false}` (200)
  // when no binary turns up; ProbeError → 400 so wrong-OS / timeout reach the UI.
  app.post('/api/v1/engines/scan', async (c) => {
    // Scanning probes (executes) the binary it finds — same isLocalOrAuthenticated rule as
    // POST /engines (ADR-394): an OPEN, keyless LAN can't trigger this by pointing at any path,
    // but an authenticated caller from another device can.
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Engine scanning requires a valid API key from a non-host device.')
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

  // Custom-build .zip upload — the third Add-engine source (after the folder scan above
  // and /build/run). One multipart POST carries the archive; the daemon searches it at ANY
  // depth for llama-server, extracts binary + this platform's shared libraries into
  // {dataDir}/engines/build/<slug>/ (flat, so the Windows loader and the library path the
  // probe/launch paths already set resolve them — including Android/Termux), chmods the
  // binary, and probes — into a temporary sibling first, swapping it in only after the
  // probe succeeded. Same response shape and registration path as /engines/scan, so the
  // Add-engine dialog's confirm step works unchanged, and DELETE ?purge=1 removes the
  // extracted files through the existing sourceBuildDirOf rule — no new delete path.
  // Guards that need only headers and daemon state — deliberately BEFORE bodyLimit: a
  // chunked request (no Content-Length) is fully buffered by bodyLimit before the handler
  // sees it, so a cross-site or unauthenticated POST must be refused, and the upload slot
  // reserved, before up to MAX_ZIP_BYTES of a body nobody validated is held in memory —
  // and so the slot also covers the time the body itself spends streaming in.
  const zipUploadGuard: MiddlewareHandler = async (c, next) => {
    // multipart/form-data needs no CORS preflight, so /api's CORS policy (server.ts) doesn't
    // stop a cross-site POST — refuse anything a browser marks as coming from another site.
    const site = c.req.header('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none')
      return err(c, 403, 'forbidden', 'Engine uploads must come from the TurboLLM app itself.')
    // The upload ends in probe() (executes the extracted binary), and the request itself can
    // replace a build's files — same isLocalOrAuthenticated rule as /engines/scan (ADR-394).
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Uploading an engine zip requires a valid API key from a non-host device.')
    // The packaged Android app's W^X hardening forbids execve() outside nativeLibraryDir —
    // refuse up front instead of extracting files that can never run (Termux is unaffected).
    if (packagedAndroidApp())
      return err(c, 501, 'android_packaged_app', 'The packaged Android app cannot run downloaded binaries. Upload this zip from Termux or a desktop install instead.')
    // Writes under <dataDir>/engines like a provision or a build — never concurrent with either.
    const busy = engineWorkBusy(d)
    if (busy) return err(c, 409, 'engine_already_running', busy)
    // Reserve the slot SYNCHRONOUSLY, before the body streams in: the upload can run for
    // minutes, and this is what keeps a download, a build, or a second upload (another tab,
    // a same-named zip) from starting underneath it — every engineWorkBusy caller sees it
    // until the request ends, the same mutual exclusion /build/run gets from d.build.start.
    engineWork.zipUploadInFlight = true
    try {
      await next()
    } finally {
      engineWork.zipUploadInFlight = false
    }
  }
  app.post('/api/v1/engines/zip', zipUploadGuard, bodyLimit({
    // Content-Length can lie and a chunked request has none — bodyLimit enforces the cap
    // while the body STREAMS in, aborting as soon as the limit is crossed (a chunked body
    // that stays under the cap is still buffered before the handler runs, which is why the
    // header guards above sit ahead of it). The 1 MiB slack over MAX_ZIP_BYTES is the
    // multipart framing, so an exactly-capped archive still reaches the precise
    // file.size check below.
    maxSize: MAX_ZIP_BYTES + 1024 * 1024,
    onError: (c) => err(c, 413, 'zip_too_large', `Engine zips are capped at ${MAX_ZIP_BYTES / (1024 * 1024 * 1024)} GiB.`),
  }), async (c) => {
    let file: File
    try {
      const f = (await c.req.parseBody())['file']
      if (!(f instanceof File)) return err(c, 400, 'invalid_config_value', 'A multipart form with one "file" field is required.')
      file = f
    } catch {
      return err(c, 400, 'invalid_config_value', 'Could not read the uploaded form data.')
    }
    if (file.size > MAX_ZIP_BYTES)
      return err(c, 413, 'zip_too_large', `Engine zips are capped at ${MAX_ZIP_BYTES / (1024 * 1024 * 1024)} GiB.`)
    const enginesRoot = join(d.store.dir(), 'engines')
    gcAbandonedZipInstalls(enginesRoot, [...d.registry.list().engines, ...d.registry.customSources()].map((e) => e.binPath))
    // A same-named zip replaces this flow's OWN prior install in place (rebuild semantics
    // — proven by the marker installZipEngine writes); any OTHER claim on the folder is
    // refused instead of deleted: a registered engine that is merely STOPPED would lose
    // its files (a 1-click git build made before ADR-387 slugs to the bare repo name, so
    // ik_llama.cpp.zip collides with an ik_llama.cpp build, clone included), and a
    // remembered custom source is a Disabled engine's Enable path.
    const targetDir = join(enginesRoot, 'build', zipBuildDirName(file.name))
    const claims = (p: string) => isEngineInBuildDir(p, targetDir)
    const occupant =
      d.registry.list().engines.find((e) => claims(e.binPath)) ??
      d.registry.customSources().find((s) => claims(s.binPath))
    // The occupant's folder as spelled on disk, as for a release install: claims() ignores case, but a case-sensitive
    // file system (Linux) would not find the marker under the upload's spelling, so re-uploading 'mybuild.zip' over an
    // install from 'MyBuild.zip' was refused as someone else's folder instead of replacing it in place.
    const occupantDir = occupant ? sourceBuildDirOf(occupant.binPath, enginesRoot) : null
    const installDir = occupantDir && occupantDir.toLowerCase() === targetDir.toLowerCase() ? occupantDir : targetDir
    if (occupant && !existsSync(join(installDir, ZIP_BUILD_MARKER)))
      return err(c, 409, 'build_dir_taken', `The build folder "${basename(installDir)}" already belongs to "${occupant.name}" — rename the zip or delete that engine first.`)
    // The replace guard runs before the install AND again at the swap (blockSwap): an
    // engine can be started onto the target files mid-upload.
    const replaceBlocked = (): string | null => {
      // The loaded model's engine counts too: an install or Enable activates another engine without stopping it.
      const r = [d.registry.active(), d.manager.currentOpts()?.engine].find((e) => e && isEngineInBuildDir(e.binPath, targetDir))
      if (r && engineBusy(d)) return `Stop "${r.name}" before replacing its files — the upload extracts over its build folder.`
      // Nor the engine auto-tune is running on, which engineBusy reads as idle between two probes: the same-named
      // re-upload refreshes it in place (autoTuneUpdateBlock).
      return autoTuneUpdateBlock(d, (t) => claims(t.binPath), "replacing this engine's files")
    }
    const early = replaceBlocked()
    if (early) return err(c, 409, 'engine_in_use', early)
    try {
      const res = await installZipEngine(enginesRoot, file.name, Buffer.from(await file.arrayBuffer()), {
        blockSwap: replaceBlocked,
        slug: basename(installDir),
      })
      // The swap already happened. If a registered engine lives in the target dir this
      // was the same-named re-upload — the "update my custom build" case — so refresh
      // THAT engine's probed identity in place (id and name kept; a plain POST /engines
      // would register a second engine on one binary, and purging either would delete
      // the files both use) and tell the dialog it was an update rather than a new engine.
      const prior = res.found ? d.registry.list().engines.find((e) => claims(e.binPath)) : undefined
      if (res.found && prior) {
        d.registry.refresh(prior.id, { version: res.version, capabilities: res.capabilities }, res.binPath)
        return c.json({ ...res, updated: { id: prior.id, name: prior.name } })
      }
      return c.json(res)
    } catch (e) {
      if (e instanceof SwapBlockedError) return err(c, 409, 'engine_in_use', e.message)
      if (e instanceof ZipError) return err(c, e.code === 'zip_too_large' ? 413 : 400, e.code, e.message)
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return err(c, 500, 'internal', (e as Error).message)
    }
  })

  // Remove an UNCONFIRMED zip extraction — the dialog's best-effort cleanup when it is
  // dismissed between an upload and Add (the upload already extracted a possibly-hundreds-
  // of-MB build; nothing registered points at it, so Delete can never reach it). Deliberately
  // narrow: only a dir this flow created (marker) that no registered engine and no remembered
  // custom source points into is removed, so a stray call can never delete a real engine's
  // files; anything unmarked or claimed 409s. Registered before DELETE /engines/:id below —
  // same registration-order discipline as custom-sources, :id would swallow "zip".
  app.delete('/api/v1/engines/zip', (c) => {
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Uploading an engine zip requires a valid API key from a non-host device.')
    // Not during an Enable's probe (see engineEnableInFlight), as DELETE /engines/release/install: nothing claims the
    // install until the Add registers it, so a dialog dismissed while its Add probes (the discard sent on close) deleted
    // the folder, and the Add then registered an engine whose binary was gone.
    if (engineWork.engineEnableInFlight) return err(c, 409, 'engine_already_running', ENGINE_ENABLE_BUSY)
    const enginesRoot = join(d.store.dir(), 'engines')
    const dir = sourceBuildDirOf(c.req.query('binPath') ?? '', enginesRoot)
    // Never a hidden folder: a purged zip install's `.<slug>.purge-<ms>` trash still holds the marker, and an rmSync
    // here would race the purge's own background delete of it (discardPurgeTrash) on the daemon's thread.
    if (!dir || basename(dir).startsWith('.') || !existsSync(join(dir, ZIP_BUILD_MARKER)))
      return err(c, 404, 'engine_not_found', 'No unconfirmed zip install at that path.')
    const claims = (p: string) => isEngineInBuildDir(p, dir)
    if (d.registry.list().engines.some((e) => claims(e.binPath)) || d.registry.customSources().some((s) => claims(s.binPath)))
      return err(c, 409, 'build_dir_taken', 'That install is in use by an engine — delete the engine instead.')
    rmSync(dir, { recursive: true, force: true })
    return c.json({ ok: true })
  })

  // Delete a DISABLED source build (build/<slug>, no registry entry): the Engines screen's Delete on a Disabled
  // source-built catalog card. The purge route only deletes a registered engine's files, so that Delete used to
  // re-register the build through POST /engines first, which probes (runs) the binary: a build whose binary no
  // longer starts (a driver or toolkit change left it unable to load libcuda, a build for another arch) failed the
  // probe or its timeout, and the one build most worth deleting could not be deleted from the UI. Nothing is run
  // here. Only a build/<slug> folder is removed (never a hidden staging or parked one), and only while no registered
  // engine and no remembered custom source points into it and no engine work runs, so a stray call can never delete
  // a live engine's files. Registered before DELETE /engines/:id below, which would swallow "build".
  app.delete('/api/v1/engines/build', (c) => {
    // api_key_required, as the purge and the backend delete answer: the web client opens its key prompt on it. A
    // plain 'forbidden' opened none, so a keyless Serve identity, Access JWT or open-LAN peer's Delete of a Disabled
    // build only toasted, with nowhere to enter the key.
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'api_key_required', "Deleting an engine's files requires a valid API key.")
    // As DELETE /engines/:id: a rebuild or update may be writing into this very folder.
    { const busy = engineWorkBusy(d, { engineChange: true }); if (busy) return err(c, 409, 'engine_already_running', busy) }
    const enginesRoot = join(d.store.dir(), 'engines')
    const dir = sourceBuildDirOf(c.req.query('binPath') ?? '', enginesRoot)
    if (!dir || basename(dir).startsWith('.') || !existsSync(dir))
      return err(c, 404, 'engine_not_found', 'No engine build at that path.')
    const claims = (p: string) => isEngineInBuildDir(p, dir)
    if (d.registry.list().engines.some((e) => claims(e.binPath)) || d.registry.customSources().some((s) => claims(s.binPath)))
      return err(c, 409, 'build_dir_taken', 'That build is in use by an engine — delete the engine instead.')
    // As the purge: renamed aside first, then deleted in the background after the reply (discardPurgeTrash). A
    // recursive rmSync here held the daemon's only thread for the whole multi-GB tree, plus up to 1.5 s of blocking
    // retry back-off per locked entry: every request, /status poll and token stream stalled meanwhile. The rename
    // also makes the Delete all or nothing.
    sweepPurgeTrash(dirname(dir))
    const trash = join(dirname(dir), `.${basename(dir)}.purge-${Date.now()}`)
    try {
      renameSync(dir, trash)
    } catch (e) {
      // A Windows AV or indexer lock: Windows refuses the rename while any file under the folder is open, and reports
      // a lock as EBUSY, EPERM or EACCES, the codes a permission error has too, so the OS error goes along. Nothing
      // has changed: the folder is whole and the card still offers the Delete.
      return err(c, 409, 'engine_files_locked', `Some of the build's files are still in use — try again in a moment. (${(e as Error).message})`)
    }
    void discardPurgeTrash(trash)
    return c.json({ ok: true })
  })
}
