// The app's one invalidation stream (scalability review 4.14 / 5.10). The daemon sends keys naming what
// changed (`conversations`, `conversation:<id>`, `status`, ...) over GET /api/v1/events; each becomes an
// invalidateQueries call, so a screen refetches when something it shows changed rather than on a short
// timer. The timers stay as a safety net: {@link pollWhileLive} lengthens them only while the stream is
// really open, so a daemon without the route, a scoped token refused it, or a dropped stream all fall
// back to the cadence each query had before.
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { useEffect } from 'react'
import { subscribeSse, type SseMessage } from './sse'

export const eventsStreamUrl = '/api/v1/events'

/** A poll the stream replaces runs at this cadence while the stream is open: it only has to catch what
 *  an invalidation could miss (a write the daemon does not announce, a message lost to a proxy). */
export const EVENT_FALLBACK_POLL_MS = 30_000

/** Sent by the daemon when it gave up tracking what a slow page missed: refetch everything. */
const RESYNC_KEY = '*'

let streamOpen = false

/** Whether this tab's invalidation stream is open right now. */
export function liveEventsConnected(): boolean {
  return streamOpen
}

/** The interval for a poll the stream makes a safety net: `fallbackMs` while it is open, else `pollMs`. */
export function pollWhileLive(pollMs: number, fallbackMs = EVENT_FALLBACK_POLL_MS): number {
  return streamOpen ? Math.max(pollMs, fallbackMs) : pollMs
}

/** Each family key's query prefixes. Literal rather than imported from the *-queries modules, which import
 *  this one (live-events.test.tsx checks they still agree). */
const FAMILY_TARGETS: Record<string, QueryKey[]> = {
  status: [['status']],
  conversations: [['conversations'], ['folders']],
  memory: [['memory-facts']],
  routines: [['routines'], ['routine'], ['routine-runs']],
  downloads: [['downloads']],
  models: [['models']],
  engines: [['engines'], ['engine-updates']],
  'code-sessions': [['code-sessions'], ['code-session']],
  settings: [['settings']],
}

/** Keys naming one entity: `<scope>:<id>`, onto that entity's own query. */
const ENTITY_TARGETS: Record<string, (id: string) => QueryKey> = {
  conversation: (id) => ['conversation', id],
  'routine-runs': (id) => ['routine-runs', id],
}

/** The query keys an invalidation key names; none for a key this build does not know. */
export function invalidationTargets(key: string): QueryKey[] {
  const family = FAMILY_TARGETS[key]
  if (family) return family
  const colon = key.indexOf(':')
  const entity = colon > 0 ? ENTITY_TARGETS[key.slice(0, colon)] : undefined
  return entity ? [entity(key.slice(colon + 1))] : []
}

/** Mounted once, in the app shell: holds the stream open for the page's lifetime. */
export function useLiveInvalidation(): void {
  const qc = useQueryClient()
  useEffect(() => {
    let reopened = false
    const close = subscribeSse(eventsStreamUrl, (msg) => applyInvalidation(qc, msg), {
      onOpen: () => {
        streamOpen = true
        // A reopened stream may have missed keys while it was down; the first open follows the page's own loads.
        if (reopened) void qc.invalidateQueries()
        reopened = true
      },
      onClose: () => { streamOpen = false },
    })
    return () => {
      close()
      streamOpen = false
    }
  }, [qc])
}

function applyInvalidation(qc: QueryClient, msg: SseMessage): void {
  if (msg.event !== 'invalidate') return
  const keys = parseKeys(msg.data)
  if (keys.includes(RESYNC_KEY)) {
    void qc.invalidateQueries()
    return
  }
  for (const queryKey of keys.flatMap(invalidationTargets)) void qc.invalidateQueries({ queryKey })
}

function parseKeys(data: string): string[] {
  try {
    const keys: unknown = JSON.parse(data)
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}
