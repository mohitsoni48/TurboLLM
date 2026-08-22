import type { Context } from 'hono'
import type { Deps } from '../deps'

/** The one predicate every Turbo Link surface asks before doing anything (ADR-376).
 *
 *  Turbo Link is fully built, green, and has **never been verified against a real second
 *  machine** — so it ships behind the user-facing `daemon.experimental.turboLink` toggle
 *  (Settings → Experimental), off by default, exactly like `memory` and `routines` before
 *  it. This is the two-layer shape those two established: the flag is the master "is this
 *  feature unlocked at all" switch, gating BOTH visibility and behaviour; the feature's own
 *  UI and its own settings stay where they are and simply do not render while it is off.
 *
 *  It is deliberately ONE exported function rather than an inlined
 *  `snapshot().daemon.experimental.turboLink` at each call site: this feature spans a
 *  peer-facing façade, an admin API, a poll loop and a model catalog, and the review history
 *  of ADR-376 is full of findings where one idea grew two implementations that drifted.
 *  A reviewer can grep this symbol and see every gate.
 *
 *  **Fails closed.** A snapshot with no `experimental` block cannot come out of
 *  `normalize()` — which always writes one — so anything reaching here without it is a
 *  half-written or hand-built config, and "off" is the only safe reading. Note the
 *  contrast with `RoutineScheduler.isRoutinesEnabled`, which defaults to always-ENABLED:
 *  that default protects call sites that inject a predicate, and the injected-predicate
 *  gates in this feature (`LinkManager`, `RemoteCatalog`) keep it for the same reason.
 *  This function reads the real config, so it takes the opposite default.
 *
 *  **Exit path (ADR-280).** When Turbo Link graduates, delete this file, the
 *  `turboLink` field in `ExperimentalFeatures`, and the handful of call sites that import
 *  from here — the same removal `experimental.code` got. Nothing else has to change,
 *  which is the point of keeping every check a single call to one symbol. */
export function isTurboLinkEnabled(d: Deps): boolean {
  const daemon = d.store.snapshot().daemon as { experimental?: { turboLink?: boolean } } | undefined
  return daemon?.experimental?.turboLink === true
}

/** The typed error code every disabled Turbo Link surface answers with.
 *
 *  Distinct and specific ON PURPOSE. The obvious alternative — letting the façade 404 —
 *  is actively harmful across a link: `/api/link/v1` is a VERSIONED contract between two
 *  independently-updated installs, so a peer reads a 404 there as "that host is too old
 *  for link API v1" and sends its user hunting for an upgrade that does not exist. A 403
 *  naming the flag tells them the true thing: the other machine has the feature switched
 *  off, and a human on that machine has to turn it on. */
export const TURBO_LINK_DISABLED_CODE = 'turbo_link_disabled'

/** What a PEER is told. Names the setting the host's owner has to flip, and nothing else —
 *  a disabled host discloses no machine identity, no grant, and no model list. */
export const TURBO_LINK_DISABLED_HOST_MESSAGE =
  'Turbo Link is switched off on this machine. Its owner can turn it on in Settings → Experimental.'

/** What the LOCAL user is told, on their own admin API. Same wording style as
 *  `ROUTINES_DISABLED_MESSAGE` (routine-routes.ts). */
export const TURBO_LINK_DISABLED_MESSAGE =
  'Turbo Link is an experimental feature and is off by default — turn it on in Settings → Experimental first.'

/** Refuse one request. `message` differs by audience (see the two constants above); the
 *  code never does, so a peer and a local client can be handled by the same client code. */
export function turboLinkDisabled(c: Context, message: string): Response {
  return c.json({ error: { code: TURBO_LINK_DISABLED_CODE, message } }, 403)
}
