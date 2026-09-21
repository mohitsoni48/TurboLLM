// One selectable row per downloadable checkpoint folder of a safetensors repo (ADR-434 (h)).
//
// A repo like AlexWortega/openjev holds several complete models side by side, so "download the
// repo" is the wrong unit — the user picks a folder. An architecture TurboLLM has no verified
// launch row for is tagged, never hidden: ADR-434 (h) leaves that judgement to the user.
//
// `fileFit`, `FitDot` and `fmtSize` come from HfRepoDialog, which also renders this picker. The
// resulting cycle is function-only and resolves at call time, exactly like the sibling bodies
// that file already exports.
import { Download, Zap } from 'lucide-react'
import { track } from '../../lib/api'
import type { HfCheckpoint } from '../../lib/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { FitDot, fileFit, fmtSize } from './HfRepoDialog'

export function CheckpointPicker({
  repo,
  checkpoints,
  vramMb,
  blockedByGate,
  enqueuePending,
  onDownload,
  onLoad,
}: {
  repo: string
  checkpoints: HfCheckpoint[]
  vramMb: number | undefined
  blockedByGate: boolean
  enqueuePending: boolean
  onDownload: (cp: HfCheckpoint) => void
  onLoad: (cp: HfCheckpoint) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {checkpoints.map((cp) => (
        <CheckpointRow
          key={`${repo}/${cp.dir}`}
          checkpoint={cp}
          shadowedBy={shadowingCheckpoint(cp, checkpoints)}
          vramMb={vramMb}
          blockedByGate={blockedByGate}
          enqueuePending={enqueuePending}
          onDownload={onDownload}
          onLoad={onLoad}
        />
      ))}
    </div>
  )
}

function CheckpointRow({
  checkpoint,
  shadowedBy,
  vramMb,
  blockedByGate,
  enqueuePending,
  onDownload,
  onLoad,
}: {
  checkpoint: HfCheckpoint
  shadowedBy: HfCheckpoint | null
  vramMb: number | undefined
  blockedByGate: boolean
  enqueuePending: boolean
  onDownload: (cp: HfCheckpoint) => void
  onLoad: (cp: HfCheckpoint) => void
}) {
  const localKey = checkpoint.downloaded ? checkpoint.localKey : null
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-panel-2 px-3 py-2.5">
      <FitDot fit={fileFit(checkpoint.sizeBytes, vramMb)} size={10} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{checkpoint.name}</span>
          <CheckpointTags checkpoint={checkpoint} />
        </div>
        <div className="mt-0.5 text-[12px] text-muted">{fmtSize(checkpoint.sizeBytes)}</div>
        {shadowedBy && <ShadowedNote ancestorName={shadowedBy.name} />}
      </div>
      {localKey ? (
        <Button size="sm" onClick={() => { track('models', 'load_hf_checkpoint'); onLoad(checkpoint) }}>
          <Zap size={14} />
          Load
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => { track('models', 'download_hf_checkpoint'); onDownload(checkpoint) }}
          disabled={enqueuePending || blockedByGate}
        >
          <Download size={14} />
          Download
        </Button>
      )}
    </div>
  )
}

/** The checkpoint this one would disappear behind once both are on disk, or null.
 *  The scanner skips a model folder nested inside another model's folder, and the repo root
 *  is an ancestor of every nested folder in it. */
export function shadowingCheckpoint(cp: HfCheckpoint, all: HfCheckpoint[]): HfCheckpoint | null {
  return all.find((other) => containsDir(other.dir, cp.dir)) ?? null
}

function containsDir(ancestor: string, dir: string): boolean {
  if (dir === '') return false
  if (ancestor === '') return true
  return dir.startsWith(`${ancestor}/`)
}

function ShadowedNote({ ancestorName }: { ancestorName: string }) {
  return (
    <div className="mt-1 text-[12px]" style={{ color: 'var(--warn)' }}>
      {`Won't show in your library if "${ancestorName}" is also downloaded — TurboLLM doesn't list a model folder inside another model's folder.`}
    </div>
  )
}

function CheckpointTags({ checkpoint }: { checkpoint: HfCheckpoint }) {
  return (
    <>
      {checkpoint.jev && <Badge variant="accent">Jev model</Badge>}
      {checkpoint.jev && !checkpoint.jev.verified && <Badge>Not verified</Badge>}
      {checkpoint.downloaded && <Badge>Downloaded</Badge>}
    </>
  )
}
