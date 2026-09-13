import type { RemoteProviderId } from '../config/config'
export type { RemoteProviderId }

/** The state machine every provider and the supervisor report in (spec 30 §2.3).
 *
 *  `unavailable` and `needs-setup` are deliberately distinct: "Tailscale is not installed"
 *  and "Tailscale is installed but you are logged out" need different UI and different user
 *  action, and collapsing them into one failure is exactly the generic-red-X the spec
 *  forbids (§7.5). */
export type RemoteState =
  | { kind: 'off' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'needs-setup'; reason: string }
  | { kind: 'starting' }
  | { kind: 'connected'; url: string; since: string }
  | { kind: 'reconnecting'; attempt: number; lastError: string }
  | { kind: 'failed'; reason: string }

export type PreflightState = Extract<RemoteState, { kind: 'unavailable' | 'needs-setup' | 'off' }>

export interface RemoteProvider {
  readonly id: RemoteProviderId
  /** 'child-process' — we own a spawned process, and the pidfile orphan-safety net applies.
   *  'system-state' — we mutate a system daemon's persistent config and own NO process, so
   *  stop() must actively reset it and startup must reconcile a stale one; without that,
   *  turning the toggle off leaves the box exposed.
   *  'none' — the user runs their own tunnel; we only record the URL. */
  readonly lifecycle: 'child-process' | 'system-state' | 'none'
  /** Usable on this box right now? If not, exactly why — in words a user can act on. */
  preflight(): Promise<PreflightState>
  start(ingressPort: number): Promise<{ url: string }>
  stop(): Promise<void>
  /** Cheap liveness, polled by the supervisor between end-to-end health probes. */
  alive(): boolean
}
