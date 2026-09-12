import type { Deps } from '../deps'

/** The one predicate every remote-access surface asks before doing anything (ADR-422).
 *
 *  The multi-provider feature is complete but has never run against a real Tailscale, ngrok
 *  or Cloudflare-named account, so it ships behind `daemon.experimental.remoteAccess`
 *  (Settings → Experimental), off by default — the same two-layer shape `memory`,
 *  `routines` and `turboLink` established.
 *
 *  **This gate does NOT cover Phase 1's ingress listener or isTunneled.** Those are a
 *  security fix for the `--tunnel` path already live in shipped versions, and gating a
 *  security fix behind an opt-in flag would be wrong (spec 30 §8.1). Nor does it cover
 *  `--tunnel` itself, which deploy/kaggle and deploy/runpod depend on.
 *
 *  **Fails closed.** `normalize()` always writes an `experimental` block, so anything
 *  arriving here without one is a half-written or hand-built config, and "off" is the only
 *  safe reading.
 *
 *  **Exit path (ADR-280).** On graduation, delete this file, the `remoteAccess` field in
 *  `ExperimentalFeatures`, and the call sites that import from here. */
export function isRemoteAccessEnabled(d: Deps): boolean {
  const daemon = d.store.snapshot().daemon as { experimental?: { remoteAccess?: boolean } } | undefined
  return daemon?.experimental?.remoteAccess === true
}

/** The typed body every disabled remote-access route answers with. Distinct from a 404 on
 *  purpose: a caller must be able to tell "switched off on this host" from "this build is
 *  too old to have the route at all". */
export const REMOTE_DISABLED = {
  error: {
    code: 'remote_access_disabled',
    message: 'Remote access is switched off on this host (Settings → Experimental).',
  },
} as const
