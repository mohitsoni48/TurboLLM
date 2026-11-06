// The registry of the chat turns running in this daemon (scalability review 5.4). It used to be module state in
// chat-routes.ts, reached by import from the active-work probe, the engine lifecycle, the lifecycle routes and the
// Code run manager. It is one instance now, built by bootDaemon and handed out as `d.chatTurns`, so a test gets its
// own instead of inheriting the last test's turns, and nothing reaches it through a route module.

/** How long `turnsEnded` waits at most by default: well inside `turbollm --stop`'s 10 s and the restart's 14 s
 *  watchdog. A stopped turn that is streaming saves its reply at once; only a tool call it is running holds it. */
const TURNS_END_WAIT_MS = 3_000

export class ChatTurns {
  /** Track in-flight abort controllers per conversation id. */
  private readonly inflight = new Map<string, AbortController>()

  /** The in-flight entries of turns parked on a tool-call approval (execute-with-approval.ts's
   *  wait, from its awaiting_approval frame until the wait ends). Keyed by the entry, as
   *  `compactions` is, so the mark goes with it. Read by parkedChatIds. */
  private readonly approvalWaits = new WeakSet<AbortController>()

  /** How many of the engine's in-progress generations (manager.generationStart, which a local turn
   *  holds from its first request to its end) are turns parked on an approval: no request of theirs
   *  is on the engine meanwhile. The active-work probe takes them out of `engineGenerating`, which
   *  Android's EngineService reads as busy as it does `items`. */
  private parkedLocalTurns = 0

  /** Chats whose auto-title or auto-memory call is still pending, from their reply's `done` until
   *  the call settles; a count per chat, as both can be. Each call starts 1 s or 1.5 s after the
   *  reply, outside the turn's in-flight entry and with no generationStart, so nothing said the
   *  engine was still wanted: on Android with notifications off EngineService read idle in that
   *  second and unloaded the model under the call, and the title and memory were lost.
   *  The active-work probe lists them as `chat` items. Read by afterReplyChatIds. */
  private readonly afterReply = new Map<string, number>()

  /** The in-flight entries POST /compact took. A manual compaction holds the chat's slot as a turn
   *  does, so every route refuses meanwhile, but with a turn's text ('Stop generation first.', 'A
   *  generation is already running') the web UI toasted it over a chat showing only its Compacting
   *  banner and no Stop. Keyed by the entry itself, not the chat, so the tag goes with it. */
  private readonly compactions = new WeakSet<AbortController>()

  /** The reply each turn's in-flight entry generates (its placeholder's id). Keyed by the entry, as
   *  `compactions` is, so it goes with it. Read by slotState. */
  private readonly turnReplies = new WeakMap<AbortController, string>()

  /** The in-flight entries of turns whose own auto-compaction (maybeAutoCompact) is running. Only
   *  compaction Undo reads it (the other routes answer such a turn as a running one), since that
   *  compaction stores its summary over an Undo made meanwhile, as a manual one does. */
  private readonly autoCompactions = new WeakSet<AbortController>()

  /** The running turns (startDetachedTurn), each until it has ended: its reply saved, its run ended. Read by
   *  turnsEnded. */
  private readonly runningTurns = new Set<Promise<void>>()

  /** The running turns' partial saves: runGeneration adds its savePartial while its turn runs and removes it as the
   *  turn ends. POST /api/v1/daemon/flush runs them first (saveRunningReplies), so the database it writes holds each
   *  running reply's text up to that moment. The Android app calls the flush before its Quit ends the process; without
   *  this, a reply running at Quit kept only what its last 10 s save had written. */
  private readonly runningReplySaves = new Set<() => void>()

  // ── the in-flight slot of a chat ─────────────────────────────────────

  /** The entry holding `convId`'s slot, or undefined when it is free. */
  held(convId: string): AbortController | undefined {
    return this.inflight.get(convId)
  }

  /** Takes `convId`'s slot for a turn generating the reply `replyId`. */
  claim(convId: string, ac: AbortController, replyId: string): void {
    this.inflight.set(convId, ac)
    this.turnReplies.set(ac, replyId)
  }

  /** Takes `convId`'s slot for a manual compaction (see `compactions`). */
  claimForCompaction(convId: string, ac: AbortController): void {
    this.compactions.add(ac)
    this.inflight.set(convId, ac)
  }

  /** Removes `convId`'s entry only while it is still `ac`'s own. Stop or a kill switch drops the
   *  entry at once, but the aborted turn can keep unwinding for a long time
   *  (a tool call is not interrupted by the abort) — by the time it does, the entry may belong
   *  to the NEXT turn, which an unconditional delete would leave untracked: unreachable by Stop
   *  and the kill switches, invisible to inFlightChatIds, and no longer a 409 guard. */
  release(convId: string, ac: AbortController): void {
    if (this.inflight.get(convId) === ac) this.inflight.delete(convId)
  }

  /** Stops a turn as POST /chat/stop does: aborts it and frees the chat at once. The turn's own
   *  unwind (a tool call that ignores the abort runs to its end) then releases nothing of the next
   *  turn's (release's identity check). */
  stop(convId: string, ac: AbortController): void {
    ac.abort()
    this.release(convId, ac)
  }

  /** Aborts `convId`'s in-flight entry, if any, leaving it to release itself as the turn unwinds. */
  abort(convId: string): void {
    this.inflight.get(convId)?.abort()
  }

  /** Abort every in-flight chat generation. Called when the user takes over the engine
   *  (load / stop / restart) — those are kill switches: they must stop all other in-app
   *  model calls, not leave streams hanging against an engine that's going away. */
  abortAll(): number {
    const n = this.inflight.size
    for (const ac of this.inflight.values()) ac.abort()
    this.inflight.clear()
    return n
  }

  /** Whether `ac` is a manual compaction's entry. */
  isCompaction(ac: AbortController): boolean {
    return this.compactions.has(ac)
  }

  /** Whether `ac` is the entry of a turn whose own auto-compaction is running. */
  isAutoCompacting(ac: AbortController): boolean {
    return this.autoCompactions.has(ac)
  }

  /** The reply `ac`'s turn generates (its placeholder's id), if it is a turn's entry. */
  replyOf(ac: AbortController): string | undefined {
    return this.turnReplies.get(ac)
  }

  /** What holds `convId`'s in-flight slot, as GET /conversations(/:id) report it, so a page opened or
   *  reopened on the chat (another tab or device) can tell a running reply, and which one, from a manual
   *  compaction: the page's own state knew that only for the turns and compactions it started. */
  slotState(convId: string): { runningReplyId: string | null; compacting: boolean } {
    const held = this.inflight.get(convId)
    if (!held) return { runningReplyId: null, compacting: false }
    if (this.compactions.has(held)) return { runningReplyId: null, compacting: true }
    return { runningReplyId: this.turnReplies.get(held) ?? null, compacting: false }
  }

  /** A turn's maybeAutoCompact phase callback: tags the turn's entry while its compaction runs,
   *  then tells the turn's viewers. Tagged first, so a write that fails still tags it;
   *  maybeAutoCompact sends 'end' after every 'start', the compaction failed or not. */
  autoCompactionPhase(ac: AbortController, write: (phase: 'start' | 'end') => Promise<void>) {
    return (phase: 'start' | 'end') => {
      if (phase === 'start') this.autoCompactions.add(ac)
      else this.autoCompactions.delete(ac)
      return write(phase)
    }
  }

  // ── what the active-work probe and the idle watchdog read ────────────

  /** The conversations with a generation in flight — exactly the chats abortAll()
   *  would abort. Read by the active-work probe (ADR-434 (i)(3)). */
  inFlightChatIds(): string[] {
    return [...this.inflight.keys()]
  }

  /** The chats whose turn is parked on a tool-call approval: those of inFlightChatIds() that wait on
   *  a person, not the engine. The active-work probe lists them apart, in `waiting`:
   *  Android's EngineService counts only `items`, so the phone may sleep while a person is awaited,
   *  as routines.scheduler's runningRoutineIds leaves a parked routine run out. They are still in
   *  flight: a load, Stop or the approval wait running out ends them (a denied call). */
  parkedChatIds(): string[] {
    return [...this.inflight].filter(([, ac]) => this.approvalWaits.has(ac)).map(([convId]) => convId)
  }

  /** The turns parked on an approval that hold a local generation (see `parkedLocalTurns`). */
  parkedEngineTurns(): number {
    return this.parkedLocalTurns
  }

  /** Marks `ac`'s turn as waiting on an approval, or no longer waiting. `holdsLocalGeneration`: the turn counts in
   *  the engine's generation count (it runs on the local engine), so it is also taken out of it while parked. */
  setApprovalWait(ac: AbortController, waiting: boolean, holdsLocalGeneration: boolean): void {
    if (waiting) this.approvalWaits.add(ac)
    else this.approvalWaits.delete(ac)
    if (holdsLocalGeneration) this.parkedLocalTurns += waiting ? 1 : -1
  }

  /** The chats whose reply's auto-title or auto-memory call is still pending (afterReply). */
  afterReplyChatIds(): string[] {
    return [...this.afterReply.keys()]
  }

  /** Runs `call` `delayMs` after now, the chat counted in afterReply from now until it settles. */
  afterReplyCall(convId: string, delayMs: number, call: () => Promise<void>): void {
    this.afterReply.set(convId, (this.afterReply.get(convId) ?? 0) + 1)
    const settled = () => {
      const left = (this.afterReply.get(convId) ?? 1) - 1
      if (left > 0) this.afterReply.set(convId, left)
      else this.afterReply.delete(convId)
    }
    setTimeout(() => { void call().finally(settled) }, delayMs)
  }

  /** Whether a chat still needs the engine's model: a turn holds its chat's slot (generating, its
   *  auto-compaction, a manual compaction, or waiting for a tool-call approval within its wait), or a
   *  finished reply's auto-title or memory call is pending. The idle watchdog asks it
   *  (Manager.holdsEngine, wired in boot.ts) and does not unload meanwhile. A Turbo Link turn counts
   *  too, though it runs on its host: the in-flight entry does not say where a turn runs, and the
   *  local model then waits a reply longer for its TTL. */
  holdsEngine(): boolean {
    return this.inflight.size > 0 || this.afterReply.size > 0
  }

  // ── running turns and their saves ────────────────────────────────────

  /** Counts `turn` among the running turns until `untrackTurn`. */
  trackTurn(turn: Promise<void>): void {
    this.runningTurns.add(turn)
  }

  /** Drops `turn` from the running turns: it has ended. */
  untrackTurn(turn: Promise<void>): void {
    this.runningTurns.delete(turn)
  }

  /** Resolves once every turn running now has ended, or after `maxMs`, whichever is first. The daemon's teardowns
   *  (boot.ts) wait for it, beside the engine's shutdown, before they close the store. A turn abortAll
   *  stopped saves its reply as it unwinds, and one running a tool call unwinds only once the call ends (a tool call
   *  does not end at the abort): the store closed as soon as the engine had stopped, at once with no local engine (a
   *  Turbo Link chat), so such a reply kept only its last 10 s save. Bounded: a stop does not wait out a long tool
   *  call; the next start marks that reply stopped (db.ts abortUnfinishedReplies). */
  turnsEnded(maxMs = TURNS_END_WAIT_MS): Promise<void> {
    if (this.runningTurns.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxMs)
      timer.unref?.()
      void Promise.allSettled([...this.runningTurns]).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Registers a running reply's partial save (see runningReplySaves). */
  addReplySave(save: () => void): void {
    this.runningReplySaves.add(save)
  }

  /** Unregisters a reply's partial save: its turn is ending. */
  removeReplySave(save: () => void): void {
    this.runningReplySaves.delete(save)
  }

  /** Saves every running reply's text so far into its placeholder now (see runningReplySaves). */
  saveRunningReplies(): void {
    for (const save of this.runningReplySaves) save()
  }
}
