// Turbo Link (ADR-376 phase 3, task 6): the call-site adaptation between what the existing
// screens already fetch and what `mergeFleet` takes.
//
// `mergeFleet<T>` is generic over ONE row type, but a local model is a `ModelEntry` (with a
// path, a size, engine-compatibility flags) and a remote one is a `RemoteModelInfo` (with
// none of those, because the host does not disclose them). Same for downloads. Rather than
// widen the tested, shared helper's signature, both halves are normalised HERE onto one
// row shape, which is what the dispatch asked for.
//
// The normalisation is not merely mechanical, and that is why it is tested: the adapters
// are the place that decides a remote model has NO size (rendering a local-looking `0 MB`
// would be a lie) and that a local download's `dest`/`url` are DROPPED rather than carried
// (the two halves render through one row component, so a field only one side can populate
// is a column that renders blank — or worse, a host path — for the other).
import type { FleetRow, FleetSource } from './fleet'
import type { LinkStatus, LinkSummary, RemoteDownload } from './link-api'
import type { RemoteModelInfo } from './remote-models'
import type { DownloadRecord, ModelEntry } from './types'

/**
 * Group flat, link-tagged rows into one `FleetSource` per link.
 *
 * Order comes from `links`, never from the rows and never from an object's key order — a
 * fleet list that reshuffled itself because a machine's rows arrived in a different order
 * would be unusable.
 *
 * A link with no rows is KEPT (with an empty array) so `fleetMachines` can still render its
 * header and say why it is empty. A row whose link is unknown is DROPPED: rows can outlive
 * their link by a poll, and rendering one would mean a row whose origin names a machine no
 * longer in the fleet, every action on which would 404.
 */
export function sourcesByLink<T>(
  links: LinkSummary[],
  rows: T[],
  linkIdOf: (row: T) => string,
): FleetSource<T>[] {
  const byLink = new Map<string, T[]>()
  for (const row of rows) {
    const id = linkIdOf(row)
    const list = byLink.get(id)
    if (list) list.push(row)
    else byLink.set(id, [row])
  }
  return links.map((link) => ({ link, rows: byLink.get(link.id) ?? [] }))
}

// ── Models ────────────────────────────────────────────────────────────────────

/** One model row in a merged fleet list, local or remote.
 *
 *  Everything optional here is optional because a REMOTE host does not disclose it. Nothing
 *  in this shape may be invented for a remote row to make a column line up. */
export interface FleetModel {
  /** The BARE model key. Never the qualified `<machine>/<key>` id — the row's `origin`
   *  already carries the machine, and `formatRemoteId` is applied only at the moment an id
   *  travels (chat), not to what the list holds. */
  key: string
  name: string
  quant: string | null
  loaded: boolean
  /** `null` for a remote model: the host sends no size. */
  sizeBytes: number | null
  nativeCtx: number | null
  vision: boolean
  /** The full local entry, present ONLY for a local row. This is what lets the local half
   *  keep every affordance it had before Turbo Link existed (delete, tune, pin, quant
   *  dropdown, engine-compatibility warnings) without the remote half pretending to. */
  entry?: ModelEntry
}

export function localModel(m: ModelEntry): FleetModel {
  return {
    key: m.key,
    name: m.name,
    quant: m.quant ?? null,
    loaded: Boolean(m.loaded),
    sizeBytes: m.sizeBytes ?? null,
    nativeCtx: m.nativeCtx ?? null,
    vision: Boolean(m.vision),
    entry: m,
  }
}

export function remoteModel(m: RemoteModelInfo): FleetModel {
  return {
    key: m.key,
    name: m.name,
    quant: m.quant,
    loaded: m.loaded,
    // Deliberately null, not 0: the host does not send a size, and `0 MB` reads as a fact.
    sizeBytes: null,
    nativeCtx: m.nativeCtx,
    vision: m.vision,
  }
}

// ── Downloads ─────────────────────────────────────────────────────────────────

/** One download row in a merged fleet list. This is exactly the REMOTE shape — the narrow
 *  one — and the local adapter projects down onto it rather than the other way round, so a
 *  field the host redacts can never appear in the shared row component. */
export interface FleetDownload {
  id: string
  name: string
  repo: string
  total: number
  received: number
  status: string
  error: string | null
  bytesPerSec: number
  createdAt: string
}

export function localDownload(d: DownloadRecord): FleetDownload {
  // Field-by-field, NOT a spread. A spread would carry `dest`, `url` and `sha256` into the
  // shared shape the moment someone adds one to `DownloadRecord`, and the shared row
  // component would then be one careless line away from rendering a filesystem path.
  return {
    id: d.id,
    name: d.name,
    repo: d.repo,
    total: d.total,
    received: d.received,
    status: d.status,
    error: d.error,
    bytesPerSec: d.bytesPerSec,
    createdAt: d.createdAt,
  }
}

export function remoteDownload(d: RemoteDownload): FleetDownload {
  return {
    id: d.id,
    name: d.name,
    repo: d.repo,
    total: d.total,
    received: d.received,
    status: d.status,
    error: d.error,
    bytesPerSec: d.bytesPerSec,
    createdAt: d.createdAt,
  }
}

// ── The machine filter ────────────────────────────────────────────────────────

/** One choice in the machine filter. `'all'` and `'local'` are pseudo-ids; everything else
 *  is a link id. */
export interface MachineOption {
  id: string
  label: string
  /** Absent for `all` / `local`; a link's live status otherwise, so the chip can show that
   *  a machine is offline while still being selectable. */
  status?: LinkStatus
}

export const ALL_MACHINES = 'all'
export const LOCAL_MACHINE = 'local'

/**
 * The machine filter's options: everything, then this machine, then every link in order.
 *
 * Every link appears — including offline ones. An offline machine that vanished from the
 * filter could not even be asked about, which is precisely the "a machine silently
 * disappears" failure `fleetMachines` exists to prevent.
 */
export function machineOptions(links: LinkSummary[]): MachineOption[] {
  return [
    { id: ALL_MACHINES, label: 'All machines' },
    { id: LOCAL_MACHINE, label: 'This machine' },
    ...links.map((l) => ({ id: l.id, label: l.name, status: l.status })),
  ]
}

/** Apply the machine filter. Matches on link **id**, never on the machine name: a rename
 *  between two polls would otherwise empty the list the user is looking at. */
export function filterByMachine<T>(rows: FleetRow<T>[], machine: string): FleetRow<T>[] {
  if (machine === ALL_MACHINES) return rows
  if (machine === LOCAL_MACHINE) return rows.filter((r) => r.origin.kind === 'local')
  return rows.filter((r) => r.origin.kind === 'remote' && r.origin.linkId === machine)
}

/** The facets a REMOTE model can be judged on.
 *
 *  The host advertises `vision` and nothing else facet-shaped: `moe`, `nextnLayers` and
 *  `embedding` are read out of the local GGUF file's metadata, which the peer never sees.
 *  So a remote row cannot be said to match those filters — and, crucially, cannot be said
 *  NOT to match them either. */
const REMOTE_KNOWABLE_FACETS = new Set(['all', 'vision'])

/**
 * Does a remote model survive the library's search box and facet chip?
 *
 * The honest rule, and the reason this is a tested function rather than an inline `&&`:
 * when the user picks a facet this side cannot evaluate (MoE, NextN, Embed), remote rows
 * are HIDDEN rather than kept. Keeping them would assert a property nobody checked; and the
 * machine filter plus `fleetMachines` still leave the user a way to see the machine's models,
 * so nothing becomes unreachable — it just stops claiming a match it cannot verify.
 */
export function remoteModelMatches(m: FleetModel, opts: { q: string; facet: string }): boolean {
  if (opts.q && !m.name.toLowerCase().includes(opts.q)) return false
  if (!REMOTE_KNOWABLE_FACETS.has(opts.facet)) return false
  if (opts.facet === 'vision') return m.vision
  return true
}
