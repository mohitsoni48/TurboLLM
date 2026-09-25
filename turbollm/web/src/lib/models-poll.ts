// How often the models list refetches (`useModels`). The list is what tells a row its model is loaded, so any load
// in progress must keep it polling — a primary load, and a Laya model's, which loads in its own slot while the
// primary stays stopped (ADR-443). `false` stops polling.
import type { DownloadsList, ModelsList, Status } from './types'

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
    (d) => d.status === 'done' && !models.some((m) => d.dest.endsWith(m.name) || m.path === d.dest),
  )
  return hasUnmatchedFinishedDownload ? 1500 : false
}
