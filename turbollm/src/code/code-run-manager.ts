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
import { runCodeSession, type SteerHandle, type TodoItem } from './code-session'
import type { CodeMode } from './persona'
import type { ReasoningEffort } from '../chat/reasoning-effort'
// Re-exported from run-buffer.ts (moved out — see that file's header for why: these have
// zero real dependency on code-session.ts, but living in THIS file meant importing them
// alone dragged in code-session.ts's pi-coding-agent chain anyway). Re-exporting keeps
// every existing `from './code-run-manager'` import (this file's own use below, plus
// code-run-manager.test.ts / code-run-manager.reconnect.test.ts) working unchanged.
import { RingBuffer, subscribeToBuffer, type BufferedEvent, type Subscription } from './run-buffer'
export { RingBuffer, subscribeToBuffer, type BufferedEvent, type Subscription }

/** How a new message submitted while a run is active should be delivered (Phase 1, ADR-246):
 *  `'steer'` interrupts and redirects the CURRENTLY ACTIVE turn (pi's session.steer), `'followUp'`
 *  waits its turn in the server-side queue and runs as a fresh turn after (today's behavior, and
 *  the default when a caller omits it — the not-yet-updated frontend). */
export type SteerKind = 'steer' | 'followUp'

/** The one function the manager drives per turn. Defaults to the real pi-SDK `runCodeSession`;
 *  injectable so the daemon-ownership + reconnect mechanism can be exercised deterministically
 *  in tests without a loaded model (the pi/model path itself is unchanged by Task 5 and is
 *  covered separately — this seam only substitutes WHO the manager calls, not the wiring). */
export type CodeSessionRunner = typeof runCodeSession

/** How many recent events to retain per session for replay-on-reconnect. A long turn emits
 *  many text deltas; if the buffer overflows, a reconnecting client misses the earliest
 *  live deltas of the in-flight turn — but the final assistant text is DB-persisted on
 *  completion, so overflow only ever costs mid-stream cosmetic replay, never the result. */
/** Grace window (ms) to retain a session's buffer after it goes fully idle, so a client that
 *  reconnects a moment after the last turn finished still gets a clean terminal handshake
 *  before falling back to the DB-persisted transcript. */
const IDLE_RETAIN_MS = 30_000

interface PendingTurn {
  task: string
  userMsgId: string
  /** -1 = unlimited (default), 0 = off, N>0 = a real token cap — see RunCodeParams.thinkingBudget. */
  thinkingBudget: number
  /** See RunCodeParams.reasoningEffort. Undefined = don't send the field. */
  reasoningEffort: ReasoningEffort | undefined
  /** What the caller requested for this message — recorded even for a queued entry so the UI can
   *  distinguish a steer that fell back to the queue from a plain follow-up (see SteerKind). */
  kind: SteerKind
  /** Turbo Link (ADR-376): the qualified `<machine>/<model>` id this turn should generate on,
   *  or undefined for this machine's loaded model. Captured PER TURN (not per session) for the
   *  same reason chat sends it per message: the picker can move between turns, and a queued
   *  turn must run on the machine it was submitted for. */
  model?: string
}

interface ActiveTurn {
  ac: AbortController
  assistantMsgId: string
  userMsgId: string
  /** The live turn's steer handle, set by runCodeSession's onSteerable once its pi session is
   *  streaming and cleared (null) when it settles. Lets steer() inject into THIS turn instead of
   *  queueing a fresh one. null while the session is still starting up or already finishing. */
  steer: SteerHandle | null
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
  /** The latest todo/step checklist the active turn emitted via update_todos (ADR-255), held so a
   *  (re)connecting client gets the current list up front (like the queue), not only if it happened
   *  to be watching when the frame streamed. Reset to [] at the start of each turn — a checklist is
   *  the CURRENT turn's plan, never carried over from a prior one. */
  todos: TodoItem[]
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

  /** The turns currently WAITING behind the active turn (not the running one) — the server-side
   *  message queue, surfaced to the UI so its "Queued" chips survive a disconnect. `userMsgId`
   *  (not just index) identifies each entry so a per-chip action (sendNow) can target one
   *  specific queued turn even if two queued tasks have identical text. */
  queued(sessionId: string): { userMsgId: string; task: string; kind: SteerKind }[] {
    return this.sessions.get(sessionId)?.queue.map((t) => ({ userMsgId: t.userMsgId, task: t.task, kind: t.kind })) ?? []
  }

  /** The active turn's current todo/step checklist (ADR-255), for a (re)connecting client to show
   *  up front. Empty when no turn has emitted one this turn (or the session is unknown). */
  todos(sessionId: string): TodoItem[] {
    return this.sessions.get(sessionId)?.todos ?? []
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
      s = { convId, repoRoot, buffer: new RingBuffer(), emitter, queue: [], active: null, replayFloor: 0, todos: [] }
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
  enqueue(sessionId: string, params: { convId: string; repoRoot: string; task: string; userMsgId: string; thinkingBudget?: number; reasoningEffort?: ReasoningEffort; kind?: SteerKind; model?: string }): { queued: boolean } {
    const s = this.ensure(sessionId, params.convId, params.repoRoot)
    const willQueue = s.active !== null
    s.queue.push({ task: params.task, userMsgId: params.userMsgId, thinkingBudget: params.thinkingBudget ?? -1, reasoningEffort: params.reasoningEffort, kind: params.kind ?? 'followUp', model: params.model })
    this.emitQueue(sessionId)
    void this.pump(sessionId)
    return { queued: willQueue }
  }

  /**
   * Steer a message into the CURRENTLY ACTIVE turn (pi's session.steer, reached via the handle
   * runCodeSession registers) so it redirects the running turn instead of queueing a fresh one
   * behind it.
   *
   * Falls back to enqueue() (follow-up/queue) rather than erroring when there is nothing live to
   * steer — either no active turn at all, or the active turn stopped streaming in the moment
   * before we reached it (a race: the turn just finished). In the fallback the message is never
   * dropped; it simply runs as the next turn instead, and its queue entry keeps kind:'steer' so
   * the UI can still tell it apart from a plain follow-up.
   *
   * Returns `steered` (delivered into the live turn) and, when it wasn't, `queued` (whether the
   * fallback had to wait behind an active turn, mirroring enqueue's own return).
   */
  async steer(
    sessionId: string,
    params: { convId: string; repoRoot: string; task: string; userMsgId: string; thinkingBudget?: number; reasoningEffort?: ReasoningEffort; model?: string },
  ): Promise<{ steered: boolean; queued: boolean }> {
    const active = this.sessions.get(sessionId)?.active
    if (active?.steer) {
      try {
        if (await active.steer(params.task)) return { steered: true, queued: false }
      } catch {
        // A steer that can't be delivered live still runs — fall through to the queue below.
      }
    }
    const { queued } = this.enqueue(sessionId, { ...params, kind: 'steer' })
    return { steered: false, queued }
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
    const ev = s.buffer.push('queue', { queued: this.queued(sessionId) })
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
    s.active = { ac, assistantMsgId: assistantMsg.id, userMsgId: turn.userMsgId, steer: null }

    // Only this turn (from its meta onward) is replayable to a fresh reconnect — earlier turns
    // are already DB-persisted messages.
    s.replayFloor = s.buffer.head()
    // A checklist belongs to the CURRENT turn — clear any list a prior turn left behind so a
    // reconnect to this fresh turn (before the model emits its own todos) shows nothing stale.
    s.todos = []

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
      else if (ev.event === 'todos') {
        // Hold the latest checklist in live state so a (re)connecting client gets it up front (the
        // stream handler snapshots runs.todos on connect) — the frame is already normalized by the
        // update_todos tool. Ephemeral: never DB-persisted, just carried for reconnect like queue.
        const ss = this.sessions.get(sessionId)
        if (ss) ss.todos = Array.isArray(data.todos) ? (data.todos as TodoItem[]) : []
      }
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
      // What this turn's stats are LABELLED with. For a Turbo Link turn the local engine did not
      // run the tokens, so the local loaded model (often none at all) is the wrong answer — the
      // qualified id the turn was submitted for is the honest one.
      const statsModelKey = turn.model ?? this.d.manager.status().model?.key
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
        reasoningEffort: turn.reasoningEffort,
        task: turn.task,
        model: turn.model,
        signal: ac.signal,
        sink,
        // Publish/withdraw the live turn's steer handle so steer() can inject into THIS turn.
        // Reads s.active fresh each call (rather than closing over the ActiveTurn captured above)
        // so a null clear can't accidentally resurrect a handle onto a since-replaced turn.
        onSteerable: (steer) => {
          const cur = this.sessions.get(sessionId)?.active
          if (cur && cur.ac === ac) cur.steer = steer
        },
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
        stats: {
          ctxUsed: ctxStats.ctxUsed, ctxMax: ctxStats.ctxMax, model: statsModelKey, aborted: result.aborted,
          // Real per-turn token/timing stats (foldTurnUsage, code-session.ts) — omitted by
          // runCodeSession (not zeroed) when the engine returned no usable usage at all.
          promptTokens: result.promptTokens, genTokens: result.genTokens, cachedTokens: result.cachedTokens,
          promptMs: result.promptMs, genMs: result.genMs, promptTps: result.promptTps, tps: result.tps,
          ttftMs: result.ttftMs, totalMs: result.totalMs,
        },
      })
      if (result.finalText.trim()) this.d.db.upsertRunDoc(sessionId, result.finalText.trim())
      this.d.db.updateAgentRun(sessionId, { status: result.aborted ? 'interrupted' : 'done', endedAt: new Date().toISOString() })
      push('done', { contextUsed: ctxStats.ctxUsed, contextMax: ctxStats.ctxMax, aborted: result.aborted })
      // Code sessions never go through the chat message endpoint, so nothing else fires
      // auto-title for them — best-effort, no-ops once the title's been set once (see
      // autoTitleFromConversation's own guard). It writes conversations.title, but the
      // sidebar/session list reads agent_runs.title (set to the raw task text at session
      // creation) — mirror the generated title onto the session record too, or the sidebar
      // never sees it. Gated on titleAutoSynced (founder-reported gap, 2026-07-14): this used
      // to re-mirror unconditionally on EVERY successful turn, silently reverting a manual
      // rename on the very next completed turn — the auto-generated name is a first-run
      // convenience and should only ever assert itself once, never again after.
      if (!result.aborted && !this.d.db.getAgentRun(sessionId)?.titleAutoSynced) {
        void autoTitleFromConversation(this.d, s.convId).then(() => {
          if (this.d.db.getAgentRun(sessionId)?.titleAutoSynced) return
          const title = this.d.db.getConversation(s.convId)?.title
          if (title && title !== 'New chat') this.d.db.updateAgentRun(sessionId, { title, titleAutoSynced: true })
        })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A queued turn's gate wait rejects with a plain Error (name 'Error', not 'AbortError') on
      // both user-stop and gate timeout — see gate.ts's giveUp(new Error('gate_acquire_aborted'/
      // 'gate_acquire_timeout')). Treat those the same as a real AbortError so a Stop hit while
      // still queued behind another generation records a clean interrupt, not a cryptic "failed".
      const isAbort = (e as Error)?.name === 'AbortError' || message === 'gate_acquire_aborted' || message === 'gate_acquire_timeout'
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

  /** Atomically stop the currently active turn AND promote a specific queued turn to run next —
   *  the "Send now" action on a queued chip. Unlike stop(), this does NOT drop the rest of the
   *  queue: only the target turn is moved to the front, the remaining queued turns still run
   *  afterward in their original relative order. A naive "stop() then re-enqueue" would race the
   *  abort against pump()'s own re-entrant call and, with 2+ queued turns, could let whichever
   *  was already first run instead of the one the user actually clicked. Returns false if
   *  userMsgId isn't currently in the queue (already running, already finished, unknown session)
   *  — the caller should treat that as a harmless no-op, not an error. */
  sendNow(sessionId: string, userMsgId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    const idx = s.queue.findIndex((t) => t.userMsgId === userMsgId)
    if (idx === -1) return false
    const [turn] = s.queue.splice(idx, 1)
    s.queue.unshift(turn)
    this.emitQueue(sessionId)
    s.active?.ac.abort()
    return true
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
