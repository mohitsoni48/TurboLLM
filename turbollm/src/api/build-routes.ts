// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import { join } from 'node:path'
import type { Engine } from '../config/config'
import type { Deps } from '../deps'
import { nameTakenMessage } from '../engines/registry'
import { isLocalOrAuthenticated } from '../auth'
import { githubHeaders, isRateLimited } from '../engines/download'
import { catalogForPlatform } from '../engines/catalog'
import { checkBuildPrereqs } from '../engines/build-prereqs'
import { runBuild, runPrereqInstall, discardParkedBuild, markBuildComplete, restorePreviousBuild, buildDirName, chooseEngineName, findNameConflict, findPriorEngine, isEngineInBuildDir, normRepoUrl, sameRepo } from '../engines/build-runner'
import { packagedAndroidApp } from '../engines/zip-install'
import { provisionCuda } from '../engines/cuda-provision'
import { API_TIMEOUT_MS } from '../util/fetch-timeout'
import { stopEngineUsers } from '../engines/serving'
import { err, body } from './http'
import { engineWorkBusy, autoTuneUpdateBlock, engineBusy, type EngineJobs } from './engine-work'

/** Compile-from-source (ADR-089/100): prerequisites, branches, the 1-click build and its toolchain installs. */
export function registerBuildRoutes(app: Hono, d: Deps, jobs: EngineJobs): void {
  // Compile-from-source prereq check (ADR-089, macOS/Metal port). Read-only: detects the
  // Windows/Linux + CUDA (or macOS + Metal) build toolchain (git / cmake / CUDA-or-compiler)
  // so the build guide can show what's missing + install links. The configured toolchain
  // dirs (ADR-100) are prepended to PATH so a conda-env / custom-path CUDA Toolkit is found.
  app.get('/api/v1/build/prereqs', async (c) =>
    c.json(await checkBuildPrereqs(d.store.snapshot().build.toolchainDirs)),
  )

  // Fetch the full branch list for a GitHub repo (ADR branch selector). Accepts either a full
  // HTTPS URL or an `owner/repo` identifier — normalises via normRepoUrl so both shapes work.
  // Returns every branch (GitHub paginated, 100/page) with the default branch sorted first;
  // the caller does its own client-side search filtering over the full list.
  app.get('/api/v1/build/git-branches', async (c) => {
    const raw = (c.req.query('repo') ?? '').trim()
    if (!raw) return err(c, 400, 'invalid_input', 'repo is required.')
    const repo = normRepoUrl(raw)
    if (!repo) return err(c, 400, 'invalid_input', 'repo must be a valid GitHub repo identifier.')
    // Exhausted-rate-limit marker. GitHub answers 403 (classic) or 429 (secondary limit) with
    // `x-ratelimit-remaining: 0`; that is NOT a generic outage, so it must reach the UI as its
    // own code rather than collapsing into `offline` — the Engines card keys the "add a GitHub
    // token" hint off it. A 403 WITHOUT that header is a real permission error (private repo,
    // bad token) and stays generic, otherwise we would tell the user to fix a token that is
    // already fine.
    const tokenSet = (d.store.snapshot().gh?.token ?? '').length > 0
    try {
      const names: string[] = []
      // GitHub caps per_page at 100; walk pages until one comes back short (the last page) or
      // a generous cap is hit (protects against an unbounded loop against a huge/malicious repo).
      for (let page = 1; page <= 20; page++) {
        const res = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`, {
          headers: githubHeaders({}, () => d.store.snapshot().gh?.token ?? ''),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
        if (isRateLimited(res))
          return err(
            c,
            403,
            'github_rate_limited',
            tokenSet
              ? 'The configured GitHub token has exhausted its API rate limit (5,000 requests/hour). Branch lookups will work again after the limit resets.'
              : 'GitHub’s unauthenticated API rate limit (60 requests/hour) is exhausted. Add a GitHub token in Settings to raise it to 5,000 requests/hour.',
          )
        if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`)
        const data = (await res.json()) as { name: string }[]
        names.push(...data.map((b) => b.name))
        if (data.length < 100) break
      }
      // Try to detect the default branch from the repo metadata (second request).
      let defaultBranch = ''
      try {
        const info = await fetch(`https://api.github.com/repos/${repo}`, {
          headers: githubHeaders({}, () => d.store.snapshot().gh?.token ?? ''),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
        if (info.ok) {
          const j = await info.json() as { default_branch?: string }
          defaultBranch = j.default_branch ?? ''
        }
      } catch { /* best-effort — caller falls back to 'main' */ }
      const sorted = defaultBranch ? [defaultBranch, ...names.filter((n) => n !== defaultBranch)] : names
      return c.json({ total: sorted.length, branches: sorted })
    } catch (e) {
      return err(c, 503, 'offline', `Could not fetch branches for ${repo}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  // 1-click compile-from-source (ADR-100, Windows/Linux + CUDA, or macOS + Metal). Clones the
  // repo, runs cmake, compiles llama-server, then registers the built binary (the selected engine after a first build,
  // or a rebuild of the selected engine: see the success path).
  // Long-running; 202 immediately + live phase/log via GET /status engineBuild. It executes a
  // compiler from a user-supplied repo, so — same rule as Code's own host execution — a remote
  // caller only reaches this with a verified API key (ADR-394); an OPEN, keyless LAN still
  // cannot trigger it. Turbo Link tokens are unaffected: a granted key is refused earlier, by
  // verifyKeyValue, so it never counts as "authenticated" here regardless of grant.
  app.post('/api/v1/build/run', async (c) => {
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Building an engine requires a valid API key from a non-host device.')
    // Termux (platform 'android') is supported — build-prereqs/runBuild/the catalog's Android
    // source card all handle it. The packaged Android app is not: W^X forbids exec of a built binary.
    const buildPlatform = ['win32', 'linux', 'darwin'].includes(process.platform) || (process.platform === 'android' && !packagedAndroidApp())
    if (!buildPlatform)
      return err(c, 409, 'unsupported_platform', 'In-app build is currently Windows, Linux, macOS, or Android (Termux) only.')
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
    // Both refusals are certain now and cost a second, versus a 15-minute compile that can only end
    // in a registration error (name already held by an engine this build won't replace) or in a
    // running engine's own files being replaced underneath it.
    const engines = d.registry.list().engines
    const conflict = findNameConflict(engines, name, { buildRoot, sourceRepo: repoUrl, sourceBranch: branch, sourceCommit: commit })
    if (conflict) return err(c, 400, 'name_already_taken', nameTakenMessage(conflict, { sourceRepo: repoUrl, sourceBranch: branch }))
    // The loaded model's engine counts too: an install or Enable activates another engine without stopping it.
    const running = [d.registry.active(), d.manager.currentOpts()?.engine].find((e) => e && isEngineInBuildDir(e.binPath, buildRoot))
    if (running && engineBusy(d))
      return err(c, 409, 'engine_in_use', `Stop "${running.name}" before rebuilding it — the rebuild replaces its files.`)
    // Nor the engine auto-tune is running on, which engineBusy reads as idle between two probes: runBuild parks this
    // folder's build before it clones, so the run's next probe found no binary (autoTuneUpdateBlock).
    { const tuning = autoTuneUpdateBlock(d, (t) => isEngineInBuildDir(t.binPath, buildRoot), 'rebuilding this engine'); if (tuning) return err(c, 409, 'engine_in_use', tuning) }
    // Reserve the build slot SYNCHRONOUSLY (before returning 202) so two near-simultaneous
    // POSTs can't both pass the busy-check and race on the same buildRoot / clobber buildAbort.
    const ac = new AbortController()
    jobs.buildAbort = ac
    d.build.start(name ?? repoUrl)
    void (async () => {
      let out: Awaited<ReturnType<typeof runBuild>> | undefined
      // The build this one replaced, parked by runBuild, once the new build is registered: deleted by the finally.
      let replaced: string | undefined
      // A registration that failed put the build it was replacing (or that build's engine) back ('kept'), or put the
      // engine back but could not move the parked build back ('stranded': the log says where it is).
      let previous: 'kept' | 'stranded' | undefined
      try {
        try {
          out = await runBuild(
            { repoUrl, branch, commit, patchUrl, patchSha256, enginesRoot, toolchainDirs },
            { phase: (p) => d.build.phase(p), log: (line) => d.build.log(line) },
            ac.signal,
          )
        } catch (e) {
          // The BUILD step (clone/configure/compile) failed or was cancelled. runBuild itself
          // has already removed the partial tree (so repeated attempts don't fill the disk with
          // multi-GB CUDA objects) and put back the build it was replacing — deleting buildRoot
          // here would throw away that working build. Never GC after a binary was successfully
          // produced either (that would throw away a good build over a mere registration hiccup).
          if ((e as Error)?.name === 'AbortError') {
            d.build.log('Build cancelled.')
            d.build.cancel('Build cancelled.')
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
        // A failure HERE keeps the built binary on disk (no GC) so it isn't thrown away — unless it replaced a build
        // runBuild parked: see the catch below.
        const prior = findPriorEngine(d.registry.list().engines, {
          binPath: out.binPath,
          sourceRepo: repoUrl,
          sourceBranch: branch,
          sourceCommit: commit,
          defaultBranch: out.defaultBranch,
        })
        // `activeAfter`: the engine active once remove() has run (none when it removed the active one: no engine is
        // selected while the new build probes), to tell a later switch by the user from it.
        let removed: { engine: Engine; active: boolean; index: number; activeAfter: string | undefined } | undefined
        let eng: Engine
        try {
          if (prior) {
            await stopEngineUsers(d, prior.id)
            const engine = d.registry.get(prior.id)
            const active = d.registry.active()?.id === prior.id
            const index = d.registry.list().engines.findIndex((e) => e.id === prior.id)
            try {
              d.registry.remove(prior.id)
              if (engine) removed = { engine, active, index, activeAfter: d.registry.active()?.id }
            } catch { /* already gone */ }
          }
          // An empty selection is filled only by a first build (or one of a Disabled build: an install) or by the
          // rebuild of the selected engine, which remove() just left with none selected. With no engine selected,
          // the rebuild of another one must not select it for the user.
          eng = (await d.registry.add(chooseEngineName(name, prior?.name), out.binPath, {
            sourceRepo: repoUrl,
            sourceBranch: branch,
            sourceCommit: commit,
            sourcePatchUrl: patchUrl,
          }, { fillEmptySelection: !prior || !!removed?.active })).engine
        } catch (e) {
          // The new binary does not run here (its probe failed: a CUDA build on a box without the driver, a fork tip
          // that crashes at start) or could not take the name. It sits where the build it replaced ran from, so that
          // build goes back, and so does its registration (same id, name and policy, active if it was): deleting the
          // parked build and leaving the engine unregistered threw away the user's only working build. The engine goes
          // back (at its place in the list) even when the parked build could not be moved back: the next start's
          // restoreInterruptedBuilds puts it back for a registered engine whose directory has no binary.
          // Nothing parked and the engine ran from where the new build landed: its build was gone before this one
          // started (its directory deleted by hand), so there is no previous build to keep, and its registration
          // would now point, under the old version, at the binary that does not run. It stays removed, as before.
          if (removed && !out.prevBuildRoot && removed.engine.binPath === out.binPath) removed = undefined
          const restored = out.prevBuildRoot ? await restorePreviousBuild(out.buildRoot, out.prevBuildRoot, (line) => d.build.log(line)) : true
          // Active again only when no other engine was made active during the probe (seconds; a slow binary can take
          // a minute): making it active over the user's own switch would undo it.
          if (removed) d.registry.reinstate(removed.engine, removed.active && d.registry.active()?.id === removed.activeAfter, removed.index)
          if (out.prevBuildRoot || removed) previous = restored ? 'kept' : 'stranded'
          throw e
        }
        // The binary passed its probe: boot recovery and the next build's sweep keep this build from now on.
        markBuildComplete(out.buildRoot)
        replaced = out.prevBuildRoot
        // A first build, or one of a Disabled build, is made the selected engine, as an install is. A rebuild is the
        // source-built card's update, and like every update (keepActiveAfterUpdate) it stays the selected engine
        // only when it was, and never over a switch the user made while it compiled or probed (the reinstate check
        // above): activating it unconditionally took the selection from the engine the user had picked, and the
        // next automatic load ran on the rebuilt one.
        if (!prior || (removed?.active && d.registry.active()?.id === removed.activeAfter)) d.registry.activate(eng.id)
        // A genuinely custom repo (not one of the catalog's own known projects) needs its
        // identity remembered independent of the live registration — see recordCustomSource's
        // own doc comment. A catalog repo already gets equivalent treatment from the /catalog
        // endpoint's own disk scan, so it's deliberately excluded here.
        if (!isCatalogRepo(repoUrl)) {
          d.registry.recordCustomSource({ name: eng.name, binPath: eng.binPath, kind: eng.kind, sourceRepo: repoUrl, sourceBranch: branch, sourceCommit: commit, sourcePatchUrl: patchUrl })
        }
        d.build.log(`Registered "${eng.name}" — built from ${out.commit.slice(0, 8)}.`)
        // Whether it is the selected engine now, for the web UI's toast, which said so after every build.
        d.build.done({ activated: d.registry.active()?.id === eng.id })
      } catch (e) {
        // Registration/probe failed AFTER a successful build: tell the user it built yet couldn't be
        // registered so they can retry/inspect. The binary is kept (no GC) unless it replaced a build
        // that went back in its place (the catch above), and the failure says whether one did.
        const kept =
          previous === 'kept'
            ? ', so the previous build was kept'
            : previous === 'stranded'
              ? ' (the previous build could not be moved back: the log says where it is kept)'
              : ''
        d.build.fail(`Built successfully, but couldn't register the engine${kept}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (jobs.buildAbort === ac) jobs.buildAbort = null
        // The build this one replaced, parked by runBuild, once the new build is registered.
        // Deleted in the background: an rmSync of the multi-GB tree stalled the whole daemon.
        if (replaced) void discardParkedBuild(replaced)
      }
    })()
    return c.json({ accepted: true }, 202)
  })

  // Cancel an in-progress 1-click build (ADR-100). Kills the child compiler/clone.
  app.post('/api/v1/build/cancel', (c) => {
    if (jobs.buildAbort) {
      jobs.buildAbort.abort()
      return c.json({ ok: true })
    }
    return c.json({ ok: false })
  })

  // Install ONE missing build prerequisite (git / cmake / CUDA / compiler) with the host's own
  // package manager — apt-get / dnf / pacman / zypper on Linux, Homebrew on macOS. For a
  // headless self-hosted box (Docker / a remote Linux server) the prereq list's install LINK is
  // a dead end: clicking it opens a website in the operator's own browser, which installs
  // nothing on the machine that actually needs the toolchain. Windows keeps the link-only
  // behavior — MSVC and the CUDA Toolkit need GUI installers there.
  // Long-running; 202 immediately + live log via GET /status engineBuild (phase 'provisioning'),
  // and failures surface through BuildState.fail exactly like a failed build. It executes a
  // package manager as root, so — the SAME isLocalOrAuthenticated rule as /build/run and
  // /build/cuda (ADR-394) — an OPEN, keyless LAN can never trigger it, but a caller presenting
  // a verified API key from another device can.
  app.post('/api/v1/build/install-prereq', async (c) => {
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Installing build prerequisites requires a valid API key from a non-host device.')
    if (process.platform !== 'linux' && process.platform !== 'darwin')
      return err(c, 409, 'unsupported_platform', 'Installing build prerequisites is currently Linux and macOS only — on Windows these tools need their own installers.')
    const b = await body<{ tool?: string }>(c)
    const tool = (b.tool ?? '').trim()
    if (tool !== 'git' && tool !== 'cmake' && tool !== 'cuda' && tool !== 'gcc')
      return err(c, 400, 'invalid_config_value', 'tool must be one of: git, cmake, cuda, gcc.')
    const busy = engineWorkBusy(d)
    if (busy) return err(c, 409, 'engine_already_running', busy)
    const toolchainDirs = d.store.snapshot().build.toolchainDirs
    const ac = new AbortController()
    jobs.buildAbort = ac
    d.build.start(tool, { toolInstall: true })
    d.build.phase('provisioning')
    void (async () => {
      try {
        await runPrereqInstall({ tool, toolchainDirs }, { phase: (p) => d.build.phase(p), log: (line) => d.build.log(line) }, ac.signal)
        d.build.done()
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          d.build.log('Install cancelled.')
          d.build.cancel('Install cancelled.')
        } else {
          d.build.fail(`Could not install ${tool}: ${e instanceof Error ? e.message : String(e)}`)
        }
      } finally {
        if (jobs.buildAbort === ac) jobs.buildAbort = null
      }
    })()
    return c.json({ accepted: true }, 202)
  })

  // Auto-download a CUDA Toolkit from NVIDIA's redistributable archives (ADR-101) when the
  // user has no CUDA installed, so the 1-click build can compile. Streams via the same
  // engineBuild channel (phase 'provisioning'); on success the toolkit's bin dir is added to
  // build.toolchainDirs so the prereq check + build immediately find nvcc. Same
  // isLocalOrAuthenticated rule as the rest of this build group (ADR-394); Windows-only.
  app.post('/api/v1/build/cuda', async (c) => {
    if (!isLocalOrAuthenticated(c, d))
      return err(c, 403, 'forbidden', 'Downloading CUDA requires a valid API key from a non-host device.')
    if (process.platform !== 'win32')
      return err(c, 409, 'unsupported_platform', 'Automatic CUDA download is currently Windows x86_64 only.')
    const busy = engineWorkBusy(d)
    if (busy) return err(c, 409, 'engine_already_running', busy)
    const dataDir = d.store.dir()
    const ac = new AbortController()
    jobs.buildAbort = ac
    d.build.start('CUDA Toolkit', { toolInstall: true })
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
          d.build.cancel('CUDA download cancelled.')
        } else {
          d.build.fail(`Could not download CUDA: ${e instanceof Error ? e.message : String(e)}`)
        }
      } finally {
        if (jobs.buildAbort === ac) jobs.buildAbort = null
      }
    })()
    return c.json({ accepted: true }, 202)
  })
}

/** True when `repoUrl` matches a known catalog engine's homepage (llama.cpp, TurboQuant, …).
 *  Gates {@link Registry.recordCustomSource}: a catalog repo already gets its own re-enable
 *  detection (the /catalog endpoint's `sourceBuildBinary(enginesRoot, e.homepage)` scan, keyed
 *  by that fixed, hardcoded URL) — recording it as a "custom" source too would just duplicate
 *  that, and could show the SAME build as two different cards. */
export function isCatalogRepo(repoUrl: string | undefined): boolean {
  if (!repoUrl) return false
  return catalogForPlatform().some((e) => sameRepo(repoUrl, e.homepage))
}
