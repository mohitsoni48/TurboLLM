import { ApiError } from '../lib/api'
import { activeEngineOf, useEngines, useStatus } from '../lib/queries'
import { InlineError } from '../components/common'
import { StateChip } from '../components/StateChip'
import { MonitorLogPanel } from './monitor/MonitorLogPanel'
import { HardwareSection } from './settings/HardwareSection'

// ── Monitor (issue #211) ────────────────────────────────────────────────────
//
// "Checking the log of the currently running engine and the stats of the system is something
// I tend to do very often … especially when working with multiple engines and models." Both
// already existed — the engine log under Engines' collapsed diagnostics drawer, hardware under
// Settings → System — just not as a first-class, always-visible destination.
//
// A bounded (not document-scroll) split screen, same shell mode as Chat/Workspace: the log
// needs to auto-track its own end while the stats panel scrolls independently beneath it, so
// neither steals the other's scroll position — the exact complaint a single long page would
// reintroduce. Each pane gets its own `min-h-0 overflow-auto` half.
//
// The log pane is `MonitorLogPanel` (always-expanded sibling of Engines' collapsible
// `EngineLogPanel`, sharing its fetch/SSE logic via `useEngineLog`). The stats pane reuses
// `HardwareSection` unmodified — same live gauges + sparklines it renders in Settings → System,
// so this page and that one can never disagree about what "system stats" means.
export function MonitorScreen() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()

  const activeEngine = activeEngineOf(enginesQ.data)
  const engineState = status?.engine.state ?? 'stopped'

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4 md:px-6">
        <h1 className="text-[14px] font-semibold text-ink">Monitor</h1>
        {activeEngine && (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <span className="truncate">{activeEngine.name}</span>
            <StateChip state={engineState} />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 border-b border-border">
          {enginesQ.isError ? (
            <div className="p-4">
              <InlineError
                message={enginesQ.error instanceof ApiError ? enginesQ.error.message : 'Could not load engines.'}
                onRetry={() => void enginesQ.refetch()}
                screen="monitor"
              />
            </div>
          ) : (
            <MonitorLogPanel hasEngine={!!activeEngine} isLoading={enginesQ.isLoading} />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          <HardwareSection />
        </div>
      </div>
    </div>
  )
}
