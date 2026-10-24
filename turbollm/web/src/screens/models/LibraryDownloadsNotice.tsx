// The Library's one line about this machine's downloads. Models opens on the Library, and download
// progress shows only in Discover's Downloads panel, so after reopening the app a download left
// paused by a restart (or by Pause), or one that failed, sat out of sight: nothing on the screen
// the app opens on said that gigabytes were waiting for a Resume. Shown only while a download is
// running, queued, paused or errored; "Show" opens Discover, whose Downloads panel is at its top.
// This machine's downloads only, as useDownloads lists them (a linked machine's show in the panel).

import { useDownloads } from '../../lib/queries'
import { track } from '../../lib/api'

export function LibraryDownloadsNotice({ onShow }: { onShow: () => void }) {
  const downloads = useDownloads().data?.downloads ?? []
  const running = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued').length
  const paused = downloads.filter((d) => d.status === 'paused').length
  const failed = downloads.filter((d) => d.status === 'error').length
  const parts = (
    [
      [running, 'running'],
      [paused, 'paused'],
      [failed, 'failed'],
    ] as const
  ).filter(([n]) => n > 0)
  if (parts.length === 0) return null
  // "2 downloads running · 1 paused": the first count names what it counts.
  const text = parts
    .map(([n, what], i) => (i === 0 ? `${n} ${n === 1 ? 'download' : 'downloads'} ${what}` : `${n} ${what}`))
    .join(' · ')

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-panel px-4 py-2.5 text-[12px]">
      <span className="text-muted">{text}</span>
      <button
        type="button"
        onClick={() => { track('models', 'show_downloads_from_library'); onShow() }}
        aria-label="Show downloads"
        className="shrink-0 font-medium text-accent hover:underline"
      >
        Show
      </button>
    </div>
  )
}
