// The SSE-stream orchestration + event-to-state reduction for a live Code run, lifted OUT of
// CodeSessionScreen.tsx (ADR-260). This is deliberately plain TS with ZERO React/DOM imports:
// it owns the reconnectable GET /stream subscription, the ring-buffer seq cursor, and the
// reduction of each SSE frame into a `LiveState`, and hands the host (today CodeSessionScreen,
// tomorrow a hypothetical `turbollm code` CLI) only the framework-specific side effects — state
// sync, query invalidation, toasts, scrolling — back through a handlers interface. The React
// component becomes a thin adapter: it constructs one client per session, mirrors `onLive` into
// its own useState, and drives connect()/abort() from its effects.
import { ApiError } from './api'
import { streamCodeSession } from './code-api'
import type { CodeStreamEvent, QueuedTurn, TodoItem } from './code-types'
import type { LiveToolCall } from './chat-types'
import { appendTextDelta, appendTurnMarker, applyToolProgress, upsertToolCall, type LiveBlock } from './live-timeline'

/** An in-progress auto-retry (Phase 2, ADR-250) — pi is waiting out a transient provider failure
 *  before re-attempting the same turn. Present between a `retry` start and its matching end; null
 *  otherwise. Drives the transcript's "Retrying…" status banner. */
export interface RetryState {
  attempt: number
  maxAttempts: number
  /** The error that triggered this retry (from the `start` frame), shown as the reason. */
  message: string
}

export interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  timeline: LiveBlock[]
  /** True between a 'compaction' SSE event's start and end phases — pi's own AUTO-compaction
   *  silently summarizing history mid-turn (distinct from the manual /compact command). Drives
   *  CodeThinking's "Compacting conversation…" state instead of a blank/generic gap. */
  compacting?: boolean
  /** Set while an auto-retry is in flight (Phase 2) — cleared back to null on the retry's end
   *  frame. Drives the "Retrying…" banner. */
  retry?: RetryState | null
  /** The model's current plan for THIS turn (ADR-255), from the latest `todos` frame — a full
   *  replace each time, not a merge. Undefined until the model calls `update_todos` at least once
   *  for the current turn; naturally resets to undefined on a genuinely NEW turn because the fresh
   *  LiveState object below (`meta` with a new assistantId) omits it — the backend's own
   *  reset-per-turn semantics need no separate client-side clear. */
  todos?: TodoItem[]
  /** Prompt-processing (prefill) progress from a `prefill` SSE frame — llama.cpp only, present
   *  ONLY before the first token of a turn. Cleared back to null the instant a real delta/reasoning
   *  token arrives (the backend also stops firing prefill frames then) and on turn end (the whole
   *  LiveState is discarded). Null/absent is the NORMAL path (non-llama.cpp engines, or a prompt
   *  that prefills inside one poll interval and never gets a frame). Drives the transcript's
   *  "Processing prompt NN%" bar, which takes the status-banner slot over retry/compacting/thinking
   *  while active — prefill happens strictly before generation, so the two never co-render. */
  prefill?: { processed: number; total: number; pct: number } | null
}

/** Apply `fn` to the current live block, creating one (anchored to `fallbackId`) if none exists
 *  yet — so a live delta/tool_call that arrives on a reconnect BEFORE a `meta` frame (e.g. the
 *  real meta aged out of the daemon's ring buffer) still attaches to the right assistant turn
 *  instead of being dropped. */
export function reduceLive(l: LiveState | null, fallbackId: string, fn: (b: LiveState) => LiveState): LiveState {
  const base = l ?? { assistantId: fallbackId, content: '', reasoning: '', timeline: [] }
  return fn(base)
}

/** The framework-specific side effects the client can't perform itself. Every callback is a pure
 *  "the host should now do X" signal — the client never touches React, react-query, toasts, or the
 *  DOM directly. */
export interface CodeSessionClientHandlers {
  /** Sync the reduced live-turn state (or null when the turn ends) into the host's own state. */
  onLive(state: LiveState | null): void
  /** The server-side queue's current contents (a `queue` SSE frame). */
  onQueue(queued: QueuedTurn[]): void
  /** A `meta` frame — a turn just went live. The host reconciles its detail query. */
  onTurnStart(): void
  /** A `done` frame — the turn finished cleanly. The host reconciles + scrolls to latest. */
  onTurnDone(): void
  /** An `error` frame — the turn failed. The host reconciles and surfaces `message`. */
  onTurnError(message: string): void
  /** The stream ended (generator completed) = the daemon reports the session idle. The host
   *  reconciles with the DB transcript. Distinct from onTurnDone: no stats invalidation/scroll. */
  onIdle(): void
  /** Reconnect attempts exhausted. `silent` is true for a 404 (the run is simply gone) so the
   *  host can skip the "Lost connection" toast in that case. */
  onLostConnection(silent: boolean): void
}

/** The async-generator factory the client consumes. Defaults to code-api.ts's `streamCodeSession`;
 *  injectable so the module is unit-testable with a fake stream and no network. */
export type CodeStreamFn = (sessionId: string, fromSeq: number, signal: AbortSignal) => AsyncGenerator<CodeStreamEvent>

/** One reconnectable GET /stream subscription for a single Code session. Create one per session;
 *  discard (after abort()) and make a fresh one on session change — that's what resets the seq
 *  cursor and active-assistant id, so there's no explicit reset method. */
export class CodeSessionClient {
  private static readonly RECONNECT_MAX = 6

  private live: LiveState | null = null
  /** The last ring-buffer seq consumed, so a reconnect resumes from there. */
  private lastSeq = 0
  /** The in-flight turn's assistant message id (from the `meta` frame), so live deltas that arrive
   *  after a reconnect (whose meta may have aged out of the buffer) still attach to the right turn. */
  private activeAssistantId = ''
  private active = false
  private ac: AbortController | null = null

  constructor(
    private readonly sessionId: string,
    private readonly handlers: CodeSessionClientHandlers,
    private readonly streamFn: CodeStreamFn = streamCodeSession,
  ) {}

  /** True while connected or mid-reconnect. Mirrors the old `streamActiveRef.current` — the host
   *  reads it to decide whether to (re)connect on load and whether to seed queue state itself. */
  get isActive(): boolean {
    return this.active
  }

  private emitLive(state: LiveState | null): void {
    this.live = state
    this.handlers.onLive(state)
  }

  /** Start the single, reconnectable run subscription. It replays whatever the daemon already
   *  buffered for the in-flight turn (from `lastSeq`) then live-tails; on a network drop it
   *  reconnects from the last seq seen. It ends only when the daemon reports the session idle (the
   *  async generator completing). Because the run is daemon-owned, this stream never drives it —
   *  aborting only DETACHES. A no-op if already active (one active stream per client). */
  connect(): void {
    if (this.active) return
    this.active = true
    const ac = new AbortController()
    this.ac = ac
    let attempt = 0

    const run = async (): Promise<void> => {
      try {
        for await (const evt of this.streamFn(this.sessionId, this.lastSeq, ac.signal)) {
          if (typeof evt.seq === 'number') this.lastSeq = Math.max(this.lastSeq, evt.seq + 1)
          if (evt.event === 'meta') {
            attempt = 0 // a real frame means the connection is healthy again
            this.activeAssistantId = evt.data.assistantMessageId
            const id = evt.data.assistantMessageId
            this.emitLive(this.live && this.live.assistantId === id
              ? this.live
              : { assistantId: id, content: '', reasoning: '', timeline: [] })
            this.handlers.onTurnStart()
          } else if (evt.event === 'queue') {
            this.handlers.onQueue(evt.data.queued)
          } else if (evt.event === 'compaction') {
            const compacting = evt.data.phase === 'start'
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, compacting })))
          } else if (evt.event === 'reasoning') {
            const delta = evt.data.delta
            // A real reasoning token = prefill is over; clear the bar (the backend also stops firing
            // prefill frames at the first token, so this is belt-and-suspenders).
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, reasoning: b.reasoning + delta, prefill: null })))
          } else if (evt.event === 'prefill') {
            const prefill = evt.data
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, prefill })))
          } else if (evt.event === 'delta') {
            const delta = evt.data.delta
            // First real content token = prefill is over; clear the bar as generation takes over.
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, content: b.content + delta, timeline: appendTextDelta(b.timeline, delta), prefill: null })))
          } else if (evt.event === 'tool_call') {
            const tc = evt.data
            const call: LiveToolCall = { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result, diff: tc.diff, patch: tc.patch, firstChangedLine: tc.firstChangedLine }
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, timeline: upsertToolCall(b.timeline, call) })))
          } else if (evt.event === 'tool_progress') {
            const { id, partial } = evt.data
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, timeline: applyToolProgress(b.timeline, id, partial) })))
          } else if (evt.event === 'turn') {
            // A round boundary — insert a divider before every round AFTER the first (the first
            // round opens the turn and needs no leading separator). `end` frames carry no visual.
            if (evt.data.phase === 'start' && evt.data.index > 0) {
              const index = evt.data.index
              this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, timeline: appendTurnMarker(b.timeline, index) })))
            }
          } else if (evt.event === 'retry') {
            const retry: RetryState | null = evt.data.phase === 'start'
              ? { attempt: evt.data.attempt, maxAttempts: evt.data.maxAttempts, message: evt.data.message }
              : null
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, retry })))
          } else if (evt.event === 'todos') {
            // Full replace, not a merge — matches the backend's own "latest snapshot wins" shape
            // (same as tool_progress's cumulative partial, just for the whole list at once).
            const todos = evt.data.todos
            this.emitLive(reduceLive(this.live, this.activeAssistantId, (b) => ({ ...b, todos })))
          } else if (evt.event === 'done') {
            this.emitLive(null)
            this.handlers.onTurnDone()
          } else if (evt.event === 'error') {
            this.emitLive(null)
            this.handlers.onTurnError(evt.data.message)
          }
        }
        // Generator completed = the daemon says this session is idle. Stop and reconcile with DB.
        this.active = false
        this.emitLive(null)
        this.handlers.onIdle()
      } catch (e) {
        if (ac.signal.aborted) { this.active = false; return }
        // Network drop mid-run — the DAEMON kept executing. Reconnect from the last seq seen so
        // we replay only what we missed and continue live.
        attempt += 1
        if (attempt <= CodeSessionClient.RECONNECT_MAX && this.ac === ac) {
          setTimeout(() => { if (this.ac === ac && !ac.signal.aborted) void run() }, Math.min(500 * attempt, 3000))
        } else {
          this.active = false
          this.emitLive(null)
          this.handlers.onLostConnection(e instanceof ApiError && e.status === 404)
        }
      }
    }
    void run()
  }

  /** Detach this client from the run — aborts the in-flight stream WITHOUT stopping the
   *  daemon-owned run. Call on unmount / before discarding the client. */
  abort(): void {
    this.ac?.abort()
    this.active = false
  }
}
