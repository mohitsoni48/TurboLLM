/** Turbo Link lifecycle events (ADR-376, Task 11). Emitted from
 *  `api/link-admin-routes.ts` (mint, add) and `link/link-manager.ts` (status
 *  change) — see those files for the call sites.
 *
 *  Counts and enums only, by construction: `link_minted` carries how many
 *  capabilities were granted and which preset (if any) produced them, never
 *  the capability list itself or the model allowlist; `link_added` and
 *  `link_status_changed` carry only `LinkStatus` values. None of these fields
 *  can express a token, a `baseUrl`, a hostname, or a machine name — the raw
 *  token is a live bearer credential (`LinkRecord.token`) and `baseUrl`/the
 *  peer's `machineName` both identify the user's network, exactly the two
 *  things `redactLink` (link/types.ts) already exists to keep off the wire
 *  to the browser; telemetry must hold the same line. `link.test.ts` asserts
 *  this on the serialized payload text, not a parsed object. */

import { defineEvent, f } from '../core/define'
import { OUTCOMES } from '../core/enums'
import { LINK_PRESETS } from '../../link/capabilities'

/** The preset names, derived from `link/capabilities.ts`'s `LINK_PRESETS` record —
 *  the actual domain source of truth used to expand a preset into capabilities —
 *  rather than a second, telemetry-owned copy of the same three strings. A prior
 *  version of this file duplicated the list by hand (wrongly citing `gateway.ts`'s
 *  `HARNESSES` as precedent: that vocabulary has NO other domain source, so telemetry
 *  genuinely owns it there — not the case here, where `link/capabilities.ts` already
 *  existed first). `link-admin-routes.ts`'s mint validation imports `LINK_PRESETS`
 *  directly from the same domain module, so both sides can only ever see the same set. */
export const LINK_PRESET_NAMES = Object.keys(LINK_PRESETS) as [keyof typeof LINK_PRESETS, ...(keyof typeof LINK_PRESETS)[]]

export const linkMinted = defineEvent({
  name: 'link_minted',
  since: 3,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'A host minted a scoped Turbo Link token for another machine.',
  payload: {
    capabilityCount: f.int({ min: 0 }),
    // Absent when the token was built via "Customize" rather than a one-click preset.
    preset: f.enum(LINK_PRESET_NAMES, { optional: true }),
  },
})

/** Mirrors `link/types.ts`'s `LinkStatus`, minus `'unknown'`: a newly added link is
 *  always probed once immediately (`link-admin-routes.ts`'s `POST /api/v1/links`),
 *  and `nextStatus()` (`link/link-state.ts`) never leaves a just-probed link at
 *  `'unknown'` — every probe outcome resolves to one of these four. */
export const LINK_ADDED_OUTCOMES = ['online', 'unreachable', 'incompatible', 'revoked'] as const

export const linkAdded = defineEvent({
  name: 'link_added',
  since: 3,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'A peer added a link to a host and got an immediate probe outcome.',
  payload: {
    outcome: f.enum(LINK_ADDED_OUTCOMES),
  },
})

/** The full `LinkStatus` set (link/types.ts), including `'unknown'` — a status
 *  change's `from` can legitimately be `'unknown'` (the very first probe). */
export const LINK_STATUSES = ['unknown', 'online', 'unreachable', 'revoked', 'incompatible'] as const

export const linkStatusChanged = defineEvent({
  name: 'link_status_changed',
  since: 3,
  consent: 'anon',
  lifecycle: 'per-action',
  description: "A link's status changed on a probe (initial or background poll).",
  payload: {
    from: f.enum(LINK_STATUSES),
    to: f.enum(LINK_STATUSES),
  },
})

/** Where a generation came from, on the machine that actually ran it (spec §5.6).
 *
 *  `'local'` is RESERVED, not dead: nothing emits it today because local per-generation
 *  volume is already covered by the `chat_daily`/`gateway_daily` rollups, which are
 *  deliberately read-only aggregations rather than a write on the hot request path. The
 *  member exists so the dimension means something — "federated" is only separable from
 *  "not federated" if both values are expressible — and so a future local per-generation
 *  event needs no schema change (and therefore no Worker redeploy, ADR-331).
 *
 *  APPEND-ONLY, like `HARNESSES` (events/gateway.ts): the ORDER is part of the event
 *  schema, so a new value goes on the end and never in the middle. */
export const INFERENCE_ORIGINS = ['local', 'link'] as const

/**
 * One generation THIS machine served — the single-attribution event of spec §5.6.
 *
 * Emitted by the **host**, from the Turbo Link façade (`link/link-routes.ts`), because the
 * host is the machine that ran the tokens. The **peer** that took the click and proxied the
 * request out emits nothing for the same generation (see the remote branch in
 * `gateway/gateway.ts`) — otherwise every federated generation is counted twice and every
 * funnel over it is wrong by a factor that grows with the number of linked machines.
 *
 * `since: 3` — the Turbo Link generation, the same one `link_minted`/`link_added`/
 * `link_status_changed` were introduced in. Any funnel over this event must filter on
 * `app.version` FIRST: mixing generations understated a prior activation funnel 10×.
 *
 * Payload is three closed values and nothing else. It structurally cannot express the link
 * token, the host's `baseUrl`, either machine's name, or the model key — the same line
 * `redactLink` (link/types.ts) holds for the browser, held here for telemetry.
 */
export const inferenceServed = defineEvent({
  name: 'inference_served',
  since: 3,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'One generation this machine served, attributed to the machine that did the work.',
  payload: {
    via: f.enum(INFERENCE_ORIGINS),
    // Decided from the upstream response STATUS, so it is honest about what is knowable at
    // that moment: an SSE stream that dies mid-generation was already reported `ok` and is
    // not revised. A "did the whole stream finish" signal would need its own instrumentation
    // on the relay, which is a separate change, not something to fabricate here.
    outcome: f.enum(OUTCOMES),
    streamed: f.bool(),
  },
})
