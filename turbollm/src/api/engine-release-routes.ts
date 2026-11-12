// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { existsSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Deps } from '../deps'
import { isLocalOrAuthenticated } from '../auth'
import { GithubRateLimitError } from '../engines/download'
import { assetKey, classifyReleaseAsset, parseRepoInput, rankReleaseAssets, releaseByTag, ReleaseNotFoundError, resolveInstallableRelease } from '../engines/release-assets'
import { currentHostProfile, installReleaseAsset, RELEASE_INSTALL_MARKER, releaseInstallDirName } from '../engines/release-install'
import { recordReleaseUpdate, releaseSwapBlockReason } from '../engines/update-apply'
import { isEngineInBuildDir, sourceBuildDirOf } from '../engines/build-runner'
import { gcAbandonedZipInstalls, packagedAndroidApp } from '../engines/zip-install'
import { err, body } from './http'
import { engineWork, engineWorkBusy, autoTuneUpdateBlock, ENGINE_ENABLE_BUSY, type EngineJobs } from './engine-work'

/** Installing an engine from a GitHub release (ADR-453). */
export function registerEngineReleaseRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
  // Install an engine from a GitHub release (ADR-453): list a repo's builds, start one
  // install, watch it, discard an unconfirmed result. Registered before PUT/DELETE
  // /engines/:id, which would otherwise swallow "release".
  const releaseGuard: MiddlewareHandler = async (c, next) => {
    const method = c.req.method
    const site = c.req.header('sec-fetch-site')
    if (method !== 'GET' && site && site !== 'same-origin' && site !== 'none')
      return err(c, 403, 'forbidden', 'Engine installs must come from the TurboLLM app itself.')
    // The flow ends in probe() (executes the downloaded binary) and the listing spends the
    // user's GitHub token quota — same isLocalOrAuthenticated rule as /engines/scan (ADR-394).
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Installing an engine from a release requires a valid API key from a non-host device.')
    if (packagedAndroidApp())
      return err(c, 501, 'android_packaged_app', 'The packaged Android app cannot run downloaded binaries. Install from Termux or a desktop install instead.')
    // Only a new job needs the engine-work slot: DELETE must stay reachable while the job holds it.
    const busy = method === 'POST' ? engineWorkBusy(d) : null
    if (busy) return err(c, 409, 'engine_already_running', busy)
    await next()
  }

  app.get('/api/v1/engines/release/assets', releaseGuard, async (c) => {
    const repo = parseRepoInput(c.req.query('repo') ?? '')
    if (!repo) return err(c, 400, 'invalid_repo', 'Enter a GitHub repository as owner/name or a github.com link.')
    const host = await currentHostProfile()
    try {
      const release = await resolveInstallableRelease(repo, host)
      const assets = rankReleaseAssets(release.assets.map(classifyReleaseAsset), host)
      return c.json({ repo, tag: release.tag, publishedAt: release.publishedAt, prerelease: release.prerelease, fellBack: release.fellBack, assets })
    } catch (e) {
      if (e instanceof ReleaseNotFoundError && e.code === 'no_compatible_asset') {
        const assets = rankReleaseAssets(e.assets.map(classifyReleaseAsset), host)
        return c.json({ error: { code: e.code, message: e.message }, assets }, 404)
      }
      return githubLookupErr(c, e)
    }
  })

  app.post('/api/v1/engines/release/install', releaseGuard, async (c) => {
    const b = await body<{ repo?: string; tag?: string; asset?: string }>(c)
    const repo = parseRepoInput(b.repo ?? '')
    if (!repo) return err(c, 400, 'invalid_repo', 'Enter a GitHub repository as owner/name or a github.com link.')
    if (!b.tag || !b.asset) return err(c, 400, 'invalid_asset', 'tag and asset are required.')
    const plan = { repo, tag: b.tag, asset: b.asset }
    const enginesRoot = join(d.store.dir(), 'engines')
    gcAbandonedZipInstalls(enginesRoot, [...d.registry.list().engines, ...d.registry.customSources()].map((e) => e.binPath))

    // The server re-resolves the asset from GitHub's JSON: no client URL is ever trusted.
    let main: ReturnType<typeof classifyReleaseAsset> | undefined
    try {
      main = (await releaseByTag(repo, plan.tag)).assets.map(classifyReleaseAsset).find((a) => a.name === plan.asset)
    } catch (e) {
      return githubLookupErr(c, e)
    }
    if (!main || main.companion !== null || main.archive === null)
      return err(c, 400, 'invalid_asset', `${plan.asset} is not an installable engine archive in ${repo} ${plan.tag}.`)

    const slug = releaseInstallDirName({ repo, assetKey: assetKey(main.name, plan.tag) })
    const targetDir = join(enginesRoot, 'build', slug)
    const claims = (p: string) => isEngineInBuildDir(p, targetDir)
    const occupant = d.registry.list().engines.find((e) => claims(e.binPath)) ?? d.registry.customSources().find((s) => claims(s.binPath))
    // The occupant's folder as spelled on disk: a repo typed in another case is the same repo (GitHub ignores case),
    // but a case-sensitive file system (Linux) would not find the marker under the typed spelling.
    const occupantDir = occupant ? sourceBuildDirOf(occupant.binPath, enginesRoot) : null
    const installDir = occupantDir && occupantDir.toLowerCase() === targetDir.toLowerCase() ? occupantDir : targetDir
    if (occupant && !existsSync(join(installDir, RELEASE_INSTALL_MARKER)))
      return err(c, 409, 'build_dir_taken', `The build folder "${basename(installDir)}" already belongs to "${occupant.name}" — delete that engine first.`)
    const replaceBlocked = (): string | null => {
      for (const occupantEngine of d.registry.list().engines.filter((e) => claims(e.binPath))) {
        const reason = releaseSwapBlockReason(d, occupantEngine)
        if (reason) return reason
      }
      // Nor the engine auto-tune is running on, which releaseSwapBlockReason reads as idle between two probes: a newer
      // tag of an installed release lands in its folder, an update in place (autoTuneUpdateBlock).
      return autoTuneUpdateBlock(d, (t) => claims(t.binPath))
    }
    const early = replaceBlocked()
    if (early) return err(c, 409, 'engine_in_use', early)
    // The awaits above let another engine job start; re-check before taking the slot.
    const busyNow = engineWorkBusy(d)
    if (busyNow) return err(c, 409, 'engine_already_running', busyNow)

    const ac = new AbortController()
    jobs.releaseAbort = ac
    jobs.provisionAbort = ac
    d.provision.start('github-release', 'user_install')
    jobs.releaseJob.start(plan, async () => {
      try {
        const result = await installReleaseAsset(enginesRoot, plan, {
          slug: basename(installDir),
          blockSwap: replaceBlocked,
          onProgress: (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
          signal: ac.signal,
        })
        if (!result.found) throw noServerBinaryError()
        const prior = d.registry.list().engines.find((e) => claims(e.binPath))
        // A Cancel or a dismissed dialog that landed after the install's last cancel check (a rename waiting out a
        // Windows AV lock on the just-probed exe) stopped nothing, and no client is left to confirm or discard the new,
        // unclaimed build: discard it here, as the dialog would. A dir a remembered source claims is left, as DELETE does.
        if (ac.signal.aborted && !prior && !d.registry.customSources().some((s) => claims(s.binPath))) {
          try { rmSync(join(enginesRoot, 'build', basename(installDir)), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the GC sweeps it */ }
          throw new DOMException('The install was cancelled.', 'AbortError')
        }
        d.provision.done()
        if (!prior) return { kind: 'ready', result }
        recordReleaseUpdate(d.registry, d.updates, prior.id, result)
        return { kind: 'updated', updated: { id: prior.id, name: prior.name }, result }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') d.provision.done()
        else d.provision.fail(`Could not install ${plan.asset}: ${e instanceof Error ? e.message : e}`)
        throw e
      } finally {
        if (jobs.releaseAbort === ac) jobs.releaseAbort = null
        if (jobs.provisionAbort === ac) jobs.provisionAbort = null
      }
    })
    return c.json({ accepted: true }, 202)
  })

  app.get('/api/v1/engines/release/install', releaseGuard, (c) => c.json(jobs.releaseJob.get()))

  // Discard an UNCONFIRMED release install (the dialog was dismissed after the build landed):
  // only a dir this flow marked and nothing claims is removed. Without binPath it cancels the
  // running install instead.
  app.delete('/api/v1/engines/release/install', releaseGuard, (c) => {
    const binPath = c.req.query('binPath')
    if (!binPath) {
      jobs.releaseAbort?.abort()
      return c.json({ ok: true })
    }
    // Not during an Enable's probe of this install (releaseGuard checks the engine-work slot for POST only): a discard
    // then deleted the folder, and the Enable registered an engine whose binary was gone.
    if (engineWork.engineEnableInFlight) return err(c, 409, 'engine_already_running', ENGINE_ENABLE_BUSY)
    const dir = sourceBuildDirOf(binPath, join(d.store.dir(), 'engines'))
    // Never a hidden folder, as DELETE /engines/zip: a purged release install's `.<slug>.purge-<ms>` trash still holds
    // the marker, and an rmSync here would race the purge's own background delete of it (discardPurgeTrash) on the
    // daemon's thread.
    if (!dir || basename(dir).startsWith('.') || !existsSync(join(dir, RELEASE_INSTALL_MARKER)))
      return err(c, 404, 'engine_not_found', 'No unconfirmed release install at that path.')
    const claims = (p: string) => isEngineInBuildDir(p, dir)
    if (d.registry.list().engines.some((e) => claims(e.binPath)) || d.registry.customSources().some((s) => claims(s.binPath)))
      return err(c, 409, 'build_dir_taken', 'That install is in use by an engine — delete the engine instead.')
    rmSync(dir, { recursive: true, force: true })
    // This also purges a dir the user chose to forget, so only the job's own ready result resets the view.
    const result = jobs.releaseJob.get().result
    if (result?.found && result.binPath === binPath) jobs.releaseJob.clear()
    return c.json({ ok: true })
  })
}

function githubLookupErr(c: Context, e: unknown) {
  if (e instanceof GithubRateLimitError)
    return err(c, 429, 'github_rate_limited', 'GitHub’s API rate limit is exhausted. Add a GitHub token in Settings to raise it.')
  if (e instanceof ReleaseNotFoundError) return err(c, 404, e.code, e.message)
  return err(c, 502, 'github_unreachable', `Could not reach GitHub: ${(e as Error)?.message ?? e}`)
}

function noServerBinaryError(): Error {
  return Object.assign(new Error('The release archive does not contain a llama-server binary.'), { code: 'no_server_binary' })
}
