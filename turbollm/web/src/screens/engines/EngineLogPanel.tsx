import { ChevronRight } from 'lucide-react'
import { track } from '../../lib/api'
import { useEngineLog } from '../../lib/use-engine-log'
import { cn } from '../../lib/utils'
import { CopyButton } from '../../components/ui/copy-button'
import { Switch } from '../../components/ui/switch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible'

/** Collapsible engine log panel: initial tail (GET) + live SSE tail, auto-scroll
 *  toggle and "Copy all" (spec 03 §8/§9). Fetch/SSE/auto-scroll logic lives in
 *  `useEngineLog` — shared with the Monitor screen's always-open log view (issue #211),
 *  so there is exactly one place that fetches and caps the tail. */
export function EngineLogPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { lines, autoScroll, setAutoScroll, viewportRef } = useEngineLog(open)

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-[var(--radius)] border border-border bg-panel"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
          <ChevronRight
            size={14}
            className={cn('transition-transform', open && 'rotate-90')}
          />
          Engine log
        </CollapsibleTrigger>
        {open && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <Switch checked={autoScroll} onCheckedChange={(v) => { track('engines', 'toggle_engine_log_autoscroll'); setAutoScroll(v) }} />
              Auto-scroll
            </label>
            <CopyButton text={lines.join('\n')} label="Copy all" size={14} screen="engines" />
          </div>
        )}
      </div>
      <CollapsibleContent>
        <div
          ref={viewportRef}
          className="max-h-80 overflow-auto rounded-b-[var(--radius)] px-3 py-2 font-mono text-[12px] leading-[1.5]"
          style={{ background: 'var(--log-bg)', color: 'var(--log-ink)' }}
        >
          {lines.length === 0 ? (
            <span style={{ color: 'var(--log-faint)' }}>No log output yet.</span>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {l}
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
