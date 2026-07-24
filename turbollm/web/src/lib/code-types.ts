// Types for the Code launchpad's real backend surface (turbollm/src/code/code-routes.ts).

export type CodeMode = 'auto' | 'plan' | 'ask'

export type SessionStatus = 'merged' | 'review' | 'done' | 'aborted'

/** One row from GET /api/v1/code/sessions (sidebar list) or the `session` half of
 *  GET /api/v1/code/sessions/:id. */
export interface CodeSession {
  id: string
  convId: string
  title: string
  status: SessionStatus
  branch: string
  when: string
  add: number
  del: number
  mode?: string
  createdAt: string
  repoRoot: string
  error?: string
  /** Set when archived — hidden from the default (active) sidebar list. */
  archivedAt?: string
  /** Set when this session has been /clear'd — the last message id everything at/before is
   *  hidden. Undefined = never cleared, or resumed back from one. */
  clearedUpToMessageId?: string
  /** Set when a message has been reverted-to — that message id and everything after it is
   *  deactivated (not deleted; /resume reactivates it). Mutually exclusive with
   *  clearedUpToMessageId. Undefined = never reverted, or resumed back from one. */
  revertedFromMessageId?: string
  /** True when a run is live in the daemon right now (not merely the persisted status, which
   *  collapses 'running'/'queued' into 'review' for display) — drives the sidebar's live
   *  indicator for a session running in the background, tab not open (ADR-256). Currently only
   *  populated by GET /api/v1/code/sessions/:id (session detail); GET /api/v1/code/sessions (the
   *  sidebar list) does not send it yet — undefined until that's added. */
  running?: boolean
}

/** One step in the model's own plan for the CURRENT turn (ADR-255) — driven by pi's
 *  `update_todos` custom tool, relayed live via the `todos` SSE event below. Ephemeral: the
 *  backend clears its todos at the start of every new turn, so a checklist never carries over
 *  from a prior turn (it won't re-assert until the model calls `update_todos` again). */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type CodeSessionFilter = 'active' | 'archived' | 'all'

export interface CreateCodeSessionParams {
  repoRoot: string
  repoBranch?: string
  modelKey?: string
  mode: CodeMode
  task: string
  useWorktree?: boolean
  worktreeBranch?: string
  worktreeBase?: string
  /** Absolute paths picked via the composer's "Add context" file browser — stored as the
   *  seeded task message's textAttachments, folded into the actual first-turn prompt as a
   *  read-this-file nudge (code-routes.ts's contextFilesBlock) when that turn runs. */
  contextFiles?: string[]
}

/** How a submitted message is delivered when a run is already active (Phase 1, ADR-246):
 *  'steer' redirects the CURRENTLY ACTIVE turn (pi's `session.steer`), 'followUp' queues a fresh
 *  turn behind it. A 'steer' that arrives too late to inject falls back to the queue still tagged
 *  'steer'. Backend defaults to 'followUp' (byte-for-byte the pre-ADR-246 behavior). */
export type SteerKind = 'steer' | 'followUp'

/** One entry in the server-side message queue (turns waiting behind the active one).
 *  `userMsgId` identifies the entry (not just its text) so a per-entry action — e.g. "Send now"
 *  — can target one specific queued turn even if two queued tasks have identical text. */
export interface QueuedTurn {
  userMsgId: string
  task: string
  /** Which delivery the turn was submitted as — drives the inline queued card's steer-vs-follow-up
   *  badge. Backend tags every queued entry (default 'followUp'). */
  kind: SteerKind
}

/** POST /api/v1/code/sessions/:id/messages request body (start or queue a turn). */
export interface CodeSendMessageBody {
  content?: string
  promptOverride?: string
  contextFiles?: string[]
  thinkingBudget?: number
  /** Delivery mode when a run is already active — 'steer' redirects the live turn, 'followUp'
   *  (default) queues behind it. Omitted = 'followUp'. */
  kind?: SteerKind
}

/** POST .../messages response (202). `steered` is true ONLY when a 'steer' actually injected into
 *  a live turn; a steer that fell back to the queue, or any 'followUp', reports `steered: false`. */
export interface CodeSendMessageResponse {
  ok: true
  queued: boolean
  steered: boolean
  userMessageId: string
}

/** POST .../exec response — a user-run `!command`/`!!command` shell escape (ADR-258). `messageId`
 *  is set only for the `!` variant (feedToModel), which persists the command+output as a user
 *  message the model reads next turn; `!!` returns output for a transcript-only peek. */
export interface CodeExecResponse {
  ok: true
  command: string
  output: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  messageId?: string
}

/** One transcript-only `!!command` result (never persisted) — held in client state and rendered at
 *  the transcript tail. `!command` results are NOT this shape; they come back as a persisted
 *  message carrying a `shell` tool call. */
export interface ShellRun {
  id: string
  command: string
  output: string
  exitCode: number | null
  timedOut: boolean
}

// SSE event payloads for GET /api/v1/code/sessions/:id/stream (code-routes.ts). Reuses
// chat's tool_call/reasoning/delta wire shape verbatim (same sink), but 'meta'/'done' carry
// different fields than chat's — a real, separate type, not a reuse of ChatSseEvent.
// 'queue' is Code-specific: the server-side message queue's current contents, so the client's
// "Queued" chips are driven by the daemon (and survive a disconnect) rather than browser memory.
export type CodeSseEvent =
  | { event: 'meta';      data: { userMessageId: string; assistantMessageId: string } }
  | { event: 'reasoning'; data: { delta: string } }
  | { event: 'delta';     data: { delta: string } }
  | { event: 'tool_call'; data: { id: string; name: string; args: Record<string, unknown>; status: 'pending' | 'done' | 'error' | 'awaiting_approval'; result?: string; diff?: string; patch?: string; firstChangedLine?: number } }
  | { event: 'queue';     data: { queued: QueuedTurn[] } }
  | { event: 'compaction'; data: { phase: 'start' | 'end'; reason: 'manual' | 'threshold' | 'overflow'; aborted?: boolean; tokensBefore?: number } }
  // Phase 2 (ADR-249/250) — pi's own agentic-loop signals, relayed by code-session.ts:
  //   'turn': an agentic ROUND boundary within one assistant turn (a model→tools→model cycle),
  //     NOT a message delta. `toolResults` (end only) is how many tool results that round produced.
  //   'retry': pi's auto-retry on a transient provider failure — `start` carries the triggering
  //     error + backoff, `end` reports whether the retry eventually succeeded.
  //   'tool_progress': a CUMULATIVE (not incremental) live-output snapshot from a tool that streams
  //     progress (bash does; edit doesn't) — correlate to the live tool card by `id`, replace-not-append.
  | { event: 'turn';      data: { phase: 'start'; index: number } | { phase: 'end'; index: number; toolResults: number } }
  | { event: 'retry';     data: { phase: 'start'; attempt: number; maxAttempts: number; delayMs: number; message: string } | { phase: 'end'; attempt: number; success: boolean; message?: string } }
  | { event: 'tool_progress'; data: { id: string; name: string; partial: string } }
  // 'prefill' (llama.cpp only): prompt-processing progress BEFORE the first token, polled off
  // the engine's /slots endpoint independently of the pi SDK. Emitted only on a `pct` change
  // (deduped) and stops firing at completion or the first real token — so it's always done by the
  // time any delta/reasoning arrives. Silently absent on non-llama.cpp engines or when /slots is
  // unavailable: "no prefill frame ever arrives, generation just starts" is the NORMAL path, not
  // an error. `processed`/`total` are prompt tokens; `pct` is the rounded percentage.
  | { event: 'prefill';   data: { processed: number; total: number; pct: number } }
  // 'todos' (ADR-255): the model's current plan for THIS turn, via pi's `update_todos` tool.
  // Full-list replace each time, not incremental — same "cumulative snapshot" shape as
  // tool_progress. The backend resets its own todos at the start of every new turn, so this
  // frame simply won't re-fire until the model calls update_todos again for the new one.
  | { event: 'todos';     data: { todos: TodoItem[] } }
  | { event: 'done';      data: { contextUsed: number; contextMax: number; aborted: boolean } }
  | { event: 'error';     data: { code: string; message: string } }

/** A streamed event tagged with its ring-buffer seq (from the SSE `id:` field), so the client
 *  can reconnect with ?fromSeq=<last seq>. Synthetic connect-time frames (meta/queue) carry no
 *  id and so leave `seq` undefined — they never advance the reconnect cursor. */
export type CodeStreamEvent = CodeSseEvent & { seq?: number }

// ── Launchpad "Coding activity" stats (GET /api/v1/code/stats) — mirrors turbollm/src/chat/
// db.ts's CodeStatsResult/CodeStatsDay exactly; real numbers, not code-mock.ts's old fakes. ──

export type CodeStatsRange = 'all' | '30d' | '7d'

export interface CodeStatsDay {
  date: string
  sessions: number
}

export interface CodeStats {
  range: CodeStatsRange
  sessions: number
  tasksShipped: number
  filesTouched: number
  diffAdded: number
  diffRemoved: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  favoriteModel: string | null
  heatmap: CodeStatsDay[]
}

// ── Git actions (Phase 3, ADR-259) — GET/POST /api/v1/code/sessions/:id/git/* ──────────────────
// Mirrors turbollm/src/code/git-actions.ts's own types exactly; see that file for the full
// scope note (commit+push only, no gh/GitHub-API call, push never forces).

export interface GitFileStatus {
  path: string
  /** Raw two-character porcelain status code (e.g. 'M ', '??', ' D', 'AM') — rendered as-is
   *  rather than re-interpreted, so no meaning is lost or guessed at client-side. */
  code: string
}

export interface GitStatusResult {
  isRepo: boolean
  /** '' for an unborn HEAD (brand-new repo, no commits yet) or a detached HEAD. */
  branch: string
  detached: boolean
  files: GitFileStatus[]
  hasRemote: boolean
  hasUpstream: boolean
  ahead: number
  behind: number
}

export interface CommitGitResult {
  hash: string
  filesCommitted: number
}

export type PushGitReason = 'not_a_repo' | 'no_remote' | 'detached_head' | 'diverged' | 'push_failed'

export type PushGitResult =
  | { ok: true; remote: string; branch: string; compareUrl: string | null }
  | { ok: false; reason: PushGitReason; message: string }
