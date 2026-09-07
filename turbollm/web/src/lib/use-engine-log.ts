import { useEffect, useRef, useState } from 'react'
import { engineLogStreamUrl, getEngineLogs } from './api'

const MAX_LINES = 2000

/** Shared live-log-tail logic: initial tail (GET) + live SSE tail, capped ring buffer, plus
 *  an auto-scroll effect wired to a caller-owned viewport ref.
 *
 *  Extracted out of `EngineLogPanel.tsx` (issue #211) so the Monitor screen's always-open log
 *  view and Engines' collapsible panel share one fetch/SSE/cap implementation instead of two
 *  copies that can drift.
 *
 *  `active` gates the fetch+SSE subscription — no daemon connection is held while the caller
 *  doesn't need one (EngineLogPanel passes its own `open`; Monitor passes `true` while mounted). */
export function useEngineLog(active: boolean) {
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
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
  }, [active])

  useEffect(() => {
    if (autoScroll && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  return { lines, autoScroll, setAutoScroll, viewportRef }
}
