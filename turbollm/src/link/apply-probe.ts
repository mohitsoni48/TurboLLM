import { describeStatus, nextStatus } from './link-state'
import type { LinkProbe } from './link-state'
import type { LinkRecord } from './types'

/** Apply the result of ONE probe to a mutable `LinkRecord` in place.
 *
 *  Shared by `LinkManager.probeOnce` (the peer's background poll loop) and the admin
 *  routes' single-shot probe (`POST`/`PATCH /api/v1/links`), so the machineId-change
 *  protection below can never drift between the two call sites the way it already did
 *  once — the admin route had its own copy that silently dropped the check.
 *
 *  A changed machineId means this URL now serves a DIFFERENT box (a reused tunnel
 *  hostname, most commonly). Flag it loudly via `lastError` rather than silently
 *  adopting the new identity — a stranger's daemon must never quietly inherit a link
 *  the user believes points at their workstation. */
export function applyProbeResult(l: LinkRecord, probe: LinkProbe): void {
  const status = nextStatus(l.status, probe)
  l.status = status
  if (probe.kind === 'ok') {
    l.grantedCapabilities = probe.capabilities
    l.linkApiVersion = probe.version
    l.lastError = l.machineId && l.machineId !== probe.machineId
      ? `This URL now answers as a different machine than the one you linked.`
      : null
    l.machineId = probe.machineId
    l.lastSeenAt = new Date().toISOString()
  } else {
    l.lastError = describeStatus(status, l.name)
  }
}
