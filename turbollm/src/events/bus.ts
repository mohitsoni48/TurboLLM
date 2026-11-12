// The daemon's invalidation bus (scalability review 4.14 / 5.10). Changes are announced as KEYS only
// ("conversations", "conversation:<id>", "status", ...), never payloads: a client that hears a key
// refetches the query it names through the same authenticated routes it already uses, so nothing
// here can widen what a caller may read. GET /api/v1/events (events-routes.ts) fans these out.

/** What a subscriber is handed: the distinct keys emitted during one coalescing window. */
export type InvalidationListener = (keys: readonly string[]) => void

/** How long emits are gathered before they go out. A streaming reply, a download or a model load
 *  writes several times in a row; one delivery per window keeps every open page from refetching
 *  once per write, while a change still reaches the page well inside human reaction time. */
export const COALESCE_WINDOW_MS = 150

export class EventBus {
  private readonly listeners = new Set<InvalidationListener>()
  private readonly pending = new Set<string>()
  private windowTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly windowMs = COALESCE_WINDOW_MS) {}

  /** Announce that whatever `key` names changed. Free when nobody listens: no page is open. */
  emit(key: string): void {
    if (this.listeners.size === 0) return
    this.pending.add(key)
    this.windowTimer ??= this.openWindow()
  }

  subscribe(listener: InvalidationListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscriberCount(): number {
    return this.listeners.size
  }

  private openWindow(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.deliver(), this.windowMs)
    timer.unref?.()
    return timer
  }

  private deliver(): void {
    this.windowTimer = null
    const keys = [...this.pending]
    this.pending.clear()
    for (const listener of this.listeners) notifySafely(listener, keys)
  }
}

/** One page's broken listener must not cost every other page its invalidations. */
function notifySafely(listener: InvalidationListener, keys: readonly string[]): void {
  try {
    listener(keys)
  } catch {
    /* the stream behind it ends on its own; the rest still hear this window */
  }
}

/** The daemon's one bus. Process-wide on purpose: the stores that change (the chat DB, the download
 *  manager, every engine Manager, the scanner) are built in different places, and each only needs to
 *  say "this changed", never to know who listens. */
export const eventBus = new EventBus()

/** Announce a change on the daemon's bus. The hook other modules call (settings, config, ...). */
export function emitInvalidation(key: string): void {
  eventBus.emit(key)
}
