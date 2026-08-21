// Turbo Link (ADR-376 phase 3, task 4): merging this machine's rows with every linked
// machine's rows into ONE list, as a PURE function.
//
// The Models / Downloads / Engines screens all have the same shape of problem — a local
// list, plus N remote lists that each belong to a machine which may or may not be
// reachable — so the merge lives here, generic over the row type, and the screens only
// render what comes back. That split is what makes "an offline machine contributes no rows
// but never silently vanishes" a unit-tested property instead of a thing three separate
// components have to remember.
import type { LinkStatus, LinkSummary } from './link-api'

/** Where a merged row came from. A remote origin carries the link **id** as well as the
 *  machine name: the name is what the user reads, but it is user-editable and not unique,
 *  and the id is what actually addresses the host. */
export type FleetOrigin =
  | { kind: 'local' }
  | { kind: 'remote'; linkId: string; machine: string }

export interface FleetRow<T> {
  origin: FleetOrigin
  row: T
}

/** One remote machine's contribution to the fleet: the link, plus whatever rows the peer
 *  has cached for it. */
export interface FleetSource<T> {
  link: LinkSummary
  rows: T[]
}

/** A machine's header line — what the UI renders for a machine whether or not it produced
 *  any rows. See `fleetMachines`. */
export interface FleetMachine {
  linkId: string
  machine: string
  status: LinkStatus
  /** The actionable sentence for a non-online machine — the link's own `lastError` where
   *  it has one — or `null` when the machine is online and there is nothing to explain. */
  note: string | null
  /** How many rows this machine contributed to `mergeFleet`. Zero for every non-online
   *  machine, by design. */
  rowCount: number
}

/** Why a non-online machine has no rows, when the link itself didn't say. NAMES the
 *  machine: a fleet can hold several, so a bare "Not reachable." would not tell the user
 *  which one to go and wake up.
 *
 *  THE one copy. `remote-models.ts` used to carry a second, shorter version that collapsed
 *  `revoked` and `incompatible` into "is not reachable" — the exact collapse the wire type
 *  refuses to make, because the three states have three different fixes. A comment claiming
 *  the two "mirror" each other is not a mirror; importing this is. */
export function statusNote(name: string, status: LinkStatus): string {
  switch (status) {
    case 'unknown':
      return `${name} has not been checked yet.`
    case 'revoked':
      return `${name} revoked this link.`
    case 'incompatible':
      return `${name} is running an incompatible version of TurboLLM.`
    case 'unreachable':
      return `${name} is not reachable.`
    case 'online':
      return ''
    default: {
      // A new LinkStatus member must be handled here, not fall through to `undefined`.
      const never: never = status
      return never
    }
  }
}

/** True when a machine's rows may be shown at all.
 *
 *  Anything but `online` contributes ZERO rows, whatever the peer still has cached — the
 *  same rule `RemoteCatalog` enforces server-side and `groupModelChoices` enforces in the
 *  chat picker. A listed-but-unusable row is worse than an absent one: the user clicks it
 *  and the action 503s. `fleetMachines` is how the machine still gets said out loud. */
function contributesRows(link: LinkSummary): boolean {
  return link.status === 'online'
}

/**
 * Merge the local rows with every linked machine's rows.
 *
 * Ordering is fully determined by the arguments: local rows first in the order given, then
 * each machine's rows in the order the caller listed the links, each machine's block
 * contiguous. Nothing here sorts, and nothing here iterates an object's keys — a fleet list
 * that reshuffled itself because a machine went offline and came back, or because a name
 * was edited, would be unusable.
 *
 * Neither argument is mutated; every returned row is a fresh wrapper around the caller's
 * own row object (the row itself is passed through by reference, not cloned).
 */
export function mergeFleet<T>(local: T[], remote: FleetSource<T>[]): FleetRow<T>[] {
  const out: FleetRow<T>[] = local.map((row) => ({ origin: { kind: 'local' }, row }))
  for (const source of remote) {
    if (!contributesRows(source.link)) continue
    for (const row of source.rows) {
      out.push({
        origin: { kind: 'remote', linkId: source.link.id, machine: source.link.name },
        row,
      })
    }
  }
  return out
}

/**
 * The machine headers for the same fleet, in the same order.
 *
 * This is the other half of `mergeFleet`, and the reason its offline rule is safe: a
 * machine that contributes no rows is still REPRESENTED here, with its status and an
 * actionable note, so the screen can show *why* it is empty instead of the machine simply
 * disappearing from the list. `mergeFleet` alone would make an unreachable machine
 * indistinguishable from one that was never linked.
 */
export function fleetMachines<T>(remote: FleetSource<T>[]): FleetMachine[] {
  return remote.map((source) => {
    const { link } = source
    const online = contributesRows(link)
    return {
      linkId: link.id,
      machine: link.name,
      status: link.status,
      note: online ? null : (link.lastError ?? statusNote(link.name, link.status)),
      rowCount: online ? source.rows.length : 0,
    }
  })
}
