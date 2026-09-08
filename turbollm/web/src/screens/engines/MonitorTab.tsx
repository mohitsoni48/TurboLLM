import { useState } from 'react'
import { ApiError, track } from '../../lib/api'
import { activeEngineOf, useEngines, useStatus } from '../../lib/queries'
import { InlineError } from '../../components/common'
import { StateChip } from '../../components/StateChip'
import { cn } from '../../lib/utils'
import { MonitorLogPanel } from './MonitorLogPanel'
import { RequestsPanel } from './RequestsPanel'
import { HardwareSection } from '../settings/HardwareSection'

// ── Monitor tab (issue #211, relocated here by that issue's own follow-up) ──────────────────
//
// "Checking the log of the currently running engine and the stats of the system is something
// I tend to do very often … especially when working with multiple engines and models." Both
// already existed — the engine log under Engines' collapsed diagnostics drawer, hardware under
// Settings → System — just not as a first-class, always-visible destination. Shipped as its own
// top-level `/monitor` nav tab in v1.12.5 (ADR-409); the founder's verdict after using it: right
// idea, wrong place (it belongs inside Engines, the screen it's actually about) — and the log
// itself needed to show real request/response detail, not just raw engine stderr. Both fixed
// here: this is now a TAB of EnginesScreen, and its log pane gained a second view.
//
// A bounded (not document-scroll) split screen, same shell mode as Chat/Workspace: the top
// pane needs to auto-track its own end while the stats panel scrolls independently beneath it,
// so neither steals the other's scroll position. Each pane gets its own `min-h-0 overflow-auto`
// half — EnginesScreen leaves scroll-mode resolution to whichever tab is mounted (this one
// simply never calls `useDocumentScroll`, same as it never did as a standalone route).
//
// Top pane is a segmented control between two DIFFERENT captures, not two views of the same
// data: "Engine log" is `MonitorLogPanel` (the engine's own stderr — timing/slot lines only,
// llama.cpp never emits a prompt or a sampling param); "Requests" is `RequestsPanel`, backed by
// TurboLLM's own proxy-layer capture (gateway.ts / chat-upstream.ts) — LM Studio-style request/
// response/params detail the engine log can never contain. Bottom pane reuses `HardwareSection`
// unmodified — same live gauges + sparklines it renders in Settings → System.
export function MonitorTab() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()
  const [view, setView] = useState<'log' | 'requests'>('log')

  const activeEngine = activeEngineOf(enginesQ.data)
  const engineState = status?.engine.state ?? 'stopped'

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4 md:px-6">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {(['log', 'requests'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => { track('monitor', 'switch_monitor_view'); setView(v) }}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                view === v ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink',
              )}
            >
              {v === 'log' ? 'Engine log' : 'Requests'}
            </button>
          ))}
        </div>
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
          ) : view === 'log' ? (
            <MonitorLogPanel hasEngine={!!activeEngine} isLoading={enginesQ.isLoading} />
          ) : (
            <RequestsPanel active={view === 'requests'} />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          <HardwareSection />
        </div>
      </div>
    </div>
  )
}
