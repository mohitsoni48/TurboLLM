import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { engineLogStreamUrl, getEngineLogs, track } from '../../lib/api'
import { cn } from '../../lib/utils'
import { CopyButton } from '../../components/ui/copy-button'
import { Switch } from '../../components/ui/switch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible'

const MAX_LINES = 2000

/** Collapsible engine log panel: initial tail (GET) + live SSE tail, auto-scroll
 *  toggle and "Copy all" (spec 03 §8/§9). */
export function EngineLogPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  // Initial tail fetch + SSE live tail, active only while the panel is open.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    void getEngineLogs(200)
      .then((res) => {
        if (!cancelled) setLines(res.lines ?? [])
      })
      .catch(() => {
        /* daemon may be down — leave panel empty rather than crash */
      })

    const es = new EventSource(engineLogStreamUrl)
    es.addEventListener('line', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { line?: string }
        if (typeof data.line === 'string') {
          setLines((prev) => {
            const next = [...prev, data.line as string]
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
          })
        }
      } catch {
        /* ignore malformed frames */
      }
    })
    es.onerror = () => {
      /* stream closes when the engine stops; reconnection handled by browser */
    }

    return () => {
      cancelled = true
      es.close()
    }
  }, [open])

  useEffect(() => {
    if (autoScroll && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [lines, autoScroll])


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
