// GET /api/v1/events (scalability review 4.14 / 5.10): one Server-Sent Events stream per open page,
// carrying invalidation keys from the daemon's bus. The page refetches what a key names, so its many
// short polls become slow safety nets. Payload-free by design: see bus.ts.
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { holdOpen } from '../auth'
import { eventBus, type EventBus } from './bus'

/** Sent instead of a key list that outgrew {@link MAX_PENDING_KEYS}: "refetch everything". */
export const RESYNC_KEY = '*'

/** Distinct keys one connection may hold while its client is not taking them. Past this the client is
 *  behind enough that a full resync costs less than remembering what it missed, so the backlog is
 *  replaced by {@link RESYNC_KEY}: a slow page holds a bounded few bytes here, never a growing queue. */
export const MAX_PENDING_KEYS = 64

/** Under the ~100 s a Cloudflare tunnel (Turbo Link, remote access) lets a response sit silent. */
export const HEARTBEAT_MS = 25_000

/** The part of hono's SSE stream a relay writes to. */
export interface InvalidationSink {
  writeSSE(message: { event: string; data: string }): Promise<void>
  write(text: string): Promise<unknown>
}

export interface EventsRouteOptions {
  bus?: EventBus
  heartbeatMs?: number
}

export function registerEventsRoutes(app: Hono, opts: EventsRouteOptions = {}): void {
  const bus = opts.bus ?? eventBus
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  app.get('/api/v1/events', (c) =>
    // holdOpen: the key or the open LAN that let it in can go while it runs (auth.ts endStaleStreams).
    streamSSE(c, holdOpen(c, async (stream) => {
      const relay = new InvalidationRelay(stream)
      const unsubscribe = bus.subscribe((keys) => relay.hear(keys))
      const heartbeat = setInterval(() => relay.heartbeat(), heartbeatMs)
      try {
        await stream.write(': connected\n\n')
        await untilClientLeaves(stream)
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
      }
    })),
  )
}

function untilClientLeaves(stream: { onAbort(listener: () => void): void }): Promise<void> {
  return new Promise<void>((resolve) => stream.onAbort(resolve))
}

/** One connection's writer: at most one write out at a time, keys heard meanwhile merged into the next. */
export class InvalidationRelay {
  private pending = new Set<string>()
  private writing = false

  constructor(private readonly sink: InvalidationSink) {}

  hear(keys: readonly string[]): void {
    for (const key of keys) this.pending.add(key)
    if (this.pending.size > MAX_PENDING_KEYS) this.pending = new Set([RESYNC_KEY])
    void this.sendPending()
  }

  /** A comment line: keeps proxies and tunnels from closing an idle stream, and the client ignores it. */
  heartbeat(): void {
    if (this.writing) return
    void this.sink.write(': keep-alive\n\n').catch(() => {})
  }

  private async sendPending(): Promise<void> {
    if (this.writing || this.pending.size === 0) return
    const data = JSON.stringify([...this.pending])
    this.pending.clear()
    this.writing = true
    try {
      await this.sink.writeSSE({ event: 'invalidate', data })
    } catch {
      /* the client went; the route's onAbort ends the stream */
    } finally {
      this.writing = false
    }
    await this.sendPending()
  }
}
