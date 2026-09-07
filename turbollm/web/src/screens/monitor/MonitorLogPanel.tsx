import { track } from '../../lib/api'
import { useEngineLog } from '../../lib/use-engine-log'
import { CopyButton } from '../../components/ui/copy-button'
import { Switch } from '../../components/ui/switch'

/** The Monitor screen's top pane (issue #211): the currently-loaded engine's log, always
 *  expanded (no Collapsible chrome — unlike `EngineLogPanel.tsx` on the Engines screen, this
 *  IS the screen, not a diagnostics drawer tucked under other content) and sized to fill
 *  whatever height the caller gives it rather than a fixed `max-h-80`.
 *
 *  Shares the fetch/SSE/auto-scroll/cap logic with `EngineLogPanel` via `useEngineLog` —
 *  only the chrome around it differs. */
export function MonitorLogPanel({ hasEngine, isLoading }: { hasEngine: boolean; isLoading?: boolean }) {
  // Subscribe whenever an engine exists (starting/running/stopping all produce log output —
  // not just 'running'), same gate EnginesScreen uses to decide whether to mount the panel
  // at all. No engine at all → nothing to tail, so the hook stays inactive.
  const { lines, autoScroll, setAutoScroll, viewportRef } = useEngineLog(hasEngine)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-faint">Engine log</h2>
        {hasEngine && (
          <div className="flex items-center gap-3">
            <label htmlFor="monitor-log-autoscroll" className="flex items-center gap-1.5 text-[12px] text-muted">
              <Switch id="monitor-log-autoscroll" checked={autoScroll} onCheckedChange={(v) => { track('monitor', 'toggle_engine_log_autoscroll'); setAutoScroll(v) }} />
              Auto-scroll
            </label>
            <CopyButton text={lines.join('\n')} label="Copy all" size={14} screen="monitor" />
          </div>
        )}
      </div>
      <div
        ref={viewportRef}
        tabIndex={0}
        aria-label="Engine log output"
        className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.5]"
        style={{ background: 'var(--log-bg)', color: 'var(--log-ink)' }}
      >
        {isLoading ? (
          <span style={{ color: 'var(--log-faint)' }}>Loading…</span>
        ) : !hasEngine ? (
          <span style={{ color: 'var(--log-faint)' }}>
            No engine selected — pick one on Engines to see its log here.
          </span>
        ) : lines.length === 0 ? (
          <span style={{ color: 'var(--log-faint)' }}>No log output yet.</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
