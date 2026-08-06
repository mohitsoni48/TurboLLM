import { CircleSlash, RotateCw } from 'lucide-react'
import type { EngineStats, LiveGeneration, Status } from '../../lib/types'
import { useEngineMutations, useModelActions } from '../../lib/queries'
import { ApiError, track } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { StateChip } from '../../components/StateChip'
import { CopyButton } from '../../components/ui/copy-button'
import { toast } from '../../components/ui/sonner'

/** Active engine status card: name + state chip + loading elapsed + error log,
 *  plus Stop and Restart controls (spec 03 §9).
 *  (No manual Start — the engine starts automatically when a model is loaded.) */
export function EngineStatusHeader({
  status,
  activeEngineName,
  embedded = false,
}: {
  status: Status | undefined
  activeEngineName: string | null
  /** Rendered inside the header panel (no own card/border, engine name omitted —
   *  it's already shown by the "Running now" selector above). */
  embedded?: boolean
}) {
  const state = status?.engine.state ?? 'stopped'
  const error = status?.engine.error
  const elapsedMs = status?.model?.loadElapsedMs
  const stats = state === 'running' ? status?.engineStats ?? null : null
  const live = state === 'running' ? status?.liveGeneration ?? null : null
  const actions = useModelActions()
  const mut = useEngineMutations()
  const canStop = state === 'running' || state === 'starting'
  const canRestart = state === 'running' || state === 'error'

  const onStop = () => {
    track('engines', 'eject_model')
    actions.eject.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not stop the engine.'),
    })
  }

  const onRestart = () => {
    track('engines', 'restart_engine')
    mut.restart.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not restart the engine.'),
    })
  }


  const body = (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {!embedded && (
          <div>
            <div className="text-[12px] text-muted">Active engine</div>
            <div className="text-sm font-semibold text-ink">
              {activeEngineName ?? 'None active'}
            </div>
          </div>
        )}
        <StateChip state={state} />
        {state === 'starting' && elapsedMs != null && (
          <span className="text-[13px] text-muted">
            Loading model… ({Math.round(elapsedMs / 1000)}s)
          </span>
        )}
        {state === 'running' && status?.model && (
          <span className="text-[13px] text-muted truncate">{status.model.name}</span>
        )}
        {/* Compact activity pill for engine traffic without a detailed live row
            (e.g. Claude-CLI / gateway requests). In-app chat shows the richer
            prefill %/token row below instead, so this stays out of its way. */}
        {state === 'running' && !live && (stats?.activeRequests ?? 0) > 0 && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium"
            style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
            title="The engine is actively generating"
          >
            <span className="tllm-pulse inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            Generating{(stats?.activeRequests ?? 0) > 1 ? ` (${stats?.activeRequests})` : ''}…
          </span>
        )}
        {canRestart && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={onRestart}
            disabled={mut.restart.isPending}
            title="Restart the engine"
          >
            <RotateCw size={14} />
            Restart
          </Button>
        )}
        {canStop && (
          <Button
            size="sm"
            variant="outline"
            className={canRestart ? '' : 'ml-auto'}
            onClick={onStop}
            disabled={actions.eject.isPending}
            title="Stop the engine and unload the model"
          >
            <CircleSlash size={14} />
            Stop & unload
          </Button>
        )}
      </div>

      {(live || stats) && <LiveStatsBlock live={live} stats={stats} />}

      {state === 'error' && error && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-medium" style={{ color: 'var(--err)' }}>
              {error.message}
              {error.exitCode != null && ` (exit ${error.exitCode})`}
            </span>
            <CopyButton text={(error?.logTail ?? []).join('\n')} label="Copy" size={14} />
          </div>
          <pre
            className="max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-[1.5]"
            style={{ background: 'var(--log-bg)', color: 'var(--log-err-ink)' }}
          >
            {(error.logTail ?? []).join('\n') || 'No log output captured.'}
          </pre>
        </div>
      )}
    </>
  )

  if (embedded) return body
  return (
    <div className="rounded-[var(--radius)] border border-[color:var(--accent)] bg-panel p-4">
      {body}
    </div>
  )
}

// ── Live + session stats block (F-013) ────────────────────────────────────────

/** Combined live-progress + session-stats block. While a request is in flight
 *  the active live value (prefill bar during `prompt`, pulsing token count
 *  during `gen`) renders at a visible tier directly above the session totals —
 *  the two pieces of information are co-located so the user sees live progress
 *  and context in one glance. Without a live request only the stats row shows.
 *
 *  Visibility tiers (raised in F-013):
 *    live value  → text-[13px] text-ink  (accent color on the active number)
 *    stats totals → text-[12px] text-muted  (one step above the old faint tier) */
function LiveStatsBlock({
  live,
  stats,
}: {
  live: LiveGeneration | null
  stats: EngineStats | null
}) {
  return (
    <div className="mt-3 border-t border-border pt-2">
      {/* Live row — only shown while a request is in flight */}
      {live && (
        live.phase === 'prompt' ? (
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink">
            <span className="shrink-0">Processing prompt</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(0, Math.min(100, live.pct))}%`, background: 'var(--accent)' }}
              />
            </div>
            <span className="shrink-0 tabular-nums font-medium" style={{ color: 'var(--accent)' }}>
              {live.pct}%
            </span>
          </div>
        ) : (
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink">
            <span className="tllm-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
            <span className="tabular-nums font-medium" style={{ color: 'var(--accent)' }}>
              {live.outputTokens.toLocaleString()} tok
            </span>
            <span className="text-muted">generated</span>
          </div>
        )
      )}

      {/* Session totals — always shown when stats exist */}
      {stats && <SessionStatsLine stats={stats} />}
    </div>
  )
}

/** One-liner session summary at the secondary (muted) tier. */
function SessionStatsLine({ stats }: { stats: EngineStats }) {
  const parts: string[] = []
  parts.push(`${stats.requests} ${stats.requests === 1 ? 'request' : 'requests'}`)
  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    parts.push(`${fmtTok(stats.inputTokens)} in / ${fmtTok(stats.outputTokens)} out`)
  }
  if (stats.avgPromptTps > 0) parts.push(`${stats.avgPromptTps.toFixed(0)} tok/s prefill`)
  if (stats.avgGenTps > 0) parts.push(`${stats.avgGenTps.toFixed(1)} tok/s gen`)
  parts.push(fmtDuration(stats.sinceMs))

  return (
    <div className="text-[12px] text-muted" title="Session totals — reset when the engine stops or restarts">
      {parts.join(' · ')}
    </div>
  )
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s session`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m session`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m session`
}
