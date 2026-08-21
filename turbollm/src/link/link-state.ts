import type { LinkCapability, LinkStatus } from './types'

export type LinkProbe =
  | { kind: 'ok'; machineId: string; capabilities: LinkCapability[]; version: number }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  | { kind: 'incompatible'; theirVersions: number[] }

/** Pure status transition for one link (spec §4.5).
 *
 *  The latch is ADR-144's lesson, transplanted: on a real Wi-Fi LAN a raw fetch failure
 *  is common, and treating one as "your access was revoked" once wiped an API key the
 *  user was mid-way through typing. So:
 *    - only a genuine 401 ever produces `revoked`;
 *    - once revoked, network failures do NOT downgrade it to `unreachable` — only a
 *      successful probe clears it;
 *    - a 403 is not revocation at all (valid token, missing capability), so it leaves
 *      the status alone;
 *    - any other HTTP error is the host misbehaving, i.e. `unreachable`, not revoked. */
export function nextStatus(current: LinkStatus, probe: LinkProbe): LinkStatus {
  switch (probe.kind) {
    case 'ok':
      return 'online'
    case 'incompatible':
      return 'incompatible'
    case 'http':
      if (probe.status === 401) return 'revoked'
      if (probe.status === 403) return current === 'unknown' ? 'online' : current
      return current === 'revoked' ? 'revoked' : 'unreachable'
    case 'network':
      return current === 'revoked' ? 'revoked' : 'unreachable'
  }
}

/** One actionable sentence per state. Always names the machine — "offline" alone is
 *  useless once there are three links in the list. */
export function describeStatus(status: LinkStatus, name: string): string {
  switch (status) {
    case 'online':
      return `${name} is connected.`
    case 'unreachable':
      return `${name} is offline or unreachable.`
    case 'revoked':
      return `Access to ${name} was revoked. Paste a new link string to reconnect.`
    case 'incompatible':
      return `${name} is running an incompatible version of TurboLLM — update it to link.`
    case 'unknown':
      return `${name} has not been contacted yet.`
  }
}
