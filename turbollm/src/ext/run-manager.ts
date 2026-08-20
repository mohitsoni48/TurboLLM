// Daemon-owned runs for the public API (spec 27 §6). The reconnect primitive is NOT
// reimplemented here: RingBuffer + subscribeToBuffer come straight from code-run-manager.ts,
// where they are already pure, exported, and covered by 16 tests. What is new is the run
// LIFECYCLE — one run per generation, keyed by run id rather than session id, with liveness
// that counts polling as well as streaming.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { RingBuffer, subscribeToBuffer, type Subscription } from '../code/code-run-manager.js'
import type { EmitSink } from '../chat/emit-sink.js'
import type { Scope } from '../chat/store/types.js'

export type RunStatus = 'queued' | 'streaming' | 'complete' | 'failed' | 'aborted'

export interface PublicRun {
  id: string
  chatId: string
  messageId: string
  tenant: string
  owner: string
  status: RunStatus
  eventSeq: number
  error: { type: string; code: string; message: string } | null
  createdAt: string
  endedAt: string | null
}

/** What the manager drives. Returns the terminal status; may throw, which becomes `failed`. */
export type RunBody = (args: {
  emit: EmitSink
  signal: AbortSignal
}) => Promise<{ status: 'complete' | 'aborted' }>

interface RunState {
  run: PublicRun
  buffer: RingBuffer
  emitter: EventEmitter
  ac: AbortController
  settled: Promise<void>
  /** Last time a client attached a stream or polled. Drives reaping (spec 27 §6.5). */
  lastSeen: number
  subscribers: number
}

const DEFAULT_BUFFER_CAP = 5000
const DEFAULT_ORPHAN_TIMEOUT_MS = 5 * 60_000

export class PublicRunManager {
  private runs = new Map<string, RunState>()
  private readonly bufferCap: number
  private readonly orphanTimeoutMs: number

  constructor(opts?: { bufferCap?: number; orphanTimeoutMs?: number }) {
    this.bufferCap = opts?.bufferCap ?? DEFAULT_BUFFER_CAP
    this.orphanTimeoutMs = opts?.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT_MS
  }

  start(params: { scope: Scope; chatId: string; messageId: string; body: RunBody }): PublicRun {
    const id = `run_${randomUUID()}`
    const buffer = new RingBuffer(this.bufferCap)
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0) // unbounded: many clients may reconnect/poll one run
    const ac = new AbortController()
    const run: PublicRun = {
      id,
      chatId: params.chatId,
      messageId: params.messageId,
      tenant: params.scope.tenant,
      owner: params.scope.owner,
      status: 'queued',
      eventSeq: 0,
      error: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    }

    const emit: EmitSink = (ev) => {
      const buffered = buffer.push(ev.event, ev.data)
      run.eventSeq = buffered.seq
      emitter.emit('event', buffered)
    }

    const state: RunState = {
      run, buffer, emitter, ac,
      settled: Promise.resolve(),
      lastSeen: Date.now(),
      subscribers: 0,
    }

    state.settled = (async () => {
      run.status = 'streaming'
      try {
        const outcome = await params.body({ emit, signal: ac.signal })
        run.status = ac.signal.aborted ? 'aborted' : outcome.status
      } catch (e) {
        run.status = ac.signal.aborted ? 'aborted' : 'failed'
        run.error = { type: 'engine', code: 'engine_error', message: (e as Error).message }
        emit({ event: 'error', data: run.error })
      } finally {
        run.endedAt = new Date().toISOString()
        // The terminal frame is pushed to the buffer BEFORE 'idle', so subscribeToBuffer's
        // documented invariant delivers it to every attached client before ending them.
        emit({ event: 'done', data: { run_id: run.id, status: run.status, message_id: run.messageId } })
        emitter.emit('idle')
      }
    })()

    this.runs.set(id, state)
    return run
  }

  get(id: string): PublicRun | null {
    return this.runs.get(id)?.run ?? null
  }

  list(tenant: string): PublicRun[] {
    return [...this.runs.values()].filter((s) => s.run.tenant === tenant).map((s) => s.run)
  }

  /** Resolves when the run's body has settled. Test and shutdown helper. */
  settled(id: string): Promise<void> {
    return this.runs.get(id)?.settled ?? Promise.resolve()
  }

  /** Fire a run's AbortController and reflect the decision to abort in its status IMMEDIATELY —
   *  the injected body only notices `signal.aborted` at its own next `await` (which, while it is
   *  blocked on something else entirely — e.g. an engine call — may not happen for a while), but a
   *  caller polling GET /runs/{id} right after cancel()/reapOrphans() must see 'aborted' now, not
   *  a stale 'streaming'. Idempotent: safe to call again on a run already aborted-but-not-settled. */
  private abortRun(s: RunState): void {
    if (s.run.endedAt) return
    s.run.status = 'aborted'
    s.ac.abort()
  }

  cancel(id: string): boolean {
    const s = this.runs.get(id)
    if (!s || s.run.endedAt) return false
    this.abortRun(s)
    return true
  }

  /** Records client interest. A poll of GET /runs/{id} counts exactly as much as an attached
   *  stream — otherwise the reaper would kill the poll-only clients spec §5.1 recommends. */
  touch(id: string): void {
    const s = this.runs.get(id)
    if (s) s.lastSeen = Date.now()
  }

  /** Whether `fromSeq` is still inside the retained window. False ⇒ the caller must be told
   *  `replay_window_exceeded` and re-read the message instead of silently getting a gap. */
  canReplayFrom(id: string, fromSeq: number): boolean {
    const s = this.runs.get(id)
    if (!s) return false
    const retained = s.buffer.since(fromSeq)
    if (retained.length === 0) return fromSeq >= s.buffer.head()
    return retained[0].seq === fromSeq
  }

  subscribe(id: string, fromSeq: number): Subscription {
    const s = this.runs.get(id)
    if (!s) return subscribeToBuffer(new RingBuffer(1), new EventEmitter(), { fromSeq: 0, replayFloor: 0, idleAtStart: true })
    s.lastSeen = Date.now()
    s.subscribers++
    const sub = subscribeToBuffer(s.buffer, s.emitter, {
      fromSeq,
      // One run is one turn, so there is never an earlier turn to skip — unlike the Code
      // manager, whose replayFloor advances per turn.
      replayFloor: 0,
      idleAtStart: s.run.endedAt !== null,
    })

    let departed = false
    /** Decrement the subscriber count exactly once, however this subscription stops being
     *  watched — an explicit close(), a `for await (...) { break }` (which invokes the async
     *  iterator's own return(), NOT our close()), or plain exhaustion (next() resolving
     *  done:true). Whichever happens first wins; later calls are no-ops. Never touches the run's
     *  AbortController — only reapOrphans() decides whether an unwatched run gets aborted. */
    const departOnce = () => {
      if (departed) return
      departed = true
      s.subscribers = Math.max(0, s.subscribers - 1)
      s.lastSeen = Date.now()
    }

    // subscribeToBuffer's own iterator is what actually holds the replay/live-tail state; we
    // grab it once and wrap every way a caller can stop consuming it, rather than only wrapping
    // the Subscription's close() (which a for-await loop never calls on early exit).
    const iter = sub[Symbol.asyncIterator]()

    return {
      close: () => { departOnce(); sub.close() },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const r = await iter.next()
            if (r.done) departOnce()
            return r
          },
          async return() {
            departOnce()
            return (await iter.return?.()) ?? { value: undefined as never, done: true as const }
          },
        }
      },
    }
  }

  /** Abort runs nobody has watched or polled for orphanTimeoutMs, so an abandoned client
   *  cannot pin the GPU. Called on an interval by the server. */
  reapOrphans(): void {
    const now = Date.now()
    for (const s of this.runs.values()) {
      if (s.run.endedAt) continue
      if (s.ac.signal.aborted) continue // already reaped/cancelled; awaiting the body to settle
      if (s.subscribers > 0) continue
      if (now - s.lastSeen < this.orphanTimeoutMs) continue
      this.abortRun(s)
    }
  }

  /** Runs do not survive a restart (spec 27 §6.4) — nothing is in memory to resume. Any run
   *  row still marked streaming from a previous process is closed out as failed. */
  reconcileOnStartup(): void {
    for (const s of this.runs.values()) {
      if (!s.run.endedAt) {
        s.run.status = 'failed'
        s.run.error = { type: 'engine', code: 'daemon_restarted', message: 'The daemon restarted while this run was streaming.' }
        s.run.endedAt = new Date().toISOString()
      }
    }
  }

  /** Drop terminal runs older than `maxAgeMs` so the map cannot grow without bound. */
  prune(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs
    for (const [id, s] of this.runs) {
      if (s.run.endedAt && Date.parse(s.run.endedAt) < cutoff) this.runs.delete(id)
    }
  }
}
