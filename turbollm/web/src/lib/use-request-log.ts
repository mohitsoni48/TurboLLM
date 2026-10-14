import { useEffect, useRef, useState } from 'react'
import { getRequests, requestsStreamUrl } from './api'
import { subscribeSse } from './sse'
import type { RequestLogEntry } from './types'

const MAX_ENTRIES = 500

/** Shared live request-log logic (issue #211 follow-up): initial history (GET) + live SSE tail,
 *  capped ring buffer, plus an auto-scroll effect wired to a caller-owned viewport ref — the
 *  same shape as `use-engine-log.ts`'s `useEngineLog`, which this is deliberately modeled on so
 *  the two panels (Engine log / Requests) inside Monitor behave identically.
 *
 *  One difference from `useEngineLog`: an SSE frame here can name an id ALREADY in the buffer
 *  (a request's `start()` event, then its `finalize()` event moments later) — those are
 *  UPSERTED by id, not appended, so a request shows once and its row updates in place from
 *  "pending" to a real status.
 *
 *  Filtering (source/model/status) is deliberately NOT built in here — the stream always
 *  carries everything up to the cap; `RequestsPanel` filters the returned `entries` client-side.
 *  That keeps this hook simple and means flipping a filter chip never needs a re-subscribe.
 *
 *  `active` gates the fetch+SSE subscription — no daemon connection is held while the caller
 *  doesn't need one (RequestsPanel passes `true` only while its view is the visible one). */
export function useRequestLog(active: boolean) {
  const [entries, setEntries] = useState<RequestLogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    void getRequests({ limit: MAX_ENTRIES })
      .then((res) => {
        if (!cancelled) setEntries(res.entries)
      })
      .catch(() => {
        /* daemon may be down — leave panel empty rather than crash */
      })

    // Not an EventSource: it can't send the API key, so the tail would 401 over LAN/remote access.
    // subscribeSse reconnects the same way when the stream drops.
    const close = subscribeSse(requestsStreamUrl, (msg) => {
      if (msg.event !== 'entry') return
      try {
        const entry = JSON.parse(msg.data) as RequestLogEntry
        setEntries((prev) => {
          const idx = prev.findIndex((e) => e.id === entry.id)
          const next = idx === -1 ? [...prev, entry] : prev.map((e, i) => (i === idx ? entry : e))
          return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
        })
      } catch {
        /* ignore malformed frames */
      }
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
  }, [entries, autoScroll])

  return { entries, autoScroll, setAutoScroll, viewportRef }
}
