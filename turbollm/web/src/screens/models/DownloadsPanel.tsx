// Downloads panel (spec 10 §5), now fleet-aware (ADR-376 phase 3, task 6).
//
// Polls this machine's downloads (~1.5s while any job is active) and every ONLINE linked
// machine's queue (~4s, fanned out in `useRemoteDownloads`), merges them with `mergeFleet`
// — local rows first, then each machine's block — and renders one row per job.
//
// The remote half is deliberately NARROWER than the local one, and that asymmetry is the
// point rather than an omission:
//   · Cancel exists on both, gated by `actionState('downloads:write', …)`.
//   · Resume and Remove are LOCAL ONLY. `resumeDownload`/`removeDownload` are local routes
//     with no façade verb behind them, so a remote Resume button could only ever be a
//     silent no-op or a 404 — exactly the "looks wired and is not" failure this feature has
//     already shipped once.
// Every disabled control carries the reason from `actionState`; every refusal that comes
// back from the host renders inline through `describeRemoteFailure`, never as a toast.

import { useState } from 'react'
import { CheckCircle2, Download, RotateCw, X } from 'lucide-react'
import { useDownloads, useDownloadMutations } from '../../lib/queries'
import { useLinks, useRemoteDownloads, useRemoteDownloadActions } from '../../lib/link-queries'
import { mergeFleet, fleetMachines, type FleetOrigin, type FleetRow } from '../../lib/fleet'
import {
  localDownload,
  remoteDownload,
  sourcesByLink,
  type FleetDownload,
} from '../../lib/fleet-sources'
import { actionState } from '../../lib/capability-ui'
import { describeRemoteFailure, type RemoteFailure } from '../../lib/remote-failure'
import type { LinkSummary } from '../../lib/link-api'
import { Button } from '../../components/ui/button'
import { FleetAction, FleetFailure, MachineNotes, OriginBadge } from '../../components/fleet'
import { track } from '../../lib/api'

export function DownloadsPanel() {
  const dlQ = useDownloads()
  const mut = useDownloadMutations()
  const linksQ = useLinks()
  // Host-gated route: a browser off-box 403s, and `?? []` makes that "no links" rather than
  // an error banner on a panel that is mostly about local downloads.
  const links: LinkSummary[] = linksQ.data ?? []
  const remote = useRemoteDownloads(links)
  const remoteActions = useRemoteDownloadActions()

  /** Which row's remote action failed, and what it said. Keyed by row id so two failing
   *  rows show two different reasons rather than one shared banner. */
  const [failures, setFailures] = useState<Record<string, RemoteFailure>>({})

  const local = dlQ.data?.downloads ?? []
  const sources = sourcesByLink(links, remote.rows, (r) => r.linkId).map((s) => ({
    link: s.link,
    rows: s.rows.map(remoteDownload),
  }))
  const rows = mergeFleet(local.map(localDownload), sources)
  const machines = fleetMachines(sources)

  // Nothing anywhere: the panel stays out of the way entirely, exactly as before. Note this
  // is keyed on ROWS, not on links — a fleet with three idle machines shows nothing, rather
  // than a "Downloads" heading that exists only to say three machines are idle.
  if (rows.length === 0) return null

  // Active/queued/paused first, then errored, then completed (terminal) last — applied
  // WITHIN the merged order so local still precedes remote at equal status.
  const rank = (d: FleetDownload) =>
    d.status === 'downloading' || d.status === 'queued' || d.status === 'paused' ? 0
      : d.status === 'error' ? 1 : 2
  const ordered = [...rows].sort((a, b) => rank(a.row) - rank(b.row))
  const activeCount = rows.filter((r) => rank(r.row) === 0).length

  const linkFor = (origin: FleetOrigin): LinkSummary | undefined =>
    origin.kind === 'remote' ? links.find((l) => l.id === origin.linkId) : undefined

  const onCancel = (row: FleetRow<FleetDownload>) => {
    const { origin, row: d } = row
    if (origin.kind === 'local') {
      track('models', 'cancel_download')
      mut.cancel.mutate(d.id)
      return
    }
    track('models', 'cancel_remote_download')
    remoteActions.cancel.mutate(
      { linkId: origin.linkId, downloadId: d.id },
      {
        onError: (e) =>
          setFailures((f) => ({
            ...f,
            [d.id]: describeRemoteFailure(e, linkFor(origin)?.name ?? origin.machine),
          })),
        onSuccess: () => setFailures((f) => { const n = { ...f }; delete n[d.id]; return n }),
      },
    )
  }

  return (
    <div className="mb-5 rounded-lg border border-border bg-panel-2 p-4">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink">
        <Download size={14} className="text-muted" />
        Downloads
        {activeCount > 0 && <span className="text-[12px] font-normal text-muted">· {activeCount} active</span>}
      </div>

      {/* A machine that contributed no rows still gets a line saying why. */}
      <MachineNotes machines={machines} />

      <div className="flex flex-col gap-2">
        {ordered.map((r) => (
          <DownloadRow
            key={`${r.origin.kind === 'remote' ? r.origin.linkId : 'local'}:${r.row.id}`}
            row={r}
            link={linkFor(r.origin)}
            showOrigin={links.length > 0}
            failure={failures[r.row.id]}
            onCancel={() => onCancel(r)}
            onRemove={() => mut.remove.mutate(r.row.id)}
            onResume={() => mut.resume.mutate(r.row.id)}
            cancelling={mut.cancel.isPending || remoteActions.cancel.isPending}
            resuming={mut.resume.isPending}
          />
        ))}
      </div>
    </div>
  )
}

function DownloadRow({
  row,
  link,
  showOrigin,
  failure,
  onCancel,
  onRemove,
  onResume,
  cancelling,
  resuming,
}: {
  row: FleetRow<FleetDownload>
  link: LinkSummary | undefined
  showOrigin: boolean
  failure: RemoteFailure | undefined
  onCancel: () => void
  onRemove: () => void
  onResume: () => void
  cancelling: boolean
  resuming: boolean
}) {
  const { origin, row: d } = row
  const isLocal = origin.kind === 'local'
  const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0
  const inFlight = d.status === 'downloading' || d.status === 'queued' || d.status === 'paused'
  const isDone = d.status === 'done'
  const isError = d.status === 'error'
  const isCancelled = d.status === 'cancelled'
  // paused (a restart-restored job) or errored (a network hiccup) both have a .part file on
  // disk and can continue from that byte offset via Range — LOCAL only; see the module note.
  const canResume = isLocal && (d.status === 'paused' || isError)

  const cancelState = actionState('downloads:write', origin, link)
  const barColor = isError ? 'var(--err)' : isDone ? 'var(--ok)' : 'var(--accent)'

  return (
    <div data-testid={`download-row-${d.id}`} className="rounded-md border border-border bg-panel px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isDone && <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} className="shrink-0" />}
            <span data-testid="download-name" className="truncate text-[13px] font-medium text-ink">{d.name}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-muted">
            {showOrigin && <OriginBadge origin={origin} />}
            <StatusLine d={d} pct={pct} />
          </div>
        </div>

        {canResume && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { track('models', 'resume_download'); onResume() }}
            disabled={resuming}
            title="Resume from where it left off"
          >
            <RotateCw size={13} />
            Resume
          </Button>
        )}

        {inFlight && (
          <FleetAction state={cancelState} onClick={onCancel} busy={cancelling} variant="outline">
            Cancel
          </FleetAction>
        )}

        {/* Remove is list housekeeping on THIS machine's record. A remote row's terminal
            entry belongs to the host's list, so there is nothing here to remove. */}
        {isLocal && (isDone || isError || isCancelled) && (
          <button
            type="button"
            aria-label="Remove from list"
            onClick={() => { track('models', 'remove_download'); onRemove() }}
            className="rounded p-1 text-muted transition-colors hover:text-ink"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {(inFlight || isError) && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${isError ? 100 : pct}%`, background: barColor }}
          />
        </div>
      )}

      {/* A refusal from the host, inline on the row that caused it. */}
      {failure && <FleetFailure failure={failure} onRetry={onCancel} />}
    </div>
  )
}

/** The detail line under the name: progress + speed while active, the completion
 *  confirmation when done, the error text on failure. */
function StatusLine({ d, pct }: { d: FleetDownload; pct: number }) {
  if (d.status === 'done') return <span style={{ color: 'var(--ok)' }}>✓ added to library</span>
  // For a remote row this is `REMOTE_DOWNLOAD_ERROR`, a fixed string — the host's own
  // message never crosses, because for an fs failure it is a full absolute path.
  if (d.status === 'error') return <span style={{ color: 'var(--err)' }}>{d.error ?? 'Download failed'}</span>
  if (d.status === 'cancelled') return <>Cancelled</>
  if (d.status === 'paused') return <>Paused · {fmtSize(d.received)} of {d.total > 0 ? fmtSize(d.total) : '?'}</>
  if (d.status === 'queued') return <>Queued…</>
  return (
    <>
      {pct}% · {fmtSize(d.received)} of {d.total > 0 ? fmtSize(d.total) : '?'}
      {d.bytesPerSec > 0 ? ` · ${fmtSpeed(d.bytesPerSec)}` : ''}
    </>
  )
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`
}
function fmtSpeed(bps: number): string {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`
}
