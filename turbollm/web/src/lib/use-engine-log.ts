import { useEffect, useRef, useState } from 'react'
import { engineLogStreamUrl, getEngineLogs } from './api'
import { subscribeSse } from './sse'

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

    // The log so far comes from this GET only: the stream starts a new connection from "now"
    // (routes.ts). Sent at mount, and again when a stream opens while the last one failed: a GET
    // refused 401 before a key was stored (or sent while the daemon was down) left the panel with
    // only the lines written after the stream reopened with the key, and an idle engine's empty
    // for good. A GET that fails after a stream opened while it was out (the key stored meanwhile)
    // is sent again at once, since that stream will not open again to ask. Not again once one has
    // loaded, or while one is out: a stream that reopens resumes after its last line
    // (Last-Event-ID), and a second GET would only race the lines it sends.
    let tail: 'loading' | 'loaded' | 'failed' = 'loading'
    let openedWhileLoading = false
    const loadTail = () => {
      tail = 'loading'
      openedWhileLoading = false
      void getEngineLogs(200)
        .then((res) => {
          tail = 'loaded'
          if (!cancelled) setLines(res.lines ?? [])
        })
        .catch(() => {
          /* daemon may be down — leave panel empty rather than crash; the next stream open asks again */
          tail = 'failed'
          if (openedWhileLoading && !cancelled) loadTail()
        })
    }
    loadTail()

    // Not an EventSource: it can't send the API key, so the tail would 401 over LAN/remote access.
    // subscribeSse reconnects the same way when the stream closes, sending the last line's id as
    // Last-Event-ID: the daemon resumes after it, so the lines written meanwhile are not lost.
    const close = subscribeSse(engineLogStreamUrl, (msg) => {
      if (msg.event !== 'line') return
      try {
        const data = JSON.parse(msg.data) as { line?: string }
        if (typeof data.line === 'string') {
          setLines((prev) => {
            const next = [...prev, data.line as string]
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
          })
        }
      } catch {
        /* ignore malformed frames */
      }
    }, {
      onOpen: () => {
        if (tail === 'failed') loadTail()
        else if (tail === 'loading') openedWhileLoading = true
      },
    })

    return () => {
      cancelled = true
      close()
    }
  }, [active])

  useEffect(() => {
    if (autoScroll && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  return { lines, autoScroll, setAutoScroll, viewportRef }
}
