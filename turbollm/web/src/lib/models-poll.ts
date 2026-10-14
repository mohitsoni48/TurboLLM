// How often the models list refetches (`useModels`). The list is what tells a row its model is loaded, so any load
// in progress must keep it polling — a primary load, and a Laya model's, which loads in its own slot while the
// primary stays stopped (ADR-443). `false` stops polling.
import type { DownloadsList, ModelEntry, ModelsList, Status } from './types'

/** scanner.ts's SPLIT_RE: `<prefix>-00002-of-00005.gguf`. */
const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

function cut(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
}

/** Whether a finished download's file is accounted for by a scanned library row. Matched by
 *  LOCATION, never by name (`m.name` is the GGUF's display name, not a filename), and covering the
 *  files that never become a row of their own — otherwise one such download keeps this query
 *  polling every 1.5 s for the daemon's lifetime (`done` records are kept until removed):
 *   - a directory model's (MLX/vLLM/Jev/Laya) component files, which live under its `path`;
 *   - an `mmproj` projector, which the scanner attaches to the model(s) in its folder;
 *   - split shards 2..N, whose row is the split's first shard in the same folder.
 *  A brand-new single file in a folder that already holds another model still waits for its own
 *  row, so the "keep polling until it appears" guarantee below is unchanged. */
function downloadInLibrary(dest: string, models: ModelEntry[]): boolean {
  const dir = dest.slice(0, cut(dest))
  const base = dest.slice(cut(dest) + 1)
  const split = base.match(SPLIT_RE)
  return models.some((m) => {
    if (m.path === dest || dest.startsWith(`${m.path}/`) || dest.startsWith(`${m.path}\\`)) return true
    if (m.dir !== dir) return false
    if (base.toLowerCase().includes('mmproj')) return true
    const first = split ? m.path.slice(cut(m.path) + 1).match(SPLIT_RE) : null
    return !!split && !!first && first[1] === split[1] && first[3] === split[3]
  })
}

export function modelsRefetchInterval(
  data: ModelsList | undefined,
  status: Status | undefined,
  downloads: DownloadsList | undefined,
): number | false {
  if (data?.scanning) return 1200
  if (data?.models.some((m) => m.loaded)) return 4000
  if (status?.engine.state === 'starting' || status?.laya?.state === 'starting') return 1000
  // A finished download whose file the scanner hasn't caught up to yet — keep polling until it appears, or this
  // query goes permanently quiet the moment it happens to be asked before a download even starts (empty model dir,
  // nothing scanning, nothing loaded) and never wakes back up. Found live: a real onboarding run against real
  // HuggingFace got stuck on "Loading your model" forever — the download genuinely finished and the file scanned
  // fine server-side minutes later, but this query's first poll (fired right after clicking "Download this,"
  // before the download even began) had already disabled itself, so LoadStep's `matchedEntry` never resolved and
  // `loadModel()` never fired. `useDownloads()`'s own poll noticing the download finish doesn't invalidate this
  // query — nothing else did either.
  const models = data?.models ?? []
  const hasUnmatchedFinishedDownload = downloads?.downloads.some(
    (d) => d.status === 'done' && !downloadInLibrary(d.dest, models),
  )
  return hasUnmatchedFinishedDownload ? 1500 : false
}
