// CodeRunManager — daemon-owned lifecycle for Code-session runs (Task 5: background /
// reconnectable runs).
//
// The problem this solves: originally POST /code/sessions/:id/messages ran the pi loop
// *inside* the HTTP request's streamSSE callback, with the AbortController wired to
// stream.onAbort. Closing the tab / navigating away / a dropped connection therefore
// ABORTED the run — there was no way to reconnect to an in-flight run, and follow-up
// messages were queued only in browser memory (lost on disconnect).
//
// The fix (mechanism recovered from the retired agents/run-manager.ts — the RunBuffer ring
// + EventEmitter live-tail + async-iterator subscribe(fromSeq) + reconcileOnStartup pattern,
// re-pointed at runCodeSession instead of the old pi-adapter):
//
//   • The DAEMON owns each run via an AbortController it holds — NOT the HTTP request. A
//     disconnect only closes a subscriber; the run keeps executing server-side.
//   • A per-session ring buffer of seq-numbered events. A client that connects (or reconnects)
//     replays buffer.since(fromSeq) then live-tails new events — this is what makes an SSE
//     reconnect actually resume instead of losing everything emitted before it.
//   • One active turn per session at a time; additional turns (follow-ups) QUEUE server-side,
//     so a queued message survives a disconnect and still fires when its turn comes.
//
// The session's agent_run id IS the session id. Each POST is one "turn" against that session;
// all of a session's live turns share one continuous seq space in one ring buffer. A
// reconnecting client only ever replays the CURRENTLY in-flight turn (see `replayFloor`),
// because completed turns are already persisted as DB messages (getCodeSession returns them).
import { EventEmitter } from 'node:events'
import type { Deps } from '../deps'
import type { ToolCallRecord, MessageTimelineBlock } from '../chat/db'
import { autoTitleFromConversation } from '../chat/chat-routes'
import { runCodeSession } from './code-session'
import type { CodeMode } from './persona'

/** The one function the manager drives per turn. Defaults to the real pi-SDK `runCodeSession`;
 *  injectable so the daemon-ownership + reconnect mechanism can be exercised deterministically
 *  in tests without a loaded model (the pi/model path itself is unchanged by Task 5 and is
 *  covered separately — this seam only substitutes WHO the manager calls, not the wiring). */
export type CodeSessionRunner = typeof runCodeSession

/** How many recent events to retain per session for replay-on-reconnect. A long turn emits
 *  many text deltas; if the buffer overflows, a reconnecting client misses the earliest
 *  live deltas of the in-flight turn — but the final assistant text is DB-persisted on
 *  completion, so overflow only ever costs mid-stream cosmetic replay, never the result. */
const BUFFER_CAP = 6000

/** Grace window (ms) to retain a session's buffer after it goes fully idle, so a client that
 *  reconnects a moment after the last turn finished still gets a clean terminal handshake
 *  before falling back to the DB-persisted transcript. */
const IDLE_RETAIN_MS = 30_000

export interface BufferedEvent {
  seq: number
  event: string
  data: unknown
}

/** A bounded, seq-numbered append log. `since(fromSeq)` is the replay primitive. */
export class RingBuffer {
  private events: BufferedEvent[] = []
  private nextSeq = 0

  push(event: string, data: unknown): BufferedEvent {
    const ev: BufferedEvent = { seq: this.nextSeq++, event, data }
    this.events.push(ev)
    if (this.events.length > BUFFER_CAP) this.events.shift()
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

interface PendingTurn {
  task: string
  userMsgId: string
  /** -1 = unlimited (default), 0 = off, N>0 = a real token cap — see RunCodeParams.thinkingBudget. */
  thinkingBudget: number
}

interface ActiveTurn {
  ac: AbortController
  assistantMsgId: string
  userMsgId: string
}

interface SessionState {
  convId: string
  repoRoot: string
  buffer: RingBuffer
  emitter: EventEmitter
  queue: PendingTurn[]
  active: ActiveTurn | null
  /** Initial replay for a fresh subscriber starts at max(fromSeq, replayFloor). Set to the
   *  in-flight turn's `meta` seq while a turn runs (so only that turn is replayed, never an
   *  already-persisted earlier turn); bumped to buffer.head() when the session goes idle (so
   *  a fresh reconnect replays nothing and hands straight off to the DB transcript). */
  replayFloor: number
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export class CodeRunManager {
  private d: Deps
  private runner: CodeSessionRunner
  private sessions = new Map<string, SessionState>()

  constructor(d: Deps, opts?: { runner?: CodeSessionRunner }) {
    this.d = d
    this.runner = opts?.runner ?? runCodeSession
  }

  /** On daemon startup, any code run left 'running'/'queued' in the DB belongs to a previous
   *  process that is gone — its in-memory buffer/AbortController died with it. Mark those
   *  interrupted so the UI shows an honest terminal state instead of a run that never resumes. */
  reconcileOnStartup(): void {
    const orphans = this.d.db.listAgentRuns({ statuses: ['running', 'queued'] })
    for (const run of orphans) {
      if (this.d.db.getConversation(run.convId)?.kind !== 'code') continue
      this.d.db.updateAgentRun(run.id, { status: 'interrupted', endedAt: new Date().toISOString() })
    }
  }

  /** Is there a live turn (running or queued) for this session? Drives the reconnect decision. */
  isActive(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && (s.active !== null || s.queue.length > 0)
  }

  /** The tasks currently WAITING behind the active turn (not the running one) — the server-side
   *  message queue, surfaced to the UI so its "Queued" chips survive a disconnect. */
  queued(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.queue.map((t) => t.task) ?? []
  }

  /** The in-flight turn's message ids, so a reconnecting stream can synthesize a `meta` frame
   *  even if the real one has already aged out of the ring buffer. */
  activeMeta(sessionId: string): { userMessageId: string; assistantMessageId: string } | null {
    const a = this.sessions.get(sessionId)?.active
    return a ? { userMessageId: a.userMsgId, assistantMessageId: a.assistantMsgId } : null
  }

  private ensure(sessionId: string, convId: string, repoRoot: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (!s) {
      const emitter = new EventEmitter()
      emitter.setMaxListeners(0) // unbounded: many tabs may watch one session
      s = { convId, repoRoot, buffer: new RingBuffer(), emitter, queue: [], active: null, replayFloor: 0 }
      this.sessions.set(sessionId, s)
    }
    if (s.cleanupTimer) { clearTimeout(s.cleanupTimer); s.cleanupTimer = undefined }
    return s
  }

  /**
   * Enqueue a turn. Starts it immediately if the session is idle; otherwise it waits behind the
   * active turn (server-side queue). Returns synchronously — the run is owned by the daemon, so
   * the caller can respond and disconnect without touching the run.
   *
   * `queued` is true when the turn had to wait (a run was already active), false when it started.
   */
  enqueue(sessionId: string, params: { convId: string; repoRoot: string; task: string; userMsgId: string; thinkingBudget?: number }): { queued: boolean } {
    const s = this.ensure(sessionId, params.convId, params.repoRoot)
    const willQueue = s.active !== null
    s.queue.push({ task: params.task, userMsgId: params.userMsgId, thinkingBudget: params.thinkingBudget ?? -1 })
    this.emitQueue(sessionId)
    void this.pump(sessionId)
    return { queued: willQueue }
  }

  /** The most recent real ctxUsed/ctxMax on record for this conversation (the last assistant
   *  turn that actually completed and got a genuine stats.ctxUsed from runCodeSession), or
   *  undefined if none exists yet. Used when a turn ABORTS before runCodeSession returns a
   *  result — see the catch block in pump() for why this matters. */
  private lastKnownContextStats(convId: string): { ctxUsed: number; ctxMax: number } | undefined {
    const messages = this.d.db.getConversation(convId, true)?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const stats = messages[i].stats
      if (typeof stats?.ctxUsed === 'number' && stats.ctxUsed > 0) {
        return { ctxUsed: stats.ctxUsed, ctxMax: stats.ctxMax ?? 0 }
      }
    }
    return undefined
  }

  /** Context usage can only GROW within an ongoing session — a follow-up turn only ever adds
   *  tokens, never removes them. Found live (2026-07-13): on an aborted turn, runCodeSession's
   *  own contextUsed can legitimately compute a much SMALLER number than reality (pi's own
   *  context estimator falls back to counting whatever partial/interrupted session state it
   *  has, which an early abort can catch mid-assembly) — e.g. 1045 tokens reported immediately
   *  after a prior turn had already confirmed 4932. A UI reading that as "context dropped" is
   *  exactly the founder-reported "ctx size changed from 50% to 0%" symptom. Since usage cannot
   *  really shrink, floor an aborted turn's reported value at the last confirmed one. */
  private reliableContextStats(convId: string, reported: { ctxUsed: number; ctxMax: number }, aborted: boolean): { ctxUsed: number; ctxMax: number } {
    if (!aborted) return reported
    const last = this.lastKnownContextStats(convId)
    if (!last || reported.ctxUsed >= last.ctxUsed) return reported
    return last
  }

  /** Emit the current queue state so live subscribers can update their "Queued" chips. */
  private emitQueue(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const ev = s.buffer.push('queue', { queued: s.queue.map((t) => t.task) })
    s.emitter.emit('event', ev)
  }

  /** Start the next queued turn if the session is idle. Re-entrant: each turn's finally calls it. */
  private async pump(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s || s.active || s.queue.length === 0) return

    const turn = s.queue.shift()!
    this.emitQueue(sessionId)

    // The assistant placeholder is created when the turn actually STARTS (not when queued), so
    // DB message order is user, then its reply — and so getCodeSession during the run shows an
    // empty placeholder whose id the live block dedups against (CodeTranscript liveAssistantId).
    const assistantMsg = this.d.db.addMessage(s.convId, 'assistant', '', { stats: { aborted: false } })
    const ac = new AbortController()
    s.active = { ac, assistantMsgId: assistantMsg.id, userMsgId: turn.userMsgId }

    // Only this turn (from its meta onward) is replayable to a fresh reconnect — earlier turns
    // are already DB-persisted messages.
    s.replayFloor = s.buffer.head()

    const push = (event: string, data: unknown) => {
      const ss = this.sessions.get(sessionId)
      if (!ss) return
      const ev = ss.buffer.push(event, data)
      ss.emitter.emit('event', ev)
    }

    push('meta', { userMessageId: turn.userMsgId, assistantMessageId: assistantMsg.id })
    this.d.db.updateAgentRun(sessionId, { status: 'running', startedAt: new Date().toISOString() })

    // Accumulate for persistence exactly as the old inline POST handler did.
    let content = ''
    let reasoning = ''
    const toolCalls: ToolCallRecord[] = []
    // Item 6: the SAME ordered interleave the live SSE view reconstructs client-side
    // (web/src/lib/live-timeline.ts's appendTextDelta/upsertToolCall), built once here instead of
    // reconstructed after the fact — `content`/`toolCalls` above accumulate text and tool calls
    // SEPARATELY and lose the true order between them, which was the whole bug. `reasoning`
    // deliberately does NOT participate (mirrors the live view: reasoning renders as its own
    // leading block, never interleaved with text/tool blocks).
    const timeline: MessageTimelineBlock[] = []
    const sink = (ev: { event: string; data: unknown }) => {
      const data = ev.data as Record<string, unknown>
      if (ev.event === 'delta') {
        const delta = String(data.delta ?? '')
        content += delta
        const last = timeline[timeline.length - 1]
        if (last && last.type === 'text') last.text += delta
        else timeline.push({ type: 'text', text: delta })
      }
      else if (ev.event === 'reasoning') reasoning += String(data.delta ?? '')
      else if (ev.event === 'tool_call' && (data.status === 'done' || data.status === 'error')) {
        const id = String(data.id ?? '')
        toolCalls.push({
          id,
          name: String(data.name ?? ''),
          args: (data.args as Record<string, unknown>) ?? {},
          result: data.status === 'done' ? (data.result as string | undefined) : undefined,
          error: data.status === 'error' ? (data.result as string | undefined) : undefined,
          // Edit tool only — carried through from code-session.ts's isEditToolResult handling.
          // Previously dropped here, so the diff panel went blank for any completed tool call
          // after a page reload, and revert-to-message had nothing to reverse-apply.
          diff: data.diff as string | undefined,
          patch: data.patch as string | undefined,
          firstChangedLine: data.firstChangedLine as number | undefined,
        })
        timeline.push({ type: 'tool', id })
      }
      push(ev.event, ev.data)
    }

    try {
      const ms = this.d.manager.status()
      const model = ms.model
      // START mode is read fresh from the conversation (runCodeSession re-reads it per tool call
      // for the live ask-gate switch); a run that starts with no model loaded fails cleanly below.
      const mode = (this.d.db.getConversation(s.convId)?.agentMode ?? 'auto') as CodeMode

      const result = await this.runner({
        d: this.d,
        convId: s.convId,
        sessionId,
        repoRoot: s.repoRoot,
        mode,
        thinkingBudget: turn.thinkingBudget,
        task: turn.task,
        signal: ac.signal,
        sink,
      })

      const finalContent = content.trim() || result.finalText
      // Rare fallback: pi's own getLastAssistantText() produced text the delta stream never
      // carried (result.finalText used instead of the empty accumulated `content`). Mirror it
      // into the timeline too so a completed message's timeline text always matches its content
      // — otherwise the interleaved render would silently drop this reply's only content.
      if (!content.trim() && result.finalText.trim()) timeline.push({ type: 'text', text: result.finalText })
      const ctxStats = this.reliableContextStats(s.convId, { ctxUsed: result.contextUsed, ctxMax: result.contextMax }, result.aborted)
      this.d.db.updateMessage(assistantMsg.id, {
        content: finalContent,
        reasoning,
        toolCalls,
        timeline,
        stats: { ctxUsed: ctxStats.ctxUsed, ctxMax: ctxStats.ctxMax, model: model?.key, aborted: result.aborted },
      })
      if (result.finalText.trim()) this.d.db.upsertRunDoc(sessionId, result.finalText.trim())
      this.d.db.updateAgentRun(sessionId, { status: result.aborted ? 'interrupted' : 'done', endedAt: new Date().toISOString() })
      push('done', { contextUsed: ctxStats.ctxUsed, contextMax: ctxStats.ctxMax, aborted: result.aborted })
      // Code sessions never go through the chat message endpoint, so nothing else fires
      // auto-title for them — best-effort, no-ops once the title's been set once (see
      // autoTitleFromConversation's own guard). It writes conversations.title, but the
      // sidebar/session list reads agent_runs.title (set to the raw task text at session
      // creation) — mirror the generated title onto the session record too, or the sidebar
      // never sees it.
      if (!result.aborted) {
        void autoTitleFromConversation(this.d, s.convId).then(() => {
          const title = this.d.db.getConversation(s.convId)?.title
          if (title && title !== 'New chat') this.d.db.updateAgentRun(sessionId, { title })
        })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const isAbort = (e as Error)?.name === 'AbortError'
      // An abort here means runCodeSession THREW before returning any contextUsed/contextMax at
      // all — but the conversation's real context did NOT shrink (a stop/timeout doesn't erase
      // prior turns). Found live (2026-07-13): this used to hardcode contextUsed/contextMax to 0
      // on every abort, which reads exactly like "context lost" in the UI's usage ring even
      // though nothing was actually lost — reuse the last turn's real stats instead (same
      // "usage cannot shrink" floor as the success path below, just with a reported 0 as input).
      const carried = isAbort ? this.reliableContextStats(s.convId, { ctxUsed: 0, ctxMax: 0 }, true) : undefined
      if (content.trim() || reasoning.trim() || toolCalls.length) {
        this.d.db.updateMessage(assistantMsg.id, { content: content.trim(), reasoning, toolCalls, timeline, stats: { aborted: isAbort, ...carried } })
      } else {
        this.d.db.updateMessage(assistantMsg.id, { stats: { aborted: isAbort, ...carried } })
      }
      this.d.db.updateAgentRun(sessionId, {
        status: isAbort ? 'interrupted' : 'failed',
        error: isAbort ? undefined : message,
        endedAt: new Date().toISOString(),
      })
      // A terminal frame either way, so a live subscriber's loop always ends.
      if (isAbort) push('done', { contextUsed: carried?.ctxUsed ?? 0, contextMax: carried?.ctxMax ?? 0, aborted: true })
      else push('error', { code: 'run_error', message })
    } finally {
      const ss = this.sessions.get(sessionId)
      if (ss) {
        ss.active = null
        if (ss.queue.length > 0) {
          // More turns waiting — keep the session live and start the next one.
          void this.pump(sessionId)
        } else {
          // Fully idle: a fresh reconnect should replay nothing and hand off to the DB
          // transcript; live subscribers get an 'idle' signal to end their loops.
          ss.replayFloor = ss.buffer.head()
          ss.emitter.emit('idle')
          ss.cleanupTimer = setTimeout(() => { this.sessions.delete(sessionId) }, IDLE_RETAIN_MS)
        }
      }
    }
  }

  /**
   * Stop a session's active run and drop everything queued behind it. The active turn's
   * AbortController fires (runCodeSession aborts pi); the turn's finally records 'interrupted'.
   * Returns true if there was anything to stop.
   */
  stop(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    const had = s.active !== null || s.queue.length > 0
    if (s.queue.length > 0) { s.queue = []; this.emitQueue(sessionId) }
    s.active?.ac.abort()
    return had
  }

  /**
   * Subscribe to a session's event stream from `fromSeq`. Drains the replay backlog
   * (buffer.since(max(fromSeq, replayFloor))) first, then live-tails, then terminates when the
   * session goes idle. If the session is unknown (never started, or already cleaned up), returns
   * an immediately-exhausted subscription — the caller then just shows the DB transcript.
   */
  subscribe(sessionId: string, fromSeq: number): Subscription {
    const s = this.sessions.get(sessionId)
    if (!s) return subscribeToBuffer(new RingBuffer(), new EventEmitter(), { fromSeq: 0, replayFloor: 0, idleAtStart: true })
    return subscribeToBuffer(s.buffer, s.emitter, {
      fromSeq,
      replayFloor: s.replayFloor,
      idleAtStart: s.active === null && s.queue.length === 0,
    })
  }
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
