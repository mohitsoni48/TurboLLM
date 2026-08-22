// Turbo Link (ADR-376 phase 3, task 6): one model that lives on ANOTHER machine, in the
// merged Models library.
//
// Deliberately a separate component from the local `ModelRow` rather than a mode of it. A
// local row carries a pile of affordances that exist only because the file is on this
// machine's disk and this machine's engine will open it — delete, load-settings/auto-tune,
// pin, "find other quants", split-part warnings, engine-compatibility badges. None of them
// has a façade verb behind it, so on a remote row every one would be a silent no-op or a
// 404. Sharing one component and hiding two-thirds of it behind `origin.kind === 'local'`
// would put that whole matrix in one place and make "which affordances are real here?"
// a question nobody can answer by reading it.
//
// What a remote row HAS: the model, its quant/context, and Load/Unload — the two verbs the
// protocol actually grants (`models:load` / `models:unload`), each gated by `actionState`.
import { CircleSlash, Zap } from 'lucide-react'
import type { CSSProperties } from 'react'
import { actionState } from '../../lib/capability-ui'
import type { FleetOrigin } from '../../lib/fleet'
import type { FleetModel } from '../../lib/fleet-sources'
import type { LinkSummary } from '../../lib/link-api'
import { describeRemoteFailure } from '../../lib/remote-failure'
import { FleetAction, FleetFailure, OriginBadge } from '../../components/fleet'

export function RemoteModelRow({
  model,
  origin,
  link,
  layout,
  rowGrid,
  onLoad,
  onUnload,
  busy,
  failure,
}: {
  model: FleetModel
  origin: FleetOrigin
  /** The live link record. `undefined` when the machine was unlinked while the list was on
   *  screen — `actionState` turns that into a disabled control with its own reason rather
   *  than falling through to enabled. */
  link: LinkSummary | undefined
  layout: 'row' | 'card'
  rowGrid?: CSSProperties
  onLoad: () => void
  onUnload: () => void
  busy: boolean
  failure?: unknown
}) {
  const loadState = actionState('models:load', origin, link)
  const unloadState = actionState('models:unload', origin, link)
  const machine = link?.name ?? (origin.kind === 'remote' ? origin.machine : '')
  const described = failure ? describeRemoteFailure(failure, machine) : undefined

  const nameBlock = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {model.loaded && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--ok)' }} />
        )}
        <span className="truncate text-[14px] font-medium text-ink">{model.name}</span>
        {model.vision && (
          <span className="shrink-0 whitespace-nowrap rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            Vision
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 truncate text-[12px] text-muted">
        <OriginBadge origin={origin} />
        {model.loaded && <span>· running</span>}
      </div>
    </div>
  )

  const actions = model.loaded ? (
    <FleetAction state={unloadState} onClick={onUnload} busy={busy}>
      <CircleSlash size={14} />
      Unload
    </FleetAction>
  ) : (
    <FleetAction state={loadState} onClick={onLoad} busy={busy}>
      <Zap size={14} />
      Load
    </FleetAction>
  )

  // `sizeBytes` is always null for a remote model and there is deliberately no fallback:
  // an em-dash says "not known", where `0 MB` would say something false.
  const sizeCell = <span className="text-[13px] text-muted">—</span>
  const quantCell = <span className="font-mono text-[13px] text-muted">{model.quant ?? '—'}</span>
  const ctxCell = (
    <span className="text-[13px] tabular-nums text-muted">
      {model.nativeCtx ? fmtCtx(model.nativeCtx) : '—'}
    </span>
  )

  if (layout === 'card') {
    return (
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
        {nameBlock}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
          {quantCell}
          {sizeCell}
          {ctxCell}
        </div>
        <div className="flex items-center gap-1.5">{actions}</div>
        {described && <FleetFailure failure={described} onRetry={model.loaded ? onUnload : onLoad} />}
      </div>
    )
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="grid items-center gap-3 px-4 py-2.5" style={rowGrid}>
        {nameBlock}
        <div className="flex justify-end">{quantCell}</div>
        <div className="text-right">{sizeCell}</div>
        <div className="text-right">{ctxCell}</div>
        {/* Speed: this machine has never benchmarked a model it does not have. */}
        <div className="text-right text-[13px] text-muted">—</div>
        <div className="flex items-center justify-end gap-1.5">{actions}</div>
      </div>
      {described && (
        <div className="px-4 pb-2.5">
          <FleetFailure failure={described} onRetry={model.loaded ? onUnload : onLoad} />
        </div>
      )}
    </div>
  )
}

function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}
