import { useEffect, useRef, useState } from 'react'
import { engineLogStreamUrlFor, getEngineLogs } from './api'
import { subscribeSse } from './sse'

const MAX_LINES = 2000
/** How often the list of selectable pool slots is refreshed while the log is open (slots load and eject on their own). */
const SLOTS_REFRESH_MS = 10_000

/** Shared live-log-tail logic: initial tail (GET) + live SSE tail, capped ring buffer, plus
 *  an auto-scroll effect wired to a caller-owned viewport ref.
 *
 *  Extracted out of `EngineLogPanel.tsx` (issue #211) so the Monitor screen's always-open log
 *  view and Engines' collapsible panel share one fetch/SSE/cap implementation instead of two
 *  copies that can drift.
 *
 *  `active` gates the fetch+SSE subscription — no daemon connection is held while the caller
 *  doesn't need one (EngineLogPanel passes its own `open`; Monitor passes `true` while mounted).
 *
 *  `model` picks a pool slot's log instead of the primary's ('', the default); `slots` lists the ones on offer. A
 *  pick the daemon no longer knows (its slot was ejected: 404, or gone from `slots`) reverts to the primary. */
export function useEngineLog(active: boolean) {
  const [lines, setLines] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [slots, setSlots] = useState<string[]>([])
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
      void getEngineLogs(200, model || undefined)
        .then((res) => {
          tail = 'loaded'
          if (cancelled) return
          setLines(res.lines ?? [])
          setSlots(res.slots ?? [])
          if (model && !(res.slots ?? []).includes(model)) setModel('')
        })
        .catch((e: unknown) => {
          if (model && (e as { status?: number } | null)?.status === 404) {
            if (!cancelled) setModel('') // the slot was ejected: back to the primary's log
            return
          }
          /* daemon may be down — leave panel empty rather than crash; the next stream open asks again */
          tail = 'failed'
          if (openedWhileLoading && !cancelled) loadTail()
        })
    }
    loadTail()

    // Not an EventSource: it can't send the API key, so the tail would 401 over LAN/remote access.
    // subscribeSse reconnects the same way when the stream closes, sending the last line's id as
    // Last-Event-ID: the daemon resumes after it, so the lines written meanwhile are not lost.
    const close = subscribeSse(engineLogStreamUrlFor(model), (msg) => {
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

    // A slot loads or ejects without this view asking, so what the selector offers is refreshed on a slow timer.
    const refreshSlots = setInterval(() => {
      void getEngineLogs(1, model || undefined).then((res) => {
        if (cancelled) return
        setSlots(res.slots ?? [])
        if (model && !(res.slots ?? []).includes(model)) setModel('')
      }, () => { /* the next tick asks again */ })
    }, SLOTS_REFRESH_MS)

    return () => {
      cancelled = true
      clearInterval(refreshSlots)
      close()
    }
  }, [active, model])

  useEffect(() => {
    if (autoScroll && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  return { lines, autoScroll, setAutoScroll, viewportRef, model, setModel, slots }
}
