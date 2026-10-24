// A chat reply as a run the daemon owns, not the request that started it (the owner's rule: the web UI is a frontend,
// and closing, reloading or leaving a page, Android's Back, or a dropped connection never stops work the daemon is
// doing). The turn routes (chat-routes.ts startDetachedTurn) run each turn against one of these; the POST that started
// it and every later GET .../stream are only viewers of its frames.
//
// Built on Code's replay primitives (code/run-buffer.ts) and nothing else heavy: importing code-run-manager.ts would
// pull in code-session.ts and the pi-coding-agent chain, which the Android runtime cannot load (run-buffer.ts's
// header). One run per turn, not one buffer per conversation: Stop frees the chat at once, so a stopped turn can still
// be unwinding (a tool call that ignores the abort) while the next turn runs, and a buffer shared by the two would mix
// their frames (the old turn's `done` would end the new turn's view).
//
// Memory: a run keeps at most `cap` frames (RingBuffer's 6000 by default, as Code), and a finished run is dropped
// `retainMs` after it ended. Text deltas are about 100 bytes each, but a `tool_call` frame carries its arguments and
// result, and `done` the whole saved message, so a tool-heavy run weighs more than its count. A viewer's own backlog
// (frames handed to it but not yet written to its socket: a slow or stalled client) is bounded as well: one that
// falls too far behind is dropped with a `lagged` frame and resumes from its cursor (see subscribe).
import { EventEmitter } from 'node:events'
import { RingBuffer, subscribeToBuffer, type BufferedEvent } from '../code/run-buffer'
import type { EmitSink } from './emit-sink'

/** The rows a turn writes into: the question it answers and the placeholder its reply fills. Frame 0 of every run. */
export interface ChatRunMeta { userMessageId: string; assistantMessageId: string }

export interface ChatRun {
  readonly convId: string
  readonly meta: ChatRunMeta
  /** The turn's own abort: Stop, DELETE, the engine kill switches and a revoked admission (auth.ts holdTurn) fire it. */
  readonly ac: AbortController
  readonly buffer: RingBuffer
  readonly emitter: EventEmitter
  /** The turn has fully unwound (its last frame is in the buffer). */
  ended: boolean
}

/** A viewer of one run: replays from its cursor, then live-tails until the run ends or it is closed. */
export interface ChatSubscription extends AsyncIterable<BufferedEvent> {
  close(): void
  /** It fell too far behind the run and was dropped (see ChatRuns.subscribe). */
  lagged(): boolean
}

const DEFAULT_CAP = 6000 // RingBuffer's own default (run-buffer.ts BUFFER_CAP), shared with Code
const DEFAULT_RETAIN_MS = 30_000 // Code's IDLE_RETAIN_MS: a viewer that reconnects right after the end still gets `done`

export class ChatRuns {
  /** Each chat's latest run, live or ended and still retained. */
  private latest = new Map<string, ChatRun>()
  /** Every run still live or retained, by its reply's id: a viewer that names its run follows that one to its end,
   *  also once a newer turn of the chat has taken `latest` (a stopped run still unwinding). */
  private byReply = new Map<string, ChatRun>()
  private readonly cap: number
  private readonly retainMs: number

  constructor(opts: { cap?: number; retainMs?: number } = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP
    this.retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS
  }

  /** Registers the turn's run, pushes its `meta` as frame 0 (synchronously, so every viewer sees it first), and returns
   *  the sink the turn emits through. The sink never throws (resilientSink never trips on it) and drops what a turn
   *  emits after end(). */
  start(convId: string, ac: AbortController, meta: ChatRunMeta): { run: ChatRun; sink: EmitSink } {
    const emitter = new EventEmitter()
    emitter.setMaxListeners(0) // every viewer of the run listens on it (as code-run-manager.ts)
    const run: ChatRun = { convId, meta, ac, buffer: new RingBuffer(this.cap), emitter, ended: false }
    this.latest.set(convId, run)
    this.byReply.set(meta.assistantMessageId, run)
    const push = (event: string, data: unknown) => { emitter.emit('event', run.buffer.push(event, data)) }
    push('meta', meta)
    return { run, sink: (ev) => { if (!run.ended) push(ev.event, ev.data) } }
  }

  /** The turn has fully unwound: every viewer gets the rest of its frames and then ends. The run stays retained for
   *  `retainMs` (an unref'd timer), and is then dropped where it is still the one registered (a newer turn of the chat
   *  keeps its own entry). */
  end(run: ChatRun): void {
    if (run.ended) return
    run.ended = true
    run.emitter.emit('idle')
    setTimeout(() => {
      if (this.latest.get(run.convId) === run) this.latest.delete(run.convId)
      if (this.byReply.get(run.meta.assistantMessageId) === run) this.byReply.delete(run.meta.assistantMessageId)
    }, this.retainMs).unref()
  }

  /** The chat's latest run (live, or ended and still retained), or undefined. */
  latestRun(convId: string): ChatRun | undefined {
    return this.latest.get(convId)
  }

  /** The run generating reply `replyId` of chat `convId` (live, or ended and still retained), or undefined. */
  find(convId: string, replyId: string): ChatRun | undefined {
    const run = this.byReply.get(replyId)
    return run && run.convId === convId ? run : undefined
  }

  /** A viewer of `run` from cursor `fromSeq` (the seq of the first frame it still needs):
   *  - from the cursor, while it is in the retained window (a cursor at the head replays nothing and live-tails);
   *  - from the oldest retained frame when the cursor is past the head or has left the window: the viewer sees the
   *    first frame's seq differ from its cursor and starts the reply over (web chat-api.ts followChatTurn);
   *  - a run that has ended replays what is left and ends (subscribeToBuffer delivers the terminal frame first).
   *  A viewer more than twice `cap` frames behind what the run has pushed (its socket stalled: its replay of at most
   *  the window, plus as many again) is closed and marked lagged, so its backlog stays bounded; its page resumes from
   *  its cursor. */
  subscribe(run: ChatRun, fromSeq: number): ChatSubscription {
    const head = run.buffer.head()
    const oldest = run.buffer.since(0)[0]?.seq ?? head
    const from = fromSeq >= oldest && fromSeq <= head ? fromSeq : oldest
    const inner = subscribeToBuffer(run.buffer, run.emitter, { fromSeq: from, replayFloor: 0, idleAtStart: run.ended })
    let delivered = from - 1
    let lagged = false
    const onPush = (ev: BufferedEvent) => {
      if (ev.seq - delivered > 2 * this.cap) { lagged = true; close() }
    }
    const close = () => {
      run.emitter.off('event', onPush)
      inner.close()
    }
    run.emitter.on('event', onPush)
    const it = inner[Symbol.asyncIterator]()
    return {
      close,
      lagged: () => lagged,
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<BufferedEvent>> {
            const r = await it.next()
            if (r.done) run.emitter.off('event', onPush)
            else delivered = r.value.seq
            return r
          },
          async return(): Promise<IteratorResult<BufferedEvent>> {
            close()
            return { value: undefined as unknown as BufferedEvent, done: true }
          },
        }
      },
    }
  }
}

/** The daemon's one registry. */
export const chatRuns = new ChatRuns()
