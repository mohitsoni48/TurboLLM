// Downloads panel (spec 10 §5), now fleet-aware (ADR-376 phase 3, task 6).
//
// Polls this machine's downloads (~1.5s while any job is active) and every ONLINE linked
// machine's queue (~4s, fanned out in `useRemoteDownloads`), merges them with `mergeFleet`
// — local rows first, then each machine's block — and renders one row per job.
//
// The remote half is deliberately NARROWER than the local one, and that asymmetry is the
// point rather than an omission:
//   · Cancel exists on both, gated by `actionState('downloads:write', …)`.
//   · Pause, Resume and Remove are LOCAL ONLY. `pauseDownload`/`resumeDownload`/
//     `removeDownload` are local routes with no façade verb behind them, so a remote Pause or
//     Resume button could only ever be a silent no-op or a 404 — exactly the "looks wired and
//     is not" failure this feature has already shipped once.
// Every disabled control carries the reason from `actionState`; every refusal that comes
// back from the host renders inline through `describeRemoteFailure`, never as a toast.

import { Fragment, useState } from 'react'
import { CheckCircle2, Download, Pause, RotateCw, Trash2, X } from 'lucide-react'
import { useDownloads, useDownloadMutations } from '../../lib/queries'
import { useLinks, useRemoteDownloads, useRemoteDownloadActions } from '../../lib/link-queries'
import { mergeFleet, fleetMachines, type FleetMachine, type FleetOrigin, type FleetRow } from '../../lib/fleet'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { FleetAction, FleetFailure, MachineNotes, OriginBadge } from '../../components/fleet'
import { track } from '../../lib/api'

/** A Cancel or Discard that would delete more than this much already downloaded asks first: on a
 *  phone a partial is often gigabytes of metered data, and Pause or Resume keeps it instead. */
const CONFIRM_CANCEL_BYTES = 50e6

export function DownloadsPanel() {
  const dlQ = useDownloads()
  const mut = useDownloadMutations()
  const linksQ = useLinks()
  // Host-gated route: a browser off-box 403s, and `?? []` makes that "no links" rather than
  // an error banner on a panel that is mostly about local downloads.
  const links: LinkSummary[] = linksQ.data ?? []
  const remote = useRemoteDownloads(links)
  const remoteActions = useRemoteDownloadActions()

  /** Which row's remote action failed, and what it said.
   *
   *  Keyed by `rowKey`, the SAME function that keys the rendered rows. Keyed by bare
   *  download id (as this first shipped), two machines whose queues each contain an id —
   *  ids are only unique per machine — would show one machine's refusal on the other
   *  machine's row. */
  const [failures, setFailures] = useState<Record<string, RemoteFailure>>({})
  /** A local Resume the daemon refused (another row is writing the same file), by download id. */
  const [resumeErrors, setResumeErrors] = useState<Record<string, string>>({})
  // Each call's own promise, not mutate()'s per-call callbacks: those run for the LAST call only
  // (one observer, whose next mutate() replaces them), so with Resume all firing one per row, a
  // refusal of any row but the last was never shown on it.
  const onResume = (id: string) =>
    mut.resume.mutateAsync(id).then(
      () => setResumeErrors((m) => { const n = { ...m }; delete n[id]; return n }),
      (e: unknown) => setResumeErrors((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) })),
    )
  /** The Cancel (one row's, or Cancel all's rows) waiting on "Delete the downloaded part?". */
  const [pendingCancel, setPendingCancel] = useState<FleetRow<FleetDownload>[] | null>(null)
  /** The paused or errored row whose Discard waits on the same question. */
  const [pendingDiscard, setPendingDiscard] = useState<FleetDownload | null>(null)
  /** Discard: remove the row and its partial file (DELETE deletes the .part of a row not done). */
  const onDiscard = (d: FleetDownload) => {
    if (d.received > CONFIRM_CANCEL_BYTES) setPendingDiscard(d)
    else mut.remove.mutate(d.id)
  }

  const local = dlQ.data?.downloads ?? []
  const sources = sourcesByLink(links, remote.rows, (r) => r.linkId).map((s) => ({
    link: s.link,
    rows: s.rows.map(remoteDownload),
  }))
  const rows = mergeFleet(local.map(localDownload), sources)
  const machines = fleetMachines(sources)

  /** Online machines whose queue could not be READ, shaped as machine notes so they render
   *  through the same component as the offline ones. `fleetMachines` cannot produce these:
   *  its `note` is null for every online machine, by design. */
  const refusedReads: FleetMachine[] = links.flatMap((l) => {
    const err = remote.errorByLink.get(l.id)
    if (!err || l.status !== 'online') return []
    return [{
      linkId: l.id,
      machine: l.name,
      status: l.status,
      note: describeRemoteFailure(err, l.name).message,
      rowCount: 0,
    }]
  })

  // Nothing anywhere: the panel stays out of the way entirely, exactly as before. Note this
  // is keyed on ROWS, not on links — a fleet with three idle machines shows nothing, rather
  // than a "Downloads" heading that exists only to say three machines are idle.
  //
  // `refusedReads` is part of that test, not something computed above it and then thrown
  // away: a machine whose queue could not be READ is not an idle machine, and keyed on rows
  // alone its explanation appeared only when some OTHER download happened to be in flight —
  // i.e. exactly never, on the fleet where it matters most. Offline machines stay out of the
  // test deliberately: they are the "three idle machines" case, and they are represented on
  // the Machines list in Settings.
  if (rows.length === 0 && refusedReads.length === 0) return null

  // Active/queued/paused first, then errored, then completed (terminal) last — applied
  // WITHIN the merged order so local still precedes remote at equal status.
  const rank = (d: FleetDownload) =>
    d.status === 'downloading' || d.status === 'queued' || d.status === 'paused' ? 0
      : d.status === 'error' ? 1 : 2
  const ordered = [...rows].sort((a, b) => rank(a.row) - rank(b.row))
  // A paused row is not active: nothing is moving, and it waits for a Resume.
  const activeCount = rows.filter((r) => r.row.status === 'downloading' || r.row.status === 'queued').length
  const pausedCount = rows.filter((r) => r.row.status === 'paused').length

  const linkFor = (origin: FleetOrigin): LinkSummary | undefined =>
    origin.kind === 'remote' ? links.find((l) => l.id === origin.linkId) : undefined

  /** Busy state for the row that was actually clicked, not for every row on screen.
   *
   *  Keyed off the mutation's own `variables`, the way the local library's `loadingKey`
   *  already does it. A flat `isPending` put a spinner on — and disabled — every other
   *  machine's Cancel button while one cancel was in flight, and a busy-disabled control
   *  has no `actionState` reason behind it, so it was also the one path where a disabled
   *  control carried no explanation. */
  const isCancelling = (r: FleetRow<FleetDownload>): boolean =>
    r.origin.kind === 'local'
      ? mut.cancel.isPending && mut.cancel.variables === r.row.id
      : remoteActions.cancel.isPending &&
        remoteActions.cancel.variables?.linkId === r.origin.linkId &&
        remoteActions.cancel.variables?.downloadId === r.row.id

  /** Cancel `targets`, first asking when they hold more than CONFIRM_CANCEL_BYTES between them. */
  const askCancel = (targets: FleetRow<FleetDownload>[]) => {
    if (targets.reduce((n, r) => n + r.row.received, 0) > CONFIRM_CANCEL_BYTES) setPendingCancel(targets)
    else targets.forEach((r) => onCancel(r))
  }

  const onCancel = (row: FleetRow<FleetDownload>) => {
    const { origin, row: d } = row
    if (origin.kind === 'local') {
      track('models', 'cancel_download')
      mut.cancel.mutate(d.id)
      return
    }
    track('models', 'cancel_remote_download')
    const key = rowKey(origin, d.id)
    remoteActions.cancel.mutate(
      { linkId: origin.linkId, downloadId: d.id },
      {
        onError: (e) =>
          setFailures((f) => ({
            ...f,
            [key]: describeRemoteFailure(e, linkFor(origin)?.name ?? origin.machine),
          })),
        onSuccess: () => setFailures((f) => { const n = { ...f }; delete n[key]; return n }),
      },
    )
  }

  // Bulk actions in the header, next to the row-level ones. A row only counts as
  // cancellable here if its OWN `actionState` says so — a remote row without
  // `downloads:write` is silently skipped rather than firing a request that just
  // becomes another inline failure, the same gate `FleetAction` applies per-row.
  // A paused row is left out: pausing is how a download is kept for later, so "Cancel all"
  // (stop what is downloading) must not delete it with the rest. Its own Cancel still can.
  const cancellableRows = ordered.filter((r) =>
    (r.row.status === 'downloading' || r.row.status === 'queued') &&
    actionState('downloads:write', r.origin, linkFor(r.origin)).enabled)
  // Pause and Resume are local only (see the module note), as their per-row buttons are.
  const pausableRows = ordered.filter((r) => r.origin.kind === 'local' && (r.row.status === 'downloading' || r.row.status === 'queued'))
  const resumableRows = ordered.filter((r) => r.origin.kind === 'local' && (r.row.status === 'paused' || r.row.status === 'error'))
  // Dismiss is local-only housekeeping (see the per-row note below), so "all" means
  // all of THIS machine's finished rows, not the fleet's. Done and cancelled only: an errored
  // row still has its partial file to resume from, and removing a row that is not done deletes
  // it, so "Dismiss all" (meant to clear finished rows) threw away resumable gigabytes in one
  // tap. An errored row is discarded on purpose, with its own Discard.
  const dismissableRows = ordered.filter((r) => r.origin.kind === 'local' && (r.row.status === 'done' || r.row.status === 'cancelled'))

  const onCancelAll = () => {
    track('models', 'cancel_all_downloads')
    askCancel(cancellableRows)
  }
  const onPauseAll = async () => {
    track('models', 'pause_all_downloads')
    // The queued rows first, and the running ones once those pauses have settled: a running row's pause frees its slot,
    // and the daemon then starts the next queued row at once, so paused in list order every queued row was started (its
    // request sent) a moment before its own pause arrived.
    const queued = pausableRows.filter((r) => r.row.status === 'queued')
    const running = pausableRows.filter((r) => r.row.status !== 'queued')
    await Promise.allSettled(queued.map((r) => mut.pause.mutateAsync(r.row.id)))
    running.forEach((r) => mut.pause.mutate(r.row.id))
  }
  const onResumeAll = () => {
    track('models', 'resume_all_downloads')
    resumableRows.forEach((r) => onResume(r.row.id))
  }
  const pendingBytes = pendingCancel?.reduce((n, r) => n + r.row.received, 0) ?? 0
  const onDismissAll = () => {
    track('models', 'dismiss_all_downloads')
    dismissableRows.forEach((r) => mut.remove.mutate(r.row.id))
  }

  return (
    <div className="mb-5 rounded-lg border border-border bg-panel-2 p-4">
      {/* Wraps at phone width: the bulk actions drop below the title instead of squeezing it. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] font-medium text-ink">
        <Download size={14} className="text-muted" />
        Downloads
        {activeCount > 0 && <span className="text-[12px] font-normal text-muted">· {activeCount} active</span>}
        {pausedCount > 0 && <span className="text-[12px] font-normal text-muted">· {pausedCount} paused</span>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {pausableRows.length > 0 && (
            <button
              type="button"
              onClick={onPauseAll}
              className="text-[12px] font-medium text-accent hover:underline"
            >
              Pause all
            </button>
          )}
          {resumableRows.length > 0 && (
            <button
              type="button"
              onClick={onResumeAll}
              className="text-[12px] font-medium text-accent hover:underline"
            >
              Resume all
            </button>
          )}
          {cancellableRows.length > 0 && (
            <button
              type="button"
              onClick={onCancelAll}
              className="text-[12px] font-medium transition-colors hover:underline"
              style={{ color: 'var(--err)' }}
            >
              Cancel all
            </button>
          )}
          {dismissableRows.length > 0 && (
            <button
              type="button"
              onClick={onDismissAll}
              className="text-[12px] font-medium text-accent hover:underline"
            >
              Dismiss all
            </button>
          )}
        </div>
      </div>

      {/* A machine that contributed no rows still gets a line saying why — whether it is
          offline (`fleetMachines`) or online but refusing the read (`errorByLink`). Without
          the second half, a link that is up but lacks `downloads:read` contributes no rows
          and no explanation, which is indistinguishable from an idle machine. */}
      <MachineNotes machines={[...machines, ...refusedReads]} />

      {/* Capped to ~2 rows' height with its own scroll (TODO: "multipart download UX") — a
          multipart model can produce a dozen simultaneous rows, and without a cap this panel
          used to grow unbounded and shove the search list + detail pane off screen. */}
      <div className="flex max-h-[172px] flex-col gap-2 overflow-y-auto pr-1">
        {ordered.map((r) => (
          <DownloadRow
            key={rowKey(r.origin, r.row.id)}
            row={r}
            link={linkFor(r.origin)}
            showOrigin={links.length > 0}
            failure={failures[rowKey(r.origin, r.row.id)]}
            onCancel={() => askCancel([r])}
            onRetryCancel={() => onCancel(r)}
            onRemove={() => mut.remove.mutate(r.row.id)}
            onDiscard={() => onDiscard(r.row)}
            onResume={() => onResume(r.row.id)}
            onPause={() => mut.pause.mutate(r.row.id)}
            resumeError={r.origin.kind === 'local' ? resumeErrors[r.row.id] : undefined}
            cancelling={isCancelling(r)}
            resuming={mut.resume.isPending}
            pausing={mut.pause.isPending && mut.pause.variables === r.row.id}
          />
        ))}
      </div>

      <AlertDialog open={pendingCancel !== null} onOpenChange={(open) => { if (!open) setPendingCancel(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingCancel && pendingCancel.length > 1 ? `Cancel ${pendingCancel.length} downloads?` : 'Cancel this download?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCancel?.length === 1 && <><span className="font-medium text-ink">{pendingCancel[0].row.name}</span>: the </>}
              {pendingCancel?.length !== 1 && 'The '}
              {fmtSize(pendingBytes)} downloaded so far will be deleted.{' '}
              {pendingCancel?.some((r) => r.row.status !== 'paused')
                ? `Pause keeps ${pendingCancel.length > 1 ? 'them' : 'it'}, to resume later.`
                : `Leave ${pendingCancel && pendingCancel.length > 1 ? 'them' : 'it'} paused to resume later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => { pendingCancel?.forEach((r) => onCancel(r)); setPendingCancel(null) }}>
              {pendingCancel && pendingCancel.length > 1 ? 'Delete downloads' : 'Delete download'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingDiscard !== null} onOpenChange={(open) => { if (!open) setPendingDiscard(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this download?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-ink">{pendingDiscard?.name}</span>: the {fmtSize(pendingDiscard?.received ?? 0)}{' '}
              downloaded so far will be deleted. Resume continues from there instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendingDiscard) mut.remove.mutate(pendingDiscard.id); setPendingDiscard(null) }}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function DownloadRow({
  row,
  link,
  showOrigin,
  failure,
  onCancel,
  onRetryCancel,
  onRemove,
  onDiscard,
  onResume,
  onPause,
  resumeError,
  cancelling,
  resuming,
  pausing,
}: {
  row: FleetRow<FleetDownload>
  link: LinkSummary | undefined
  showOrigin: boolean
  failure: RemoteFailure | undefined
  /** Cancel as clicked (it may ask first); `onRetryCancel` repeats a refused one as it was. */
  onCancel: () => void
  onRetryCancel: () => void
  onRemove: () => void
  /** Remove a paused or errored row together with its partial file (it may ask first). */
  onDiscard: () => void
  onResume: () => void
  onPause: () => void
  resumeError: string | undefined
  cancelling: boolean
  resuming: boolean
  pausing: boolean
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
  // Stops the transfer and keeps the .part for Resume — LOCAL only, like Resume.
  const canPause = isLocal && (d.status === 'downloading' || d.status === 'queued')
  // A local paused or errored row's way out says what it does: "Discard" removes the row AND
  // deletes its partial file. It used to be "Cancel" on a paused row and "Dismiss" (the finished
  // rows' word) on an errored one, which deleted the partial just the same.
  const canDiscard = isLocal && (d.status === 'paused' || isError)
  const showCancel = isLocal ? d.status === 'downloading' || d.status === 'queued' : inFlight

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
          {/* Wraps rather than truncates: at phone width a long status (an error message, a
              size in GB with a speed) cut off its end, and the row's buttons below are
              icon-only there for the same reason. */}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted">
            {showOrigin && <OriginBadge origin={origin} />}
            <StatusLine d={d} pct={pct} />
          </div>
        </div>

        {canPause && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { track('models', 'pause_download'); onPause() }}
            disabled={pausing}
            title="Stop for now and keep what is downloaded, to resume later"
            aria-label="Pause"
          >
            <Pause size={13} />
            <ActionLabel>Pause</ActionLabel>
          </Button>
        )}

        {canResume && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { track('models', 'resume_download'); onResume() }}
            disabled={resuming}
            title="Resume from where it left off"
            aria-label="Resume"
          >
            <RotateCw size={13} />
            <ActionLabel>Resume</ActionLabel>
          </Button>
        )}

        {showCancel && (
          <FleetAction state={cancelState} onClick={onCancel} busy={cancelling} variant="outline" label="Cancel">
            <X size={13} />
            <ActionLabel>Cancel</ActionLabel>
          </FleetAction>
        )}

        {/* Dismiss takes over Cancel's slot once the job is terminal — same size, same tap
            target — so clearing a finished multipart download is one tap per row instead of
            hunting for a small X icon. Local only: a remote row's terminal entry belongs to
            the host's own list, so there is nothing here to remove. */}
        {isLocal && (isDone || isCancelled) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { track('models', 'remove_download'); onRemove() }}
            aria-label="Dismiss"
          >
            <X size={13} />
            <ActionLabel>Dismiss</ActionLabel>
          </Button>
        )}

        {canDiscard && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { track('models', 'discard_download'); onDiscard() }}
            title="Delete what is downloaded and remove this download"
            aria-label="Discard"
          >
            <Trash2 size={13} />
            <ActionLabel>Discard</ActionLabel>
          </Button>
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
      {failure && <FleetFailure failure={failure} onRetry={onRetryCancel} />}
      {/* A refused local Resume, e.g. "Another download is already writing this file." */}
      {canResume && resumeError && (
        <div role="alert" className="mt-1.5 text-[11px]" style={{ color: 'var(--err)' }}>{resumeError}</div>
      )}
    </div>
  )
}

/** A row action's visible label: beside its icon from the `sm` width up, hidden below it (the
 *  button keeps its name through aria-label). At phone width two labelled buttons left the
 *  status line about 140 px: a running row read "45% · 109 MB of 240 MB ·", without its speed,
 *  and a paused one "Paused · 71 MB of 2". */
function ActionLabel({ children }: { children: string }) {
  return <span className="hidden sm:inline">{children}</span>
}

/** The detail line under the name: progress + speed while active, the completion
 *  confirmation when done, the error text on failure. Its parts wrap as wholes, so a line
 *  too long for the row breaks between "45%", "· 109 MB of 240 MB" and "· 2.4 MB/s", not
 *  inside one. */
function StatusLine({ d, pct }: { d: FleetDownload; pct: number }) {
  if (d.status === 'done') return <span style={{ color: 'var(--ok)' }}>✓ added to library</span>
  // For a remote row this is `REMOTE_DOWNLOAD_ERROR`, a fixed string — the host's own
  // message never crosses, because for an fs failure it is a full absolute path.
  if (d.status === 'error') {
    return <span className="min-w-0 [overflow-wrap:anywhere]" style={{ color: 'var(--err)' }}>{d.error ?? 'Download failed'}</span>
  }
  if (d.status === 'cancelled') return <>Cancelled</>
  const of = `${fmtSize(d.received)} of ${d.total > 0 ? fmtSize(d.total) : '?'}`
  if (d.status === 'paused') return <StatusParts parts={['Paused', `· ${of}`]} />
  if (d.status === 'queued') return <>Queued…</>
  return <StatusParts parts={[`${pct}%`, `· ${of}`, ...(d.bytesPerSec > 0 ? [`· ${fmtSpeed(d.bytesPerSec)}`] : [])]} />
}

function StatusParts({ parts }: { parts: string[] }) {
  return (
    <span>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="whitespace-nowrap">{p}</span>
        </Fragment>
      ))}
    </span>
  )
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`
}
function fmtSpeed(bps: number): string {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`
}

/** One identity for a merged row, used for BOTH its React key and its failure-map key.
 *  Download ids are unique per machine, not across the fleet, so the machine has to be part
 *  of the identity or two machines' rows collide. */
function rowKey(origin: FleetOrigin, id: string): string {
  return origin.kind === 'remote' ? `${origin.linkId}:${id}` : `local:${id}`
}
