// Reconnectable event replay primitives (Task 5) — split out of code-run-manager.ts on
// purpose, not for tidiness: code-run-manager.ts imports code-session.ts, which statically
// imports @earendil-works/pi-ai/pi-coding-agent — a dependency chain that uses `\p{...}`
// Unicode-property regex syntax TurboLLM Android's embedded runtime can't even PARSE (a
// module-load-time SyntaxError, not a catchable one — confirmed live, crashes the whole
// daemon before any of its own code runs, see TurboLLM Android's BLUEPRINT.md Spike D).
// ext/run-manager.ts only ever needed these ring-buffer primitives, not CodeRunManager
// itself — but importing them FROM code-run-manager.ts pulled in that entire file's
// transitive dependencies anyway, dragging the pi-coding-agent chain in eagerly even though
// server.ts's own CodeRunManager wiring is already correctly Android-gated. This file has
// zero dependency on code-session.ts (or anything else heavy) by construction.
import type { EventEmitter } from 'node:events'

/** How many recent events to retain per session for replay-on-reconnect. A long turn emits
 *  many text deltas; if the buffer overflows, a reconnecting client misses the earliest
 *  live deltas of the in-flight turn — but the final assistant text is DB-persisted on
 *  completion, so overflow only ever costs mid-stream cosmetic replay, never the result. */
const BUFFER_CAP = 6000

export interface BufferedEvent {
  seq: number
  event: string
  data: unknown
}

/** A bounded, seq-numbered append log. `since(fromSeq)` is the replay primitive. */
export class RingBuffer {
  private events: BufferedEvent[] = []
  private nextSeq = 0

  /** `cap` is how many recent events are retained for replay. Defaults to BUFFER_CAP so the
   *  Code path is unchanged; the public API passes its own (spec 27 §6.3). */
  constructor(private readonly cap: number = BUFFER_CAP) {}

  push(event: string, data: unknown): BufferedEvent {
    const ev: BufferedEvent = { seq: this.nextSeq++, event, data }
    this.events.push(ev)
    if (this.events.length > this.cap) this.events.shift()
    return ev
  }

  /** Every retained event with seq >= fromSeq, in order. */
  since(fromSeq: number): BufferedEvent[] {
    return this.events.filter((e) => e.seq >= fromSeq)
  }

  /** The seq the NEXT pushed event will get (one past the last). */
  head(): number {
    return this.nextSeq
  }
}

/** A subscriber: an async-iterable of buffered events that first drains the replay backlog,
 *  then live-tails, and terminates when the session goes idle (or is closed by the caller). */
export interface Subscription extends AsyncIterable<BufferedEvent> {
  close(): void
}

/**
 * The core reconnect primitive, extracted pure so it's unit-testable without a live run.
 *
 * Returns an async-iterable that:
 *   1. first drains buffer.since(max(fromSeq, replayFloor)) — the replay backlog;
 *   2. then live-tails events the emitter emits as `('event', BufferedEvent)`;
 *   3. terminates (iterator done) when the emitter emits `('idle')` AND the backlog is drained,
 *      or when `idleAtStart` is true and the backlog is drained (session already idle), or when
 *      `.close()` / iterator `.return()` is called (the HTTP connection dropped).
 *
 * Invariant: the terminal event already pushed to the buffer (e.g. 'done'/'error') is always
 * delivered BEFORE the iterator ends — 'idle' never truncates a pending backlog.
 */
export function subscribeToBuffer(
  buffer: RingBuffer,
  emitter: EventEmitter,
  opts: { fromSeq: number; replayFloor: number; idleAtStart: boolean },
): Subscription {
  const effectiveFrom = Math.max(opts.fromSeq, opts.replayFloor)
  const pending: BufferedEvent[] = buffer.since(effectiveFrom)
  let ended = opts.idleAtStart
  let closed = false
  let resolver: ((r: IteratorResult<BufferedEvent>) => void) | null = null

  const settle = (r: IteratorResult<BufferedEvent>) => {
    const fn = resolver
    resolver = null
    fn?.(r)
  }
  const onEvent = (ev: BufferedEvent) => {
    if (closed) return
    if (resolver && pending.length === 0) settle({ value: ev, done: false })
    else pending.push(ev)
  }
  const onIdle = () => {
    ended = true
    // Only resolve NOW if nothing is buffered; otherwise the pending drain in next() will
    // observe `ended` and terminate after the last real event (e.g. the terminal 'done').
    if (resolver && pending.length === 0) settle({ value: undefined as unknown as BufferedEvent, done: true })
  }

  emitter.on('event', onEvent)
  emitter.once('idle', onIdle)

  const close = () => {
    if (closed) return
    closed = true
    emitter.off('event', onEvent)
    emitter.off('idle', onIdle)
    settle({ value: undefined as unknown as BufferedEvent, done: true })
  }

  return {
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<BufferedEvent>> {
          if (closed) return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true })
          if (pending.length > 0) return Promise.resolve({ value: pending.shift()!, done: false })
          if (ended) { close(); return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true }) }
          return new Promise<IteratorResult<BufferedEvent>>((res) => { resolver = res })
        },
        return(): Promise<IteratorResult<BufferedEvent>> {
          close()
          return Promise.resolve({ value: undefined as unknown as BufferedEvent, done: true })
        },
      }
    },
  }
}
