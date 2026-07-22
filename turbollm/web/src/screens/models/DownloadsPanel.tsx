// Downloads panel (spec 10 §5). Polls the downloads list (~1.5s while any job is
// active, via useDownloads) and renders one row per job: name, progress bar,
// percent, speed, and a Cancel action. Completed rows show a "✓ added to library"
// confirmation and can be removed. Renders nothing-but-empty-state when idle.

import { CheckCircle2, Download, RotateCw, X } from 'lucide-react'
import { useDownloads, useDownloadMutations } from '../../lib/queries'
import type { DownloadRecord } from '../../lib/types'
import { Button } from '../../components/ui/button'

export function DownloadsPanel() {
  const dlQ = useDownloads()
  const mut = useDownloadMutations()
  const downloads = dlQ.data?.downloads ?? []

  if (downloads.length === 0) return null

  // Active/queued/paused first, then errored, then completed (terminal) last.
  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'paused')
  const errored = downloads.filter((d) => d.status === 'error')
  const done = downloads.filter((d) => d.status === 'done' || d.status === 'cancelled')
  const ordered = [...active, ...errored, ...done]

  return (
    <div className="mb-5 rounded-lg border border-border bg-panel-2 p-4">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink">
        <Download size={14} className="text-muted" />
        Downloads
        {active.length > 0 && <span className="text-[12px] font-normal text-muted">· {active.length} active</span>}
      </div>
      <div className="flex flex-col gap-2">
        {ordered.map((d) => (
          <DownloadRow
            key={d.id}
            d={d}
            onCancel={() => mut.cancel.mutate(d.id)}
            onRemove={() => mut.remove.mutate(d.id)}
            onResume={() => mut.resume.mutate(d.id)}
            cancelling={mut.cancel.isPending}
            resuming={mut.resume.isPending}
          />
        ))}
      </div>
    </div>
  )
}

function DownloadRow({
  d,
  onCancel,
  onRemove,
  onResume,
  cancelling,
  resuming,
}: {
  d: DownloadRecord
  onCancel: () => void
  onRemove: () => void
  onResume: () => void
  cancelling: boolean
  resuming: boolean
}) {
  const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0
  const inFlight = d.status === 'downloading' || d.status === 'queued' || d.status === 'paused'
  const isDone = d.status === 'done'
  const isError = d.status === 'error'
  const isCancelled = d.status === 'cancelled'
  // paused (a restart-restored job) or errored (a network hiccup) both have a .part
  // file on disk and can continue from that byte offset via Range — see resume().
  const canResume = d.status === 'paused' || isError

  const barColor = isError ? 'var(--err)' : isDone ? 'var(--ok)' : 'var(--accent)'

  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isDone && <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} className="shrink-0" />}
            <span className="truncate text-[13px] font-medium text-ink">{d.name}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted">
            <StatusLine d={d} pct={pct} />
          </div>
        </div>
        {canResume && (
          <Button
            size="sm"
            variant="outline"
            onClick={onResume}
            disabled={resuming}
            title="Resume from where it left off"
          >
            <RotateCw size={13} />
            Resume
          </Button>
        )}
        {inFlight && (
          <Button
            size="sm"
            variant="outline"
            onClick={onCancel}
            disabled={cancelling}
            title="Cancel download"
          >
            <X size={13} />
            Cancel
          </Button>
        )}
        {(isDone || isError || isCancelled) && (
          <button
            type="button"
            aria-label="Remove from list"
            onClick={onRemove}
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
    </div>
  )
}

/** The detail line under the name: progress + speed while active, the completion
 *  confirmation when done, the error text on failure. */
function StatusLine({ d, pct }: { d: DownloadRecord; pct: number }) {
  if (d.status === 'done') return <span style={{ color: 'var(--ok)' }}>✓ added to library</span>
  if (d.status === 'error') return <span style={{ color: 'var(--err)' }}>{d.error ?? 'Download failed'}</span>
  if (d.status === 'cancelled') return <>Cancelled</>
  if (d.status === 'paused') return <>Paused · {fmtSize(d.received)} of {d.total > 0 ? fmtSize(d.total) : '?'}</>
  if (d.status === 'queued') return <>Queued…</>
  // downloading
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
