// The chat screen's stream / reattach / stop orchestration, out of React (the Code UI's
// precedent: ADR-260). A plain class so it is unit-testable without jsdom; `useChatSession`
// (use-chat-session.ts) subscribes React to it and ChatScreen keeps layout and wiring.
import type { QueryClient } from '@tanstack/react-query'
import { toast } from '../components/ui/sonner'
import type { ReasoningEffort } from '../components/ReasoningEffortSelect'
import { ApiError } from './api'
import { continueConversation, followChatTurn, sendMessage } from './chat-api'
import { chatKeys } from './chat-queries'
import type { ChatFrame, Conversation, LiveToolCall } from './chat-types'
import { appendTextDelta, upsertToolCall, type LiveBlock } from './live-timeline'

// Streaming state
export interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number  // rolling 2s window estimate during generation phase
  genTokens: number   // running count of generated tokens (content + reasoning) for this reply
  timeline: LiveBlock[]
  /** True while an auto-compact call (ADR-420) is in flight for this conversation's
   *  current turn — drives the composer placeholder swap below. */
  compacting: boolean
}

export interface ChatSessionSnapshot {
  /** Keyed by convId, not a single global value — a generation keeps running server-side
   *  after the user navigates away (b6d84f3), so its live state must survive navigation
   *  too, and multiple conversations can legitimately be generating at once. */
  liveByConv: Record<string, LiveState>
  /** Conversations whose generation finished while the user was elsewhere. Cleared when
   *  the user navigates to that conversation. Session-only by design (not persisted). */
  recentlyCompletedIds: Set<string>
}

export interface ChatSessionDeps {
  qc: QueryClient
  /** The CURRENT open chat: streams outlive the render that started them, so they cannot close over it. */
  getActiveId: () => string | null
  /** A reply of the open chat finished: the screen may nudge its scroller (never past the user's place). */
  onActiveReplyDone: () => void
}

/** What every turn starter sends along: the composer's current thinking choices and routing. */
export interface TurnSettings {
  thinkingBudget: number
  reasoningEffort: ReasoningEffort | undefined
  /** Turbo Link: set only for a model on another machine. */
  remoteModel: string | undefined
}

export interface TurnResult {
  /** A `meta` frame arrived: the daemon stored the user message. */
  started: boolean
  /** The user (or Eject) stopped it, rather than the daemon refusing it. */
  aborted: boolean
  /** Why it failed before it started, when it did. */
  refusal?: unknown
}

export interface SentMessage {
  text: string
  images: string[]
  docContext: string
  textAttachmentNames: string[]
}

type FollowHooks = { start?: () => void; refused?: (e: unknown) => void; quiet?: boolean; gaveUp?: () => void }

const EMPTY_IDS = new Set<string>()

export class ChatSession {
  private state: ChatSessionSnapshot = { liveByConv: {}, recentlyCompletedIds: EMPTY_IDS }
  private listeners = new Set<() => void>()
  // Each is the stream this page follows a chat's reply with: aborting it only stops following
  // (the daemon runs the reply; Stop, Eject and deleting the chat stop it there).
  private abortRefs: Record<string, AbortController> = {}
  // The turns whose POST the daemon has not answered yet, by their controller (followChatTurn's
  // onAccepted, through `accepting`, takes each out): until then the message may exist nowhere.
  // Leaving the chat screen lets such a send go on rather than cancel it, and lets go of its reply
  // once the daemon has it (`unmounted`). Cancelled, the message was lost: a large image going
  // up over a slow tunnel, say, with no composer left to put the text back in.
  private posting = new Set<AbortController>()
  private unmounted = false
  // The replies this page saw end (their done or error, or its own Stop): a conversation read
  // before the end still names one as running, and the attach must not follow it again.
  private finishedReplies = new Set<string>()
  // The daemon's notes this page has shown, by chat: a note about the loaded model (it cannot call tools, a
  // LiteRT-LM model chooses its own searches) is sent with every turn it applies to, and shown once per chat.
  private shownNotices = new Set<string>()
  // When an attach to a chat's running reply last gave up (its resumes ran out), by chat: it is
  // tried again only once the conversation has been read again after that, so a daemon that
  // cannot be reached is not asked again on every render. An attach says nothing when it fails
  // (the poll tries again): a toast per poll would bury the chat.
  private attachGaveUp: Record<string, number> = {}
  private deltaTimestamps: Record<string, number[]> = {}

  constructor(private deps: ChatSessionDeps) {}

  // ── store ───────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ChatSessionSnapshot => this.state

  private setLiveByConv(next: Record<string, LiveState>) {
    this.state = { ...this.state, liveByConv: next }
    for (const l of this.listeners) l()
  }

  private setRecentlyCompleted(next: Set<string>) {
    this.state = { ...this.state, recentlyCompletedIds: next }
    for (const l of this.listeners) l()
  }

  /** Applies `updater` to convId's live entry, no-op if it's already gone (e.g. the
   *  conversation was deleted or ejected mid-stream). */
  private updateLive(convId: string, updater: (l: LiveState) => LiveState) {
    const cur = this.state.liveByConv[convId]
    if (cur) this.setLiveByConv({ ...this.state.liveByConv, [convId]: updater(cur) })
  }

  private dropLive(convId: string) {
    if (!(convId in this.state.liveByConv)) return
    const next = { ...this.state.liveByConv }
    delete next[convId]
    this.setLiveByConv(next)
  }

  /** Drops convId's live entry, only while it is reply `replyId`'s: a stream that ends after the
   *  page moved on to a newer reply of the chat (another tab's, attached meanwhile) leaves that
   *  one's text and Stop alone. */
  private clearLive(convId: string, replyId: string | undefined) {
    if (this.state.liveByConv[convId]?.assistantId !== replyId) return
    this.dropLive(convId)
  }

  private markCompleted(convId: string) {
    this.setRecentlyCompleted(new Set(this.state.recentlyCompletedIds).add(convId))
  }

  /** The user opened `id`: its "finished while you were away" mark is spent. */
  acknowledgeCompleted(id: string) {
    if (!this.state.recentlyCompletedIds.has(id)) return
    const next = new Set(this.state.recentlyCompletedIds)
    next.delete(id)
    this.setRecentlyCompleted(next)
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** Set on mount: StrictMode runs the unmount once on a screen that stays. */
  mount() {
    this.unmounted = false
  }

  /** Leaving the chat screen only stops following its replies (they run on in the daemon), and lets
   *  their connections go; coming back follows them again from the daemon's frames. Not a send the
   *  daemon has not answered yet (`posting`): it goes on, and is let go of once it is taken. */
  unmount() {
    this.unmounted = true
    for (const ac of Object.values(this.abortRefs)) if (!this.posting.has(ac)) ac.abort()
    this.abortRefs = {}
  }

  /** A turn from this view is running or starting for `convId` (what holds back a second
   *  Regenerate or Save & Resend). */
  isBusy(convId: string): boolean {
    return !!this.abortRefs[convId]
  }

  hasFinished(replyId: string): boolean {
    return this.finishedReplies.has(replyId)
  }

  /** Ejecting kills the whole engine — every in-flight generation across every
   *  conversation dies with it, not just the active one. */
  abortAll() {
    if (Object.keys(this.abortRefs).length > 0) {
      for (const ac of Object.values(this.abortRefs)) ac.abort()
      this.abortRefs = {}
    }
    if (Object.keys(this.state.liveByConv).length > 0) this.setLiveByConv({})
  }

  /** The chat was deleted (the DELETE stopped it in the daemon): stop following its live generation. */
  discard(convId: string) {
    this.abortRefs[convId]?.abort()
    delete this.abortRefs[convId]
    this.dropLive(convId)
  }

  // ── the stream ──────────────────────────────────────────────────────────────

  // Record one generated token for `convId` and return its rolling 2-second tok/s estimate.
  private pushGenToken(convId: string) {
    const now = Date.now()
    const timestamps = [...(this.deltaTimestamps[convId] ?? []), now].filter((t) => t > now - 2000)
    this.deltaTimestamps[convId] = timestamps
    return Math.round((timestamps.length / 2) * 10) / 10
  }

  /** The `onAccepted` a turn's POST runs once the daemon has answered it (followChatTurn's), for
   *  the turn `ac` follows: until then the turn is `posting`, which leaving the screen spares. A
   *  send the daemon takes after the screen has gone is let go of at once: the reply runs on in the
   *  daemon, and coming back attaches to it. */
  accepting(ac: AbortController, accepted: () => void) {
    this.posting.add(ac)
    return () => {
      this.posting.delete(ac)
      accepted()
      if (this.unmounted) ac.abort()
    }
  }

  /** Shared SSE consumer: drives live streaming state for a fresh send, a continue, or a reply
   *  this page attaches to (followChatTurn: the daemon runs the reply, and a dropped connection
   *  resumes by GET). Every live/abort access below targets `convId` — the parameter — not the
   *  open chat, because by the time an event arrives the user may have navigated to a different
   *  conversation while this generation keeps running in the background.
   *  Resolves to whether the turn STARTED (a `meta` frame arrived): the daemon sends meta only
   *  after it has stored the user message, so `false` means the message exists nowhere.
   *  `on.start` runs when the turn starts; `on.refused` when it fails before it started, with the
   *  error (not for an abort). `on.quiet` (an attach): a failure is not toasted, and `on.gaveUp`
   *  runs instead.
   *  `ac` is this request's own controller. The chat's abort entry (what Eject and delete abort,
   *  and what holds back a second Regenerate or Save & Resend) is the turn that started, so meta
   *  takes it, and only this request's own entry is removed when it ends: a send refused while a
   *  Regenerate was starting removed the Regenerate's, and Stop then left its request open. */
  async follow(convId: string, ac: AbortController, gen: AsyncGenerator<ChatFrame>, on?: FollowHooks): Promise<boolean> {
    const { qc } = this.deps
    let started = false
    /** The reply this stream follows (its meta's). */
    let own: string | undefined
    try {
      for await (const evt of gen) {
        if (evt.event === 'meta') {
          started = true
          own = evt.data.assistantMessageId
          this.abortRefs[convId] = ac
          on?.start?.()
          const replyId = own
          // A resume or an attach sends the meta again (the daemon's, then the run's frame 0):
          // the text so far is kept; a `reset` clears it when the replay starts the reply over.
          if (this.state.liveByConv[convId]?.assistantId !== replyId) {
            this.deltaTimestamps[convId] = []
            this.setLiveByConv({ ...this.state.liveByConv, [convId]: { assistantId: replyId, content: '', reasoning: '', progress: null, liveGenTps: 0, genTokens: 0, timeline: [], compacting: false } })
          }
          // Optimistically reflect the new/last user msg in the UI by invalidating
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
        } else if (evt.event === 'reset') {
          this.deltaTimestamps[convId] = []
          this.updateLive(convId, (l) => ({ ...l, content: '', reasoning: '', progress: null, liveGenTps: 0, genTokens: 0, timeline: [], compacting: false }))
        } else if (evt.event === 'compaction') {
          this.updateLive(convId, (l) => ({ ...l, compacting: evt.data.phase === 'start' }))
        } else if (evt.event === 'progress') {
          this.updateLive(convId, (l) => ({ ...l, progress: { phase: evt.data.phase, pct: evt.data.pct, tps: evt.data.tps } }))
        } else if (evt.event === 'reasoning') {
          // Thinking tokens count toward generation too — track rate + count.
          const liveTps = this.pushGenToken(convId)
          this.updateLive(convId, (l) => ({ ...l, reasoning: l.reasoning + evt.data.delta, progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 }))
        } else if (evt.event === 'delta') {
          const liveTps = this.pushGenToken(convId)
          this.updateLive(convId, (l) => ({ ...l, content: l.content + evt.data.delta, timeline: appendTextDelta(l.timeline, evt.data.delta), progress: null, liveGenTps: liveTps, genTokens: l.genTokens + 1 }))
        } else if (evt.event === 'notice') {
          const key = `${convId}\n${evt.data.message}`
          if (!this.shownNotices.has(key)) {
            this.shownNotices.add(key)
            toast(evt.data.message)
          }
        } else if (evt.event === 'tool_call') {
          const tc = evt.data
          const call: LiveToolCall = { id: tc.id, name: tc.name, args: tc.args, status: tc.status, result: tc.result }
          this.updateLive(convId, (l) => ({ ...l, timeline: upsertToolCall(l.timeline, call) }))
        } else if (evt.event === 'done') {
          if (own) this.finishedReplies.add(own)
          // Patch the reply into the cache BEFORE clearing live state (pre-release review,
          // Finding A): clearing live un-hides the placeholder synchronously, but the real row only
          // arrives via the async invalidateQueries refetch below — without this patch, the
          // now-visible placeholder would briefly render with its stale empty content (a "This
          // message is empty." flash) in that window. The daemon's `done` carries the reply as it
          // saved it, which is the whole reply even when this page attached after the start of a
          // long one fell out of what the daemon keeps; without it (the reply was deleted
          // meanwhile), the live text.
          const saved = evt.data.message ?? undefined
          const l = this.state.liveByConv[convId]
          if (l && l.assistantId === own) {
            qc.setQueryData<Conversation>(['conversation', convId], (old) =>
              old
                ? {
                    ...old,
                    runningReplyId: old.runningReplyId === own ? null : old.runningReplyId,
                    messages: (old.messages ?? []).map((m) => (m.id !== l.assistantId ? m : saved?.id === m.id ? { ...m, ...saved } : { ...m, content: l.content, reasoning: l.reasoning })),
                  }
                : old,
            )
          }
          this.clearLive(convId, own)
          const isOpenChat = convId === this.deps.getActiveId()
          if (!isOpenChat) this.markCompleted(convId)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          void qc.invalidateQueries({ queryKey: ['conversations'] })
          // Only nudge the scroller when the finished conversation is the one on
          // screen, and never force past the ≥80px pin (spec 07 §7): a user reading
          // up-thread — or a restored mid-thread offset — keeps their place, and a
          // background completion must not yank the conversation being looked at.
          if (isOpenChat) setTimeout(() => this.deps.onActiveReplyDone(), 80)
        } else if (evt.event === 'error') {
          if (own) this.finishedReplies.add(own)
          this.clearLive(convId, own)
          if (convId !== this.deps.getActiveId()) this.markCompleted(convId)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          toast.error(evt.data.message)
        }
      }
      // The stream ended without done or error: the daemon has no reply to follow (it ended, or
      // it is past what the daemon keeps); the conversation has the rest.
      if (started) this.clearLive(convId, own)
      void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } catch (e) {
      // Only a turn that started has a live entry of its own (set at its meta). One refused before
      // that (a 409 while another turn from this view runs) cleared THAT turn's: its streamed text
      // and Stop vanished while it kept running.
      if (started) this.clearLive(convId, own)
      const aborted = (e as Error)?.name === 'AbortError'
      if (!aborted) {
        if (on?.quiet) on.gaveUp?.()
        else toast.error(e instanceof ApiError ? e.message : 'Request failed.')
        if (!started) on?.refused?.(e)
      }
      // Also how a send refused because a reply already runs (409 generation_in_flight: another
      // tab's, or one this page has not attached to yet) shows that reply: the conversation read
      // again names it, and the attach follows it. Not for a stream Stop let go of
      // (stop marked its reply finished): stop reads the chat itself a moment later,
      // and a read now can land before the stopped reply is saved, putting the empty placeholder
      // back over the text it kept in the bubble.
      if (!(aborted && own && this.finishedReplies.has(own))) void qc.invalidateQueries({ queryKey: ['conversation', convId] })
    } finally {
      this.posting.delete(ac)
      if (this.abortRefs[convId] === ac) delete this.abortRefs[convId]
    }
    return started
  }

  // ── reattach ────────────────────────────────────────────────────────────────

  /** A reply runs in the daemon whatever page started it, so the open chat follows the one the
   *  daemon says holds it (`runningReplyId`, read on open and every 4 s): after a reload or a
   *  reopened app, back from another screen, on another tab or device, or once a resume gave up.
   *  Keyed on the id, not on "something runs": a reply that ends and a newer one from another
   *  device between two reads is a new reply to follow. Not while this page's own send or
   *  Regenerate is still starting (its POST holds the chat's entry and has no meta yet), nor for a
   *  reply it already follows or saw end. One that it follows but that no longer holds the chat
   *  (stopped elsewhere, still unwinding) gives way to the one that does. Only the open chat is
   *  followed: the others show their running dot from the list, which keeps a page well under a
   *  browser's 6 connections per host.
   *  `liveReplyId` is the reply this page shows live for the chat; `convReadAt` when the chat was last read. */
  attach(convId: string | null, runningReplyId: string | null, liveReplyId: string | undefined, convReadAt: number) {
    if (!convId || !runningReplyId || this.finishedReplies.has(runningReplyId)) return
    const busy = this.abortRefs[convId]
    if (busy) {
      if (!liveReplyId || liveReplyId === runningReplyId) return
      busy.abort()
      delete this.abortRefs[convId]
    }
    const gaveUpAt = this.attachGaveUp[convId]
    if (gaveUpAt !== undefined && !(convReadAt > gaveUpAt)) return
    delete this.attachGaveUp[convId]
    const ac = new AbortController()
    this.abortRefs[convId] = ac
    void this.follow(convId, ac, followChatTurn(convId, null, ac.signal), { quiet: true, gaveUp: () => { this.attachGaveUp[convId] = Date.now() } })
  }

  // ── turns ───────────────────────────────────────────────────────────────────

  /** Sends a user message to an existing chat and follows its reply. */
  async send(convId: string, message: SentMessage, settings: TurnSettings): Promise<TurnResult> {
    const ac = new AbortController()
    // The composer is held back by `live` only, which a Regenerate starting from this view has
    // not set yet: that Regenerate keeps the chat's abort entry, and the daemon refuses this
    // send (one turn per chat). Should this one start instead, its meta takes the entry.
    if (!this.abortRefs[convId]) this.abortRefs[convId] = ac
    const { text, images, docContext, textAttachmentNames } = message
    const started = await this.follow(convId, ac, followChatTurn(convId, (accepted) => sendMessage(convId, text, ac.signal, images, docContext, textAttachmentNames, settings.thinkingBudget, settings.reasoningEffort, settings.remoteModel, this.accepting(ac, accepted)), ac.signal))
    // follow toasts the error itself and never rethrows. An abort is the user (or Eject)
    // stopping it, not a refusal.
    return { started, aborted: ac.signal.aborted }
  }

  /** Save & Resend: one /continue { edit }, so the daemon gives the question its new version only
   *  once the turn can run. A PUT and then /continue left the branch ending on the new question,
   *  unanswered, whenever that /continue was skipped (no model ready) or refused (a Turbo Link
   *  machine asleep, the model gone): the next send went out as user, user, which
   *  alternating-role templates reject on every later turn of that branch.
   *  `onStart` runs when the turn starts (the edit closes then, not before). */
  async resendEdit(convId: string, edit: { messageId: string; content: string }, settings: TurnSettings, onStart: () => void): Promise<TurnResult> {
    const ac = new AbortController()
    this.abortRefs[convId] = ac
    let refusal: unknown
    const started = await this.follow(
      convId,
      ac,
      followChatTurn(convId, (accepted) => continueConversation(convId, ac.signal, settings.thinkingBudget, settings.reasoningEffort, settings.remoteModel, undefined, edit, this.accepting(ac, accepted)), ac.signal),
      { start: onStart, refused: (e) => { refusal = e } },
    )
    // The question's version switcher gained an entry (or, on a stale refusal, changed elsewhere).
    void this.deps.qc.invalidateQueries({ queryKey: ['message-variants'] })
    return { started, aborted: ac.signal.aborted, refusal }
  }

  /** One request: the daemon sets the old reply aside only once the turn can run. A separate
   *  /regenerate first lost the reply (no switcher, history ending on the question) whenever
   *  /continue was then refused. It names the reply clicked: when another tab or device has
   *  added a turn since, the daemon refuses it as stale_message instead of replacing a reply
   *  this view never showed, and `follow` shows why and refetches the chat. */
  async regenerate(convId: string, replyId: string, settings: TurnSettings): Promise<void> {
    const ac = new AbortController()
    this.abortRefs[convId] = ac
    await this.follow(convId, ac, followChatTurn(convId, (accepted) => continueConversation(convId, ac.signal, settings.thinkingBudget, settings.reasoningEffort, settings.remoteModel, replyId, undefined, this.accepting(ac, accepted)), ac.signal))
    // The new reply joined the old one's version group, whose switcher list is cached (and a
    // stale refusal means it may have changed elsewhere).
    void this.deps.qc.invalidateQueries({ queryKey: ['message-variants'] })
  }

  /** Stop is what stops a reply now that leaving or closing the page does not: it names the reply
   *  this page shows running (its stream's, or the one the daemon reports before the attach
   *  lands), so a newer reply another tab or device started since is left alone. Only once the
   *  daemon has answered does the page stop following it: a Stop that failed leaves the reply
   *  running, and the page shows it with its Stop still there. `stopped: false` (it had ended, or
   *  was stopped elsewhere) is the same for this page, with no toast. */
  async stop(convId: string, replyId: string | undefined, requestStop: () => Promise<{ stopped?: boolean } | undefined>): Promise<void> {
    const { qc } = this.deps
    let res: { stopped?: boolean } | undefined
    try {
      res = await requestStop()
    } catch {
      toast.error('Could not stop the reply.')
      return
    }
    if (replyId) this.finishedReplies.add(replyId)
    // The text so far into the cached reply before the live view goes, so the bubble does not
    // fall back to the empty placeholder until the conversation is read again; and the chat no
    // longer reads as running, so the attach does not follow it again meanwhile.
    const l = this.state.liveByConv[convId]
    qc.setQueryData<Conversation>(chatKeys.detail(convId), (old) => old
      ? { ...old, runningReplyId: null, messages: l ? (old.messages ?? []).map((m) => (m.id === l.assistantId ? { ...m, content: l.content, reasoning: l.reasoning } : m)) : old.messages }
      : old)
    this.dropLive(convId)
    this.abortRefs[convId]?.abort()
    delete this.abortRefs[convId]
    // A stopped reply is saved as its turn unwinds, usually at once (a tool call that ignores the
    // abort runs to its end first): read it a moment later rather than catch the placeholder.
    if (res?.stopped) setTimeout(() => void qc.invalidateQueries({ queryKey: chatKeys.detail(convId) }), 400)
    else void qc.invalidateQueries({ queryKey: chatKeys.detail(convId) })
  }
}
