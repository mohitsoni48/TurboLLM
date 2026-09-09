/** App auto-update funnel (spec 29 B.5). Complaint #3 — "existing users never update" —
 *  was completely unmeasurable before these: the app knew about updates and had no event
 *  saying whether anyone ever acted on one.
 *
 *  Four events, one per real step, so the funnel is derived from things that happened
 *  rather than from one event's parameter space:
 *    `app_update_available` — this daemon found a newer published version (once per boot,
 *       from cli.ts's post-boot check).
 *    `app_update_clicked`   — the user pressed "Update & restart" (POST /api/v1/app/update
 *       was accepted; a request refused by a pre-check emits nothing, since the user did
 *       not get to update).
 *    `app_update_applied` / `app_update_failed` — the outcome, emitted by the RESTARTED
 *       daemon from the helper's result file, because the process that ran the update is
 *       dead by the time there is an outcome to report.
 *
 *  Every one carries the detected install method, because "did anyone update?" is a
 *  different question per method — a Docker or source install literally cannot press the
 *  button, and averaging them into one rate hides that.
 *
 *  `since: 4` — a new generation. The standing lesson applies with full force here: any
 *  funnel over these MUST filter on `app.version` first. These events do not exist in any
 *  already-installed build, so a population-wide rate computed across versions measures
 *  "how many people are on a version that can emit this" and understates adoption by
 *  whatever fraction of the installed base has not updated — which is the exact quantity
 *  being measured. That circularity is why the version gate is not optional.
 *
 *  Payloads are closed enums only. They structurally cannot carry a path, a version
 *  string, an error message, or a registry URL.
 */

import { defineEvent, f } from '../core/define'

/** The install-method dimension. Mirrors `app-update-apply.ts`'s `InstallMethod` /
 *  `INSTALL_METHODS`, and — unlike `events/link.ts`'s `LINK_PRESET_NAMES`, which imports
 *  its domain source directly — is deliberately written out here instead of imported.
 *
 *  The reason is the Worker: `telemetry-worker/src/index.ts` inlines `schema.ts` at deploy
 *  time, which transitively pulls in every file in `events/`. `app-update-apply.ts` imports
 *  `node:child_process` and `node:fs`, so importing it from an event definition would drag
 *  those into a Cloudflare Workers bundle that has neither. The drift this normally risks
 *  is closed by `app-update.test.ts`, which asserts these two lists are identical — a test
 *  can import both freely, since tests are never bundled.
 *
 *  APPEND-ONLY: the order is part of the event schema, so a new install method goes on the
 *  end of both lists and never in the middle. */
export const APP_INSTALL_METHODS = ['npm_global', 'npx', 'electron', 'docker', 'android', 'source', 'unknown'] as const

/** Why an update did not complete. A closed vocabulary written by THIS codebase, never by
 *  npm, a filesystem, or a user — `other` is the deliberate long-tail catch-all rather
 *  than an excuse to send free text. */
export const APP_UPDATE_FAIL_REASONS = ['daemon_did_not_exit', 'install_failed', 'helper_spawn_failed', 'other'] as const

export const appUpdateAvailable = defineEvent({
  name: 'app_update_available',
  since: 4,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'This daemon found a newer published TurboLLM than the one it is running.',
  payload: {
    method: f.enum(APP_INSTALL_METHODS),
    /** Whether the button was actually offered — the denominator that separates "saw an
     *  update" from "could do anything about it". */
    canSelfUpdate: f.bool(),
  },
})

export const appUpdateClicked = defineEvent({
  name: 'app_update_clicked',
  since: 4,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'The user asked TurboLLM to update and restart itself.',
  payload: {
    method: f.enum(APP_INSTALL_METHODS),
  },
})

export const appUpdateApplied = defineEvent({
  name: 'app_update_applied',
  since: 4,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'An in-app update completed and the daemon came back on the new version.',
  payload: {
    method: f.enum(APP_INSTALL_METHODS),
  },
})

export const appUpdateFailed = defineEvent({
  name: 'app_update_failed',
  since: 4,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'An in-app update did not complete; the previous version is still installed.',
  payload: {
    method: f.enum(APP_INSTALL_METHODS),
    reason: f.enum(APP_UPDATE_FAIL_REASONS),
  },
})
