import type { RemoteProviderId, RemoteState } from './types'

/** The narrow seam auth.ts needs from remote access (ADR-422, spec 30 §2.2).
 *
 *  Deliberately one method: `auth.ts` must be testable with a two-line fake, and must not
 *  acquire a dependency on the provider machinery that arrives in Phase 2. The full
 *  RemoteAccessManager satisfies this interface; so does `{ ingressPort: () => 6997 }`. */
export interface RemoteIngress {
  /** The loopback port providers connect to, or undefined when nothing is listening. */
  ingressPort(): number | undefined
  /** The provider actually serving the ingress right now — NOT the one saved in config, which
   *  can differ from it. auth.ts trusts Tailscale identity headers only when this is
   *  'tailscale-serve'. Optional so a fake can omit it; absent reads as "none" (fails closed). */
  activeProvider?(): RemoteProviderId | undefined
}

/** What the API and the UI need from remote access, on top of the auth seam. `Deps.remote`
 *  is typed as this; `auth.ts` still only ever calls `ingressPort()`, which is why the
 *  narrow interface above stays separate rather than being folded in here. */
export interface RemoteControl extends RemoteIngress {
  state(): RemoteState
  url(): string | null
  enable(): Promise<void>
  disable(): Promise<void>
}
