import { describeStatus, nextStatus } from './link-state'
import type { LinkProbe } from './link-state'
import type { HelloResponse, LinkRecord } from './types'

/** The one warning copy for a hijacked URL. Exported so the UI and the tests assert the
 *  same string instead of two hand-copied ones. */
export const MACHINE_CHANGED_WARNING =
  'This URL now answers as a different machine than the one you linked.'

/** Apply the result of ONE probe to a mutable `LinkRecord` in place.
 *
 *  Shared by `LinkManager.probeOnce` (the peer's background poll loop) and the admin
 *  routes' single-shot probe (`POST`/`PATCH /api/v1/links`), so the machineId-change
 *  protection below can never drift between the two call sites the way it already did
 *  once — the admin route had its own copy that silently dropped the check.
 *
 *  THE ONLY record mutator. Every rule that turns a probe into record state belongs
 *  here, including the display-name rule: it used to live at the admin call site alone,
 *  which meant the same probe produced a different record depending on which code path
 *  ran it, and clobbered a user's rename on the very same request that set it.
 *
 *  A changed machineId means this URL now serves a DIFFERENT box (a reused tunnel
 *  hostname, most commonly). It is LATCHED into `machineIdChanged` rather than written
 *  to `lastError` and forgotten — a stranger's daemon must never quietly inherit a link
 *  the user believes points at their workstation, and a warning the next poll erases is
 *  no warning at all. Only an explicit acknowledgement clears it. */
export function applyProbeResult(
  l: LinkRecord,
  probe: LinkProbe & { raw?: Pick<HelloResponse, 'machineName'> },
): void {
  const status = nextStatus(l.status, probe)
  l.status = status
  if (probe.kind === 'ok') {
    // "Never handshaken before" is the ONLY moment the host gets to name this link: the
    // name was seeded from the URL's hostname when the record was created, and from here
    // on it is the user's field (PATCH { name }).
    const firstHandshake = l.machineId === null
    l.grantedCapabilities = probe.capabilities
    l.linkApiVersion = probe.version
    if (l.machineId !== null && l.machineId !== probe.machineId) l.machineIdChanged = true
    l.lastError = l.machineIdChanged ? MACHINE_CHANGED_WARNING : null
    l.machineId = probe.machineId
    l.lastSeenAt = new Date().toISOString()
    if (firstHandshake && probe.raw?.machineName) l.name = probe.raw.machineName
  } else {
    // The latch is rendered from `machineIdChanged` in its own right, so a failing probe
    // still gets to say why it failed without the warning being lost.
    l.lastError = describeStatus(status, l.name)
  }
}
