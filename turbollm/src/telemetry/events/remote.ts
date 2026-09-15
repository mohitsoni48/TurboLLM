/** Remote-access telemetry (ADR-422, Phase 5 Task 22): which provider was chosen, and the
 *  two supervisor transitions worth knowing about in aggregate.
 *
 *  **Deliberately narrower than the Phase 5 plan's illustrative sketch.** The plan describes
 *  a `reason` field carrying things like "health probe failed" or "not installed". Those
 *  strings, as they actually exist in this codebase, are NOT closed vocabulary — `manager.ts`'s
 *  `RemoteState.reason`/`lastError` interpolates `e instanceof Error ? e.message : String(e)`
 *  (an arbitrary child-process/Node error message, which can legitimately contain a hostname,
 *  e.g. a DNS `ENOTFOUND some-tailnet-node.ts.net`) directly into the text. Spec 30 §9 is
 *  absolute — "never log or emit a token, URL, hostname or tailnet name" — and there is no
 *  reliable way to scrub an unbounded upstream error string down to something provably safe.
 *  So these events carry only values that were ALREADY a closed enum one layer down in the
 *  domain model before telemetry ever saw them: `RemoteState.kind` (`reconnecting`/`failed`)
 *  and `PreflightState.kind` (`unavailable`/`needs-setup`) from `remote/types.ts` — never the
 *  free-text `reason`/`lastError` string that lives beside each. Same discipline as
 *  `link.ts`'s `LINK_STATUSES` reusing `link/types.ts`'s `LinkStatus` rather than re-deriving
 *  a telemetry-owned vocabulary from free text.
 *
 *  `provider` is safe as-is: `RemoteProviderId` (config/config.ts) is already a closed set of
 *  six short ids (`cloudflare-quick`, `tailscale-serve`, …) — never a URL, hostname or token. */

import { defineEvent, f } from '../core/define'

/** Mirrors `RemoteProviderId` (config/config.ts)'s six provider ids, duplicated as a literal
 *  rather than imported as a runtime value: config.ts pulls in `node:fs`/`node:os`/`node:crypto`
 *  at module scope for the desktop/CLI daemon, which the Cloudflare Worker cannot bundle
 *  (schema.ts's whole point is staying import-safe for the Worker — see its header comment).
 *  Same discipline as REMOTE_STATE_TRANSITIONS/REMOTE_PREFLIGHT_FAILURE_KINDS below.
 *  `remote.test.ts` imports the real REMOTE_PROVIDERS from config.ts and iterates it against
 *  this file's event schemas, so a provider added to one list and not the other fails a test
 *  instead of silently drifting. */
const REMOTE_PROVIDERS = [
  'cloudflare-quick',
  'cloudflare-named',
  'tailscale-serve',
  'tailscale-funnel',
  'ngrok',
  'custom',
] as const

export const remoteAccessEnabled = defineEvent({
  name: 'remote_access_enabled',
  since: 5,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'Remote access was turned on, for a chosen provider.',
  payload: {
    provider: f.enum(REMOTE_PROVIDERS),
  },
})

export const remoteAccessDisabled = defineEvent({
  name: 'remote_access_disabled',
  since: 5,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'Remote access was turned off.',
  payload: {
    provider: f.enum(REMOTE_PROVIDERS),
  },
})

/** Mirrors the two `RemoteState.kind` values the supervisor is emitted for (`manager.ts`'s
 *  `set()`, reached via `cli.ts`'s `onRemoteState`) — not the full `RemoteState` union.
 *  `connected` is steady state and would flood; `off`/`starting` are not transitions anyone
 *  needs a funnel over. */
export const REMOTE_STATE_TRANSITIONS = ['reconnecting', 'failed'] as const

export const remoteAccessState = defineEvent({
  name: 'remote_access_state',
  since: 5,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'The remote-access supervisor transitioned into reconnecting or failed.',
  payload: {
    provider: f.enum(REMOTE_PROVIDERS),
    state: f.enum(REMOTE_STATE_TRANSITIONS),
  },
})

/** Mirrors `remote/types.ts`'s `PreflightState.kind` values — the only two a preflight
 *  failure can be, per that type's own doc comment ("`unavailable` and `needs-setup` are
 *  deliberately distinct"). */
export const REMOTE_PREFLIGHT_FAILURE_KINDS = ['unavailable', 'needs-setup'] as const

export const remoteAccessPreflightFailed = defineEvent({
  name: 'remote_access_preflight_failed',
  since: 5,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'A remote-access provider preflight check reported it cannot run.',
  payload: {
    provider: f.enum(REMOTE_PROVIDERS),
    state: f.enum(REMOTE_PREFLIGHT_FAILURE_KINDS),
  },
})
