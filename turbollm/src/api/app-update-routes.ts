// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import type { Deps } from '../deps'
import { normalizeUpdatePolicy } from '../engines/update'
import { checkApplyBlockers, currentRunState, detectInstall, spawnUpdateHelper } from '../app-update-apply'
import { emit } from '../telemetry/runtime/typed-emit'
import { appUpdateClicked } from '../telemetry/events/app-update'
import { err, body, regErr } from './http'

/** The app's self-update (check, apply, progress, policy, dismiss) and an engine's update policy. */
export function registerAppUpdateRoutes(app: Hono, d: Deps): void {
  // ---- app self-update check (F-006, ADR-031) ----
  // Is a newer TurboLLM published on npm than the running version? Informational only —
  // npm does the upgrade (`npm i -g turbollm`); we never auto-update the app. Offline-first:
  // serves the cached answer and NEVER fabricates a "latest" it didn't fetch. Non-blocking —
  // a stale (or `?refresh=1`) cache kicks a background re-check and returns the cache now.
  //
  // Since spec 29 B.1 this ALSO carries how the daemon is installed and therefore what the
  // UI may offer: `canSelfUpdate` gates the "Update & restart" button, and `command` is the
  // copyable fallback that keeps the dialog from being a dead end on Docker/source/desktop.
  // Folded into the existing endpoint rather than added beside it deliberately — the pill,
  // the dialog and the Settings section all render off ONE fetch, so they cannot disagree
  // about whether an update exists or what to do about it (spec 29 B.3's "one
  // implementation, two mounts", held on the server side too).
  app.get('/api/v1/app/update', async (c) => {
    const install = await detectInstall()
    const cfg = d.store.snapshot().appUpdate
    const extra = {
      method: install.method,
      canSelfUpdate: install.canSelfUpdate,
      command: install.command,
      note: install.note,
      policy: normalizeUpdatePolicy(cfg.policy),
      dismissedVersion: cfg.dismissedVersion,
    }
    const fallback = { installed: d.version, latest: null, hasUpdate: false, checkedAt: new Date().toISOString(), comparable: false }
    if (!d.appUpdates) return c.json({ ...fallback, ...extra })
    const refresh = c.req.query('refresh') === '1'
    if (refresh || d.appUpdates.isStale()) {
      void d.appUpdates.check(AbortSignal.timeout(10_000)).catch(() => {})
    }
    // 'off' suppresses the whole surface (spec 29 B.4) — reported as "no update" rather
    // than by hiding the field, so the UI needs no second rule for it.
    const status = d.appUpdates.get() ?? fallback
    const suppressed = extra.policy === 'off'
    return c.json({ ...status, ...(suppressed ? { hasUpdate: false } : {}), ...extra })
  })

  // ---- app self-update: apply (spec 29 B.1) ----
  // Everything before this endpoint was informational. This is the one that actually acts:
  // it hands the update to a DETACHED helper and then exits without respawning, because a
  // running daemon cannot have its own package files overwritten (Windows locks
  // node_modules outright; every platform risks a half-written install). See
  // app-update-apply.ts and update-helper.mjs for the mechanism.
  //
  // Refusals are loud and specific. Half-doing an update is the worst outcome available
  // here, so anything in flight that a restart would destroy — a download mid-write, an
  // engine build, a Code session, a model load — blocks with a sentence saying what and why
  // rather than being silently killed.
  app.post('/api/v1/app/update', async (c) => {
    if (!d.appUpdateProgress) return err(c, 501, 'not_supported', 'Self-update is not available in this run mode.')
    if (!d.requestRestart) return err(c, 501, 'not_supported', 'Self-update needs a restartable daemon, which this run mode is not.')

    const install = await detectInstall()
    if (!install.canSelfUpdate) {
      return err(c, 409, 'update_not_supported', install.note || 'This TurboLLM install cannot update itself.')
    }

    const status = d.appUpdates?.get()
    if (!status?.hasUpdate || !status.latest) {
      return err(c, 409, 'no_update', 'There is no newer TurboLLM to install.')
    }

    if (d.appUpdateProgress.isRunning()) {
      return err(c, 409, 'update_in_progress', 'An update is already running.')
    }

    const blocked = checkApplyBlockers({
      // The standing rule (ADR-240): a hard kill mid-write can CORRUPT a download, not
      // merely pause it, so this is checked before every restart — not just the first.
      downloadActive: d.downloads.list().some((x) => x.status === 'downloading' || x.status === 'queued'),
      engineBuildActive: d.build.isActive(),
      engineProvisionActive: d.provision.get().active,
      codeSessionActive: d.codeRuns?.anyActive() ?? false,
      modelLoading: d.manager.status().state === 'starting',
    })
    if (blocked) return err(c, 409, 'update_blocked', blocked)

    const run = currentRunState(d.version)
    const spawned = spawnUpdateHelper({
      dataDir: d.store.dir(),
      method: install.method,
      from: d.version,
      to: status.latest,
      run,
    })
    if (!spawned) {
      d.appUpdateProgress.set('failed', { error: 'Could not start the update helper.', method: install.method })
      return err(c, 500, 'update_failed', 'TurboLLM could not start its updater. Update from your terminal instead.')
    }

    d.appUpdateProgress.set('installing', { from: d.version, target: status.latest, method: install.method, error: null })
    if (d.telemetry) emit(d.telemetry, appUpdateClicked, { method: install.method })

    // Same shape as /daemon/restart: schedule past the response flush so this 202 reaches
    // the browser before the listen socket goes away. `exitOnly` is the difference — the
    // helper, not this process, brings the daemon back.
    const restart = d.requestRestart
    setTimeout(() => restart({ exitOnly: true }), 300).unref()
    return c.json({ ok: true, updating: true, from: d.version, to: status.latest, method: install.method }, 202)
  })

  // Poll the apply. `done`/`failed` are reported by the RESTARTED daemon out of the result
  // file the helper wrote — the process that ran the update is gone by then — so the UI's
  // reconnect-and-confirm step reads a real outcome, not an inference from the version.
  app.get('/api/v1/app/update/progress', (c) => {
    if (!d.appUpdateProgress) return c.json({ state: 'idle', target: null, from: null, method: null, error: null, at: new Date().toISOString() })
    return c.json(d.appUpdateProgress.get())
  })

  // App-level auto-update policy (spec 29 B.4) — the same off|notify|auto vocabulary as the
  // per-engine control below, on purpose: one word must not mean two things in one product.
  app.put('/api/v1/app/update-policy', async (c) => {
    const b = await body<{ policy?: string }>(c)
    if (b.policy !== 'off' && b.policy !== 'notify' && b.policy !== 'auto') {
      return err(c, 400, 'invalid_config_value', 'policy must be off, notify, or auto.')
    }
    const policy = b.policy
    d.store.update((cfg) => {
      cfg.appUpdate.policy = policy
    })
    return c.json({ policy })
  })

  // "Don't show me this one again." Remembers the exact version whose toast was dismissed,
  // daemon-side rather than per-browser — the same install is opened from several browsers
  // and the desktop wrapper, and a per-browser memory would re-nag on every one of them.
  app.post('/api/v1/app/update/dismiss', async (c) => {
    const b = await body<{ version?: string }>(c)
    const version = String(b.version ?? '').trim().slice(0, 64)
    d.store.update((cfg) => {
      cfg.appUpdate.dismissedVersion = version
    })
    return c.json({ dismissedVersion: version })
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
}
