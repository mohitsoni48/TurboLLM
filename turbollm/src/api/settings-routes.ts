// Internal API routes split out of routes.ts (scalability item 5.1); registered by registerApi in their original order.
import type { Hono } from 'hono'
import type { Config } from '../config/config'
import { Refusal, hostOnlyChange, parseSettingsPatch, settingsView, type SettingEffect } from '../config/settings-schema'
import type { RebindInfo, SettingsPatchResponse } from '../contract/settings'
import type { Deps } from '../deps'
import { endStaleStreams, hostGate } from '../auth'
import { sendConsentChoice } from '../telemetry/consent'
import { stopRemoteAccess } from '../remote/routes'
import { err, jsonBody } from './http'

/** GET and PATCH /api/v1/settings: the UI-exposed settings subset, declared by the SETTINGS table
 *  (config/settings-schema.ts). This module owns only what needs the running daemon: the host-only gate, the side
 *  effects a save names, and the listener rebind. */
export function registerSettingsRoutes(app: Hono, d: Deps): void {
  // ── daemon settings (UI-exposed subset) ──
  app.get('/api/v1/settings', (c) => c.json(settingsView(d.store.snapshot())))

  app.patch('/api/v1/settings', async (c) => {
    // jsonBody, not body(): a body that is not an object is refused, not taken as an empty patch. A JSON null threw at
    // the first field read once, and any other non-object (an array, a string) was an empty patch.
    const b = await jsonBody(c)
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      return err(c, 400, 'invalid_config_value', 'The settings patch must be a JSON object.')
    }
    const stored = d.store.snapshot()
    const parsed = parseSettingsPatch(b as Record<string, unknown>, { stored, remote: d.remote })
    if (parsed instanceof Refusal) return err(c, parsed.status, parsed.code, parsed.message)

    // Some of these settings are credential management or decide who may reach the daemon at all, so they carry
    // hostGate, like /api/v1/keys and every /api/v1/remote/* route. lanAuth alone let three callers that hostGate
    // refuses rewrite them: a keyless Tailscale Serve identity, a verified Cloudflare Access JWT, and any peer on an open
    // LAN (lanBind on, requireApiKey off). They could turn requireApiKey off or lanBind on (rebinding in place), swap the
    // tunnel/ngrok tokens or the Access team/aud (a new team/aud takes effect at once on a running named tunnel, so
    // whoever set it signs their own JWTs from then on, even after requireApiKey is back on), widen the remote token
    // grant, set every tool to allow, put a directory of their own first on the build PATH, replace the stored
    // HF/GitHub/search credentials, or switch on request-body capture to record the host's Code prompts (or switch the
    // request log off). Judged on the outcome rather than on which fields the body names: the change is applied to a
    // copy first, so a Save that echoes lanBind/requireApiKey/port unchanged still works. The served UI's Save sends only
    // the fields edited on the page now, but one in a tab opened before an update still echoes them with every general
    // setting. Which settings are host-only is declared in the SETTINGS table (`hostOnly`).
    //
    // The refusal's code is api_key_required, not forbidden: the web client opens its key prompt on it
    // (auth-signal.ts). With requireApiKey off nothing 401s, so nothing else asks a browser without a valid stored key
    // for one, and a non-loopback bind's owner is such a browser: Docker with a published port (the owner arrives from
    // the bridge address) after turning the requirement off, in a private window, from another origin, or with a
    // revoked key. `field` names the setting for API clients; the message uses the Settings screen's words.
    if (!hostGate(c, d)) {
      const trial = structuredClone(stored)
      parsed.apply(trial)
      const changed = hostOnlyChange(stored, trial)
      if (changed) {
        const message = `Changing ${changed.label} requires a valid API key.`
        return c.json({ error: { code: 'api_key_required', message, field: changed.field } }, 403)
      }
    }

    const before = d.store.snapshot()
    d.store.update(parsed.apply)
    const after = d.store.snapshot()
    for (const effect of parsed.effects) await SAVE_EFFECTS[effect](d, before, after)
    const response: SettingsPatchResponse = { ...settingsView(d.store.snapshot()), rebind: rebindAfterSave(d, before, after) }
    return c.json(response)
  })
}

/** What a save does beyond writing the config, keyed by the effect a SETTINGS row names. The route runs the ones a
 *  body touched, in SETTING_EFFECTS order; each still checks the change it is about. */
const SAVE_EFFECTS: Record<SettingEffect, (d: Deps, before: Config, after: Config) => void | Promise<void>> = {
  // Keep the ToolRegistry in sync, and rebuild the tool definitions so the engine picks up new/changed search
  // providers without a daemon restart.
  rebuildTools: async (d) => {
    d.tools?.updateConfig(d.store.snapshot().tools)
    await d.tools?.buildToolDefinitions()
  },
  // Report the consent choice once, ever (ADR-299 Decision 5). This is the ONLY transmission a machine that chose Off
  // ever makes, and the consent copy is written to say exactly that. Fire-and-forget: the settings save must not wait
  // on, or fail because of, a network call. Only when the level actually CHANGED: the Settings screen sent
  // telemetryLevel with every save (a tab opened before an update still does; the current one sends only edited
  // fields), so saving any unrelated field would otherwise spend the once-ever ping on a "choice" the user never made,
  // and a later real opt-out would go unsent.
  reportConsent: (d, before, after) => {
    if (after.telemetry.level !== before.telemetry.level) void sendConsentChoice(d.store.dir(), after.telemetry.level)
  },
  // "Require an API key" turned on does no rebind, so nothing else ends a stream a keyless open-LAN peer opened while
  // it was off (see endStaleStreams).
  endStaleStreams: (d, before, after) => {
    if (after.daemon.requireApiKey && !before.daemon.requireApiKey) endStaleStreams(d)
  },
  // Experimental → Remote access switched off: from here every /api/v1/remote/* route (Stop included) refuses and the UI
  // hides the section, so a running tunnel would stay public with no way to stop it. Stop it now, as Stop would (spec 30
  // §8.1: flag off → "the supervisor does not run"). Only a UI/config-managed tunnel (`remoteAccess.enabled`): the
  // ungated `--tunnel` override (cli.ts) leaves that false and keeps running.
  stopRemoteAccess: async (d, before, after) => {
    if (before.daemon.experimental?.remoteAccess && !after.daemon.experimental?.remoteAccess && d.store.snapshot().remoteAccess.enabled) {
      await stopRemoteAccess(d)
    }
  },
}

/** A LAN-bind or port change re-points the HTTP listener. Rather than a full daemon restart (which unloads the model),
 *  an in-place rebind keeps everything loaded (spec 08 §2). Scheduled AFTER this response flushes — the rebind drops
 *  in-flight connections. A LAN-only change (same port) is seamless for the browser; a port change needs the client
 *  to hop to the new port (it reads the returned `rebind`). */
function rebindAfterSave(d: Deps, before: Config, after: Config): RebindInfo | undefined {
  const lanChanged = after.daemon.lanBind !== before.daemon.lanBind
  const portChanged = after.daemon.port !== before.daemon.port
  if (!(lanChanged || portChanged) || !d.rebind) return undefined
  const doRebind = d.rebind
  setTimeout(() => doRebind(), 250)
  // The port the listener ends up on: the configured one only when this save changed it — otherwise the rebind keeps
  // the bound port (`--port`/`--addr`, e.g. the Android app's 7000).
  return { portChanged, port: portChanged ? after.daemon.port : (d.bindPort ?? after.daemon.port), lanBind: after.daemon.lanBind }
}
