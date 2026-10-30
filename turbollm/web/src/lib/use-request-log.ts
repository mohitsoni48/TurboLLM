import { useEffect, useRef, useState } from 'react'
import { getRequests, requestsStreamUrl } from './api'
import { subscribeSse } from './sse'
import type { RequestLogEntry } from './types'

const MAX_ENTRIES = 500

/** A request is logged pending (status and error null) and finalized exactly once, so a final
 *  copy of a row is never older than a pending one. */
const isFinal = (e: RequestLogEntry) => e.status !== null || !!e.error

/** Merge a GET /requests snapshot into the rows on screen, by id. The snapshot no longer replaces
 *  them: the stream can deliver a request's finalize before the snapshot (taken while it still
 *  ran) arrives. Per id, the final copy wins over a pending one. A row the snapshot lacks is kept
 *  when it is final (history, as shown), or when it came on the current stream (it may have
 *  started after the snapshot was taken). A pending row that is in neither is gone from the
 *  daemon (a restart, an eviction), so its finalize never comes: it is dropped. */
function mergeSnapshot(prev: RequestLogEntry[], snapshot: RequestLogEntry[], live: ReadonlySet<string>): RequestLogEntry[] {
  const shown = new Map(prev.map((e) => [e.id, e]))
  const merged = new Map<string, RequestLogEntry>()
  for (const e of snapshot) {
    const p = shown.get(e.id)
    merged.set(e.id, p && isFinal(p) && !isFinal(e) ? p : e)
  }
  for (const p of prev) if (!merged.has(p.id) && (isFinal(p) || live.has(p.id))) merged.set(p.id, p)
  const next = [...merged.values()].sort((a, b) => a.ts - b.ts)
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
}

/** Shared live request-log logic (issue #211 follow-up): initial history (GET) + live SSE tail,
 *  capped ring buffer, plus an auto-scroll effect wired to a caller-owned viewport ref — the
 *  same shape as `use-engine-log.ts`'s `useEngineLog`, which this is deliberately modeled on so
 *  the two panels (Engine log / Requests) inside Monitor behave identically.
 *
 *  One difference from `useEngineLog`: an SSE frame here can name an id ALREADY in the buffer
 *  (a request's `start()` event, then its `finalize()` event moments later) — those are
 *  UPSERTED by id, not appended, so a request shows once and its row updates in place from
 *  "pending" to a real status. The history is loaded each time the stream opens (subscribe, then
 *  snapshot) and merged in by id ({@link mergeSnapshot}), so no event falls between the two and
 *  none is lost to a reconnect.
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
    // Ids the current stream has delivered, for mergeSnapshot.
    let live = new Set<string>()

    // The daemon's stream subscribes before its response goes out and sends live events only, and
    // a request's finalize is sent once. A GET sent alongside the stream could snapshot a moment
    // before that subscribe, and nothing replays what a dropped stream missed while it reconnected.
    // So the history is fetched once each stream is open, and merged rather than replacing the list.
    const loadHistory = () => {
      const seen = live
      void getRequests({ limit: MAX_ENTRIES })
        .then((res) => {
          if (!cancelled) setEntries((prev) => mergeSnapshot(prev, res.entries, seen))
        })
        .catch(() => {
          /* daemon may be down — keep what the panel shows rather than crash */
        })
    }

    // Not an EventSource: it can't send the API key, so the tail would 401 over LAN/remote access.
    // subscribeSse reconnects the same way when the stream drops.
    const close = subscribeSse(requestsStreamUrl, (msg) => {
      if (msg.event !== 'entry') return
      try {
        const entry = JSON.parse(msg.data) as RequestLogEntry
        live.add(entry.id)
        setEntries((prev) => {
          const idx = prev.findIndex((e) => e.id === entry.id)
          const next = idx === -1 ? [...prev, entry] : prev.map((e, i) => (i === idx ? entry : e))
          return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
        })
      } catch {
        /* ignore malformed frames */
      }
    }, { onOpen: () => { live = new Set(); loadHistory() } })

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

  // For the panel's "Clear log", once the daemon has dropped its copy: nothing on the stream says
  // the log was cleared, so without this every row stayed on screen (and a pending one stayed
  // pending — the daemon evicted it, so its finalize event never comes).
  const clear = () => setEntries([])

  return { entries, autoScroll, setAutoScroll, viewportRef, clear }
}
