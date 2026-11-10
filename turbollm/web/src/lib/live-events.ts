// The app's one invalidation stream (scalability review 4.14 / 5.10). The daemon sends keys naming what
// changed (`conversations`, `conversation:<id>`, `status`, ...) over GET /api/v1/events; each becomes an
// invalidateQueries call, so a screen refetches when something it shows changed rather than on a short
// timer. The timers stay as a safety net: {@link pollWhileLive} lengthens them only while the stream is
// really open, so a daemon without the route, a scoped token refused it, or a dropped stream all fall
// back to the cadence each query had before.
//
// Open only while the tab shows. The daemon speaks plain HTTP/1.1, and a browser keeps at most 6
// connections to one host across all its tabs: an idle stream held by every hidden tab left the visible
// one's requests queued behind them, and the app looked hung. A hidden tab's polls are paused anyway
// (refetchIntervalInBackground: false), so it misses nothing it would show; on showing again it reopens
// the stream and refetches everything once.
import { useQueryClient, type InvalidateQueryFilters, type Query, type QueryClient } from '@tanstack/react-query'
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

const byPrefix = (...queryKey: string[]): InvalidateQueryFilters => ({ queryKey })

/** The sidebar's polled first page of each list (chatKeys.listHead): refetching it is what tells the list a
 *  row changed (useConversationListPoll), so the pages the user scrolled to are refetched only when it did. */
const conversationListHeads: InvalidateQueryFilters = {
  predicate: (query: Query) => query.queryKey[0] === 'conversations' && query.queryKey[2] === 'head',
}

/** Each family key's queries. Literal rather than imported from the *-queries modules, which import this one
 *  (live-events.test.tsx checks they still agree). A routine's runs are announced by their own key. */
const FAMILY_TARGETS: Record<string, InvalidateQueryFilters[]> = {
  status: [byPrefix('status')],
  conversations: [conversationListHeads, byPrefix('folders')],
  memory: [byPrefix('memory-facts')],
  routines: [byPrefix('routines'), byPrefix('routine')],
  downloads: [byPrefix('downloads')],
  models: [byPrefix('models')],
  engines: [byPrefix('engines'), byPrefix('engine-updates')],
  'code-sessions': [byPrefix('code-sessions'), byPrefix('code-session')],
  settings: [byPrefix('settings')],
  sandboxRuntime: [byPrefix('sandbox-runtime')],
}

/** Keys naming one entity: `<scope>:<id>`, onto that entity's own queries. */
const ENTITY_TARGETS: Record<string, (id: string) => InvalidateQueryFilters> = {
  conversation: (id) => byPrefix('conversation', id),
  'routine-runs': (id) => byPrefix('routine-runs', id),
}

/** The queries an invalidation key names; none for a key this build does not know. */
export function invalidationTargets(key: string): InvalidateQueryFilters[] {
  const family = FAMILY_TARGETS[key]
  if (family) return family
  const colon = key.indexOf(':')
  const entity = colon > 0 ? ENTITY_TARGETS[key.slice(0, colon)] : undefined
  return entity ? [entity(key.slice(colon + 1))] : []
}

/** Mounted once, in the app shell: holds the stream open whenever the page shows, for its lifetime. */
export function useLiveInvalidation(): void {
  const qc = useQueryClient()
  useEffect(() => followWhileVisible(qc), [qc])
}

/** Opens the stream while the tab shows and lets it go while hidden. Returns the function that stops it. */
function followWhileVisible(qc: QueryClient): () => void {
  let closeStream: (() => void) | null = null
  const follow = (resync: boolean) => { closeStream ??= openStream(qc, resync) }
  const letGo = () => {
    closeStream?.()
    closeStream = null
    streamOpen = false
  }
  const onVisibilityChange = () => (tabHidden() ? letGo() : follow(true))

  if (!tabHidden()) follow(false)
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    letGo()
  }
}

function tabHidden(): boolean {
  return document.visibilityState === 'hidden'
}

/** One stream, reopened by subscribeSse when it drops. Every open but the first catches up on what it may have
 *  missed while down, as does the first when `resyncOnOpen` (the tab showing again). A drop refetches at once, so
 *  each poll restarts at the fast cadence it falls back to rather than finishing its long wait first. Being let go
 *  (the tab hiding, the shell unmounting) refetches nothing. Returns the function that lets it go. */
function openStream(qc: QueryClient, resyncOnOpen: boolean): () => void {
  let resync = resyncOnOpen
  let lettingGo = false
  const close = subscribeSse(eventsStreamUrl, (msg) => applyInvalidation(qc, msg), {
    onOpen: () => {
      streamOpen = true
      if (resync) void qc.invalidateQueries()
      resync = true
    },
    onClose: () => {
      streamOpen = false
      if (!lettingGo) void qc.invalidateQueries()
    },
  })
  return () => {
    lettingGo = true
    close()
  }
}

function applyInvalidation(qc: QueryClient, msg: SseMessage): void {
  if (msg.event !== 'invalidate') return
  const keys = parseKeys(msg.data)
  if (keys.includes(RESYNC_KEY)) {
    void qc.invalidateQueries()
    return
  }
  for (const filters of keys.flatMap(invalidationTargets)) void qc.invalidateQueries(filters)
}

function parseKeys(data: string): string[] {
  try {
    const keys: unknown = JSON.parse(data)
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}
