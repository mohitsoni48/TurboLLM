// Conversation + message persistence (spec 01 §4). Uses node:sqlite (Node 22+) on desktop;
// Android uses a sql.js (WASM) fallback behind the same interface — see sqlite-adapter.ts.
import { inTransaction, openSqlDb, type SqlDb, type SqlValue } from './store/sqlite-adapter.js'
import { InvalidCursorError, keysetPage, safeJson, type Changes, type P, type PageOpts } from './db-support.js'
import { UsageStatsQueries } from './usage-stats.js'
import { RoutineRepo } from './routine-repo.js'
import { AgentRunRepo } from './agent-run-repo.js'
import { runMigrations, SEARCH_INDEX_BACKFILL_TABLE, UNFINISHED_REPLY, USABLE_TPS_ROW } from './db-migrations.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Routine, RoutineRun, RoutineFlavor, CodingAgentChoice, ScheduleRule } from '../routines/schema'
import { SqliteChatStore } from './store/sqlite-chat-store.js'
import { AttachmentStore } from './attachments.js'
import { LOCAL_SCOPE } from './store/chat-store.js'

export interface Conversation {
  id: string
  title: string
  systemPrompt: string
  modelKey: string
  /** Sampling overrides applied to every request in this conversation. Numeric keys
   *  (temp, topP, …) are camelCase; stop strings live under the 'stop' key as string[]. */
  sampling: Record<string, unknown>
  /** When true, this is the built-in TurboLLM Expert thread: its system prompt is
   *  managed server-side and hidden from the UI (spec 08 §2). */
  expertMode: boolean
  /** Tool-calling policy for this conversation. 'force_web_search' forces the model
   *  to call web_search on the first iteration before composing a reply. */
  toolPolicy?: string
  /** Conversation kind: 'chat' (default user-facing), 'agent' (background agent run),
   *  or 'code' (a real pi-SDK Code session — parallel to 'agent', its own UI surface). */
  kind: 'chat' | 'agent' | 'code'
  /** Folder this conversation is filed under (v10). NULL/undefined = uncategorized. */
  folderId?: string | null
  /** Per-conversation tool-approval overrides (v11, tool-call approval gate). Set via
   *  "Allow for this chat" — persists across restarts. Only 'allow'/'deny' values;
   *  absence of a key means "fall through to the global toolPolicies default".
   *  Always populated (defaults to {}) when read via rowToConv/getConversation. */
  toolOverrides?: Record<string, 'allow' | 'deny'>
  /** When set, this chat is bound to an Agent (spec 13 redesign): its system prompt,
   *  granted tools, and folder scope come from the agent. Null = a plain chat. */
  agentId?: string
  /** Set when the user marks the task complete (spec 13 redesign §2). Null = in progress. */
  completedAt?: string
  /** Per-conversation read scope (spec 13 redesign): absolute file/folder paths the bound
   *  agent may read. Read access is chat-bound (attached via the picker), not agent-bound. */
  readScope?: string[]
  /** pi permission mode for this agent conversation: 'ask'|'auto'|'bypass'|'read'. */
  agentMode?: string
  /** Skill ids enabled for this conversation (the shared SKILL.md library). Their
   *  instructions are injected into the system prompt; 'skill-creator' additionally
   *  grants the save_skill tool. Undefined/empty = a plain chat with no skills. */
  skillIds?: string[]
  /** Tool-name allow-list baked in from a custom chat Agent at creation (Customize →
   *  Agents). Undefined/empty = unrestricted (every built-in persona). */
  allowedTools?: string[]
  /** GitHub #52: when true, past turns' reasoning is folded back into what's resent to
   *  the engine (wrapped in <think> tags, with chat_template_kwargs.preserve_thinking
   *  set so the template doesn't strip it back out) instead of only their final content.
   *  On by default for new conversations (createConversation); the underlying column
   *  still defaults to 0 for already-migrated rows — see createConversation's comment. */
  preserveThinking: boolean
  /** Compaction (ADR-420): the summary that replaces every ACTIVE message at/before
   *  compactionUpToMessageId when a future turn is built. Undefined = never compacted.
   *  Never cleared automatically by edit/branch/delete — only an explicit undo or a new
   *  compaction overwrites these three fields. See chat-compaction.ts's
   *  resolveCompactionCut and setAsideFrozenCut for how a stranded cut is handled: a deleted
   *  cut keeps its summary; a deactivated one (frozen on a branch the user left) is set aside
   *  while that branch is inactive. */
  compactionSummary?: string
  /** The message id everything ACTIVE at/before this is now covered by compactionSummary. */
  compactionUpToMessageId?: string
  /** Estimated token count of what was folded into compactionSummary — display-only. */
  compactionTokensBefore?: number
  /** When the compaction was applied (v51). The context meter reads the last assistant
   *  message's RECORDED ctxUsed, which compaction never rewrites; comparing that message's
   *  createdAt against this tells the UI whether the measurement predates the compaction
   *  (project the new size) or a real turn has since run on the compacted prompt (trust it). */
  compactionAppliedAt?: string
  createdAt: string
  updatedAt: string
  messages?: Message[]
}

/** A chat folder for grouping conversations in the sidebar (v10 migration). Flat —
 *  no nesting. Conversations reference it via the nullable conversations.folder_id. */
export interface Folder {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** A public API run record (spec 27 §6.4) — durable so `GET /runs/{id}` survives a daemon
 *  restart. Node-local operational state, not integrator data, so it lives in its own table
 *  outside the pluggable ChatStore boundary. */
export interface ExtRunRecord {
  id: string; chatId: string; messageId: string; tenant: string; owner: string
  status: string; eventSeq: number
  error: { type: string; code: string; message: string } | null
  createdAt: string; endedAt: string | null
}

/** One durable fact extracted from a user's own chat messages (Release 3, auto-memory).
 *  No FK to conversations — deleting the source chat shouldn't delete the fact it produced. */
export interface MemoryFact {
  id: string
  factText: string
  sourceConvId?: string
  createdAt: string
}

/** One per-agent lesson distilled by the reviewer (spec 13 redesign §3, Reflexion). */
export interface AgentLesson {
  id: string
  agentId: string
  lesson: string
  evidence?: string
  convId?: string
  createdAt: string
}

/** One per-agent skill grown from experience or a folder (spec 13 redesign §3.3, Voyager). */
export interface AgentSkill {
  id: string
  agentId: string
  name: string
  description: string
  procedure: string
  /** Where it came from: 'conversation' | 'folder' | 'manual'. */
  source?: string
  createdAt: string
}

/** A background agent run record (v8 migration). */
export interface AgentRun {
  id: string
  convId: string
  title: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  allowedTools: string[]
  agentId?: string
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
  /** Set when the contract is archived (completed). Null = active. */
  archivedAt?: string
  /** User disposition outcome: 'complete' | 'miss' | undefined (in-flight). */
  completion?: 'complete' | 'miss'
  // ── Code session fields (v28) — populated only for a 'code'-kind run. ──────────
  /** The scratch/repo folder that is the pi session cwd (the containment root). */
  repoRoot?: string
  /** The sidebar "branch" label captured at creation (git rev-parse of repoRoot). */
  repoBranch?: string
  /** Which coding agent this session launches (config.ts's code.defaultAgent, snapshotted at
   *  creation — code-routes.ts). 'turbollm' (or absent, for pre-existing rows) is the built-in
   *  chat UI; the others launch full-screen inside the embedded terminal. */
  codeAgent?: 'turbollm' | 'pi' | 'claude' | 'opencode'
  /** Whether the composer's "isolate in a worktree" tickbox was checked. */
  useWorktree?: boolean
  /** Absolute path of the git worktree this session actually runs in (ADR-316). Absent when the
   *  session works directly in `repoRoot`. */
  worktreePath?: string
  /** Captured worktree intent — stored, NOT acted on in Phase 1 (fast-follow). */
  worktreeBranch?: string
  /** Captured worktree intent — stored, NOT acted on in Phase 1 (fast-follow). */
  worktreeBase?: string
  /** Sidebar "add" stat. 0 for Phase 1 (real diff stats are a fast-follow). */
  linesAdded?: number
  /** Sidebar "del" stat. 0 for Phase 1 (real diff stats are a fast-follow). */
  linesRemoved?: number
  // ── Manual /compact (v29) — one active compaction per session, not incremental history. ──
  /** The summary that replaces every message at/before compactionUpToMessageId when a future
   *  turn's history is replayed (code-session.ts's seedPriorHistory). Undefined = never compacted. */
  compactionSummary?: string
  /** The last DB message id that's covered by compactionSummary — messages after this one
   *  still replay in full. */
  compactionUpToMessageId?: string
  /** pi's own reported token count immediately before this compaction ran — display only. */
  compactionTokensBefore?: number
  // ── Manual /clear + /resume (v30) — a soft, resumable "clear chat" marker. ──────────────
  /** The last DB message id covered by a /clear — resolveEffectiveHistory (code-session.ts)
   *  replays nothing at/before this point AND injects no summary (unlike compaction, a clear
   *  is a blank slate). Undefined = never cleared, or resumed back from one. The transcript UI
   *  hides messages at/before this point too, with a banner offering /resume to un-hide them —
   *  the underlying messages are never deleted, so resuming restores them exactly. */
  clearedUpToMessageId?: string
  // ── Revert to a user message (v33) — a real, resumable deactivation, NOT a clearedUpToMessageId
  // reuse. ─────────────────────────────────────────────────────────────────────────────────────
  /** The id of the message a revert cut FROM (inclusive) — that message and everything after it
   *  (at the moment of the revert) were deactivated (is_active=0, the same mechanism Chat's own
   *  branching uses — see Message.isActive), not merely hidden by a movable cursor. getMessages()
   *  filters is_active=1 unconditionally, so deactivated messages disappear from every consumer
   *  (transcript, resolveEffectiveHistory, revertFileEdits) with no separate cut-logic needed —
   *  unlike clearedUpToMessageId, this correctly supports reverting to ANY earlier user message,
   *  not just the most recent one, since messages BEFORE this id are never touched. Undefined =
   *  never reverted, or resumed back from one. /resume reactivates (is_active=1) every message
   *  from this id onward and clears this field — nothing is ever deleted. Mutually exclusive with
   *  clearedUpToMessageId (each blocks starting the other; /resume undoes whichever is active) —
   *  two independent hidden-and-resumable states on one session would be genuinely confusing. */
  revertedFromMessageId?: string
  // ── Manual-rename persistence (v32) ─────────────────────────────────────────────────────
  /** True once the auto-generated title has been mirrored from conversations.title onto this
   *  run's own title exactly once (code-run-manager.ts's pump()) — gates that mirror to fire
   *  only at the session's first successful turn, never again, so a later manual rename of the
   *  session sticks instead of reverting on the next completed turn. */
  titleAutoSynced?: boolean
  // ── Terminal-agent auto-resume across a daemon restart (v37) ────────────────────────────
  /** True once a terminal has been created for this session at least once. terminal-routes.ts
   *  reads this BEFORE creating a new terminal to decide whether this is a genuinely first-ever
   *  launch or a restart-reconnect (the in-memory TerminalManager/PTY died with the daemon, but
   *  the session itself didn't) — the latter passes the agent's own continue/resume flag so the
   *  CLI picks its interrupted conversation back up instead of starting a blank one. */
  terminalLaunchedOnce?: boolean
}

/** One per-Hitman track-record row (spec 13 §12.3). */
export interface TrackRecordRow {
  id: string
  agentId: string
  runId: string
  model: string
  outcome: 'complete' | 'miss'
  feedback?: string
  ranAt: string
}

/** Per-model aggregation for a Hitman (spec 13 §12.3). */
export interface ModelStat {
  model: string
  total: number
  complete: number
  successRate: number
}

export interface TokenUsageDay {
  date: string
  promptTokens: number
  genTokens: number
  totalTokens: number
  messageCount: number
}

/** Per-model usage within the selected range, for the Tokens dashboard's Models tab. */
export interface ModelUsage {
  modelKey: string
  displayName: string
  messageCount: number
  promptTokens: number
  genTokens: number
  totalTokens: number
}

/** One day's per-model token split, for the Models tab's stacked bar chart. Only models
 *  with activity that day are listed (no zero entries). */
export interface DailyModelBreakdown {
  date: string
  totalTokens: number
  byModel: { modelKey: string; tokens: number }[]
}

export type TokenUsageRange = 'all' | '30d' | '7d'

/** One heatmap cell. `start` is a bucket key whose format depends on `granularityHours`:
 *  "YYYY-MM-DDTHH" for hourly, "YYYY-MM-DD-AM"/"-PM" for 12h, "YYYY-MM-DD" for daily. */
export interface ActivityBucket {
  start: string
  totalTokens: number
  messageCount: number
}

/** Overview heatmap data — box granularity zooms in as the range narrows (1 box = 1h for
 *  7d, 12h for 30d, 1 day for all) so the grid stays visually dense instead of showing a
 *  handful of sparse day-cells for short ranges. */
export interface TokenActivity {
  granularityHours: 1 | 12 | 24
  buckets: ActivityBucket[]
}

export interface TokenUsageStats {
  range: TokenUsageRange
  sessions: number
  messages: number
  totalTokens: number
  activeDays: number
  /** Lifetime, not scoped by `range` — a streak isn't a "last N days" concept. */
  currentStreak: number
  longestStreak: number
  /** Local hour of day (0-23) with the most messages in range; null with no data. */
  peakHour: number | null
  favoriteModel: string | null
  firstMessageAt: string | null
  /** Lifetime, not scoped by `range` — same as the streak fields. Drives the milestone
   *  ladder and the frontend's fun-fact comparison, both of which should stay stable as
   *  the user switches the range tab, not jump around with it. */
  lifetimeTotalTokens: number
  milestone: { achieved: number | null; next: number | null; progressPct: number | null }
  activity: TokenActivity
  dailyByModel: DailyModelBreakdown[]
  byModel: ModelUsage[]
  /** Tokens from gateway (external client) traffic — Claude Code, other CLIs/extensions
   *  (GitHub #71). This isolated breakdown (by source, by model) is separate, but `totalTokens`/
   *  `lifetimeTotalTokens`/`milestone` above already INCLUDE it (founder-directed, 2026-07-22 —
   *  Overview must reflect all usage, not just chat). Only `sessions`/`messages`/streak/
   *  peak-hour/favorite-model stay chat-only: those are chat-conversation concepts (a gateway
   *  request has no conv_id, isn't a "session") with no clean API equivalent. */
  api: ApiUsageStats
}

/** One request source recorded against `api_usage` — the two gateway entry points
 *  (gateway.ts): the Anthropic-protocol translation and the OpenAI-compatible pass-through. */
export type ApiUsageSource = 'anthropic' | 'openai'

/** Where the next rollUpApiUsageBatch starts: just past this (created_at, rowid). */
export interface ApiUsageCursor {
  createdAt: string
  seq: number
}

/** A routine run the retention sweep may delete, with what it links to (v42). */
export interface PrunableRoutineRun {
  id: string
  startedAt: string
  conversationId: string | null
  codeSessionId: string | null
}

export interface ApiModelUsage {
  modelKey: string
  displayName: string
  requests: number
  promptTokens: number
  genTokens: number
  totalTokens: number
}

/** Token usage from external (gateway) clients — Claude Code, other CLIs/extensions hitting
 *  /v1/messages or /v1/chat/completions — as opposed to in-app chat (`TokenUsageStats`). */
export interface ApiUsageStats {
  range: TokenUsageRange
  requests: number
  totalTokens: number
  lifetimeTotalTokens: number
  bySource: { source: ApiUsageSource; requests: number; totalTokens: number }[]
  byModel: ApiModelUsage[]
}

export type CodeStatsRange = 'all' | '30d' | '7d'

/** One heatmap cell — one box per LOCAL calendar day (unlike token usage's sub-day zoom, Code
 *  sessions are coarse enough that day-granularity is always right, at any range). */
export interface CodeStatsDay {
  date: string
  sessions: number
}

export interface CodeStatsResult {
  range: CodeStatsRange
  sessions: number
  /** Runs that finished with status 'done' — aborted/failed/interrupted runs don't count as
   *  "shipped" even though they're real sessions. */
  tasksShipped: number
  /** Distinct file paths touched by an edit or write tool call, in range. */
  filesTouched: number
  /** Real +/- line counts from every edit tool call's stored unified diff (ADR-199 made these
   *  actually persist) — NOT from agent_runs.lines_added/lines_removed, which are still always
   *  0 (columns exist, nothing ever writes them); computed fresh from messages instead, so
   *  there's no separate running counter that could drift from what's actually in the diffs. */
  diffAdded: number
  diffRemoved: number
  activeDays: number
  /** Lifetime, not scoped by `range` — mirrors tokenUsageStats' own semantics (a streak isn't a
   *  "last N days" concept), so these stay stable as the range tab is switched. */
  currentStreak: number
  longestStreak: number
  favoriteModel: string | null
  /** At least 180 days of boxes for 'all' (padded with empty cells for a new install), the real
   *  window for '30d'/'7d' — same convention as tokenUsageStats' heatmap. */
  heatmap: CodeStatsDay[]
}

export interface MessageStats {
  promptTokens: number
  promptMs: number
  promptTps: number
  cachedTokens: number
  genTokens: number
  genMs: number
  tps: number
  ttftMs: number
  totalMs: number
  thinkMs: number
  ctxUsed: number
  ctxMax: number
  model: string
  aborted: boolean
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
  /** run_python only (GitHub #52): the images the run handed back, as attachment references (`attachment:<id>`). The
   *  reply row's own `attachments` names them too, which is what the attachment janitor keeps. */
  files?: string[]
  /** Code mode only (pi's edit tool result) — a display-oriented diff and a standard unified
   *  patch of the change. Persisted so the diff panel and revert-to-message (code-routes.ts's
   *  revert endpoint) both still have this after a page reload, not just on the live SSE
   *  stream that produced it. */
  diff?: string
  patch?: string
  firstChangedLine?: number
  /** Code mode only: made by a delegate_task/invoke_skill sub-agent, not the session's own model
   *  — shown and revertable like any call, but never replayed into the parent model's history. */
  subagent?: boolean
  /** Code mode only, 'edit' calls: a revert-to-message with revertFiles already reverse-applied
   *  this call's patch on disk (revert.ts). A later revert reaching the call again (one further
   *  back, or one after /resume) skips it rather than reversing it a second time. */
  reverted?: boolean
}

/** Code, item 6 (2026-07-13): an ordered text/tool-call timeline for an assistant message, in
 *  TRUE chronological order — the fix for completed Code turns rendering in a fixed "reasoning →
 *  all tool calls grouped → final text" layout regardless of how they actually interleaved live.
 *  Tool blocks reference an id into this same message's `toolCalls` array rather than duplicating
 *  the full record — `toolCalls` remains the single source of truth for a call's data. */
export type MessageTimelineBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string }

/** F-021: research metadata attached to Research-persona assistant messages. */
export interface ResearchMeta {
  /** Self-assessed confidence score emitted by the model (0.0–1.0). */
  confidence?: number
  /** Ranked source list from the retrieval service (F-021). */
  sources?: ResearchSource[]
  /** Per-claim referee verdicts (F-022). */
  refereeVerdicts?: ClaimVerdict[]
}

/** A single ranked research result persisted with the message. */
export interface ResearchSource {
  url: string
  title: string
  passage: string
  relevanceScore: number
  freshnessSignal: 'recent' | 'dated' | 'unknown'
  domain: string
}

/** F-022: per-sentence claim verdict from the heuristic referee. */
export interface ClaimVerdict {
  sentence: string
  citedUrl?: string
  verdict: 'verified' | 'unverified' | 'uncited'
  matchedPassage?: string
}

export interface Message {
  id: string
  convId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  attachments: string[]
  textAttachments: string[]
  /** v52: the attached documents' TEXT as the user turn first sent it (`textAttachments` holds only
   *  their names). Kept so a regenerate or edit-and-resend can send the turn again with its
   *  documents. Absent when the turn attached none, and on rows written before v52. */
  docContext?: string
  /** Tool calls made by this assistant turn (v0.7.0). */
  toolCalls: ToolCallRecord[]
  /** Code, item 6 — ordered text/tool-call interleave. Absent on messages persisted before this
   *  field existed, and on non-Code (chat) messages, which never populate it. */
  timeline?: MessageTimelineBlock[]
  stats: Partial<MessageStats>
  /** F-021/F-022: research metadata (confidence, sources, referee verdicts). Absent on non-research messages. */
  researchMeta?: ResearchMeta
  createdAt: string
  /** Chat branching (GitHub #52): shared by this message and its regenerated siblings.
   *  Null when the message has never been regenerated (no branch UI to show). */
  variantGroup: string | null
  /** Chat branching: whether this is the sibling currently shown/sent as history.
   *  getMessages() only returns active messages. */
  isActive: boolean
  /** Chat branching (user-message edits): the specific message-version id this row's
   *  downstream tail was frozen under, when it's not part of the live/active tail. */
  branchOf: string | null
  /** True only when a user explicitly edited this assistant reply's text in place —
   *  never set by the normal generation-completion save. */
  edited: boolean
}

interface ConvRow { id: string; title: string; system_prompt: string; model_key: string; sampling: string; expert_mode: number; tool_policy: string | null; kind: string | null; folder_id: string | null; tool_overrides: string | null; agent_id: string | null; completed_at: string | null; read_scope: string | null; agent_mode: string | null; skill_ids: string | null; allowed_tools: string | null; preserve_thinking: number; compaction_summary: string | null; compaction_upto_message_id: string | null; compaction_tokens_before: number | null; compaction_applied_at: string | null; created_at: string; updated_at: string }
interface FolderRow { id: string; name: string; sort_order: number; created_at: string; updated_at: string }
interface ExtRunRow { id: string; chat_id: string; message_id: string; tenant: string; owner: string; status: string; event_seq: number; error: string | null; created_at: string; ended_at: string | null }
interface MsgRow  { id: string; conv_id: string; seq: number; role: 'user' | 'assistant'; content: string; reasoning: string; attachments: string; text_attachments: string | null; tool_calls: string | null; timeline: string | null; stats: string; model_key: string | null; research_meta: string | null; created_at: string; variant_group: string | null; is_active: number; branch_of: string | null; edited: number; doc_context: string | null }

/** A column chat search indexes (v54), and its full-text table `<table>_fts`. */
interface SearchIndexedColumn { table: 'messages' | 'conversations'; column: 'content' | 'title' }
const SEARCH_INDEXED: SearchIndexedColumn[] = [{ table: 'messages', column: 'content' }, { table: 'conversations', column: 'title' }]

/** Every schema object of the search index: the FTS tables and their triggers. */
const SEARCH_INDEX_TRIGGERS = SEARCH_INDEXED.flatMap(({ table }) => ['insert', 'delete', 'update'].map((op) => `${table}_fts_${op}`))
const SEARCH_INDEX_TABLES = SEARCH_INDEXED.map(({ table }) => `${table}_fts`)

/** Search needs at least one trigram: shorter queries take the LIKE path. */
const TRIGRAM_CHARS = 3

/** Chat search's full-text index over one column (v54): an external-content FTS5 table, so the text
 *  is stored once, in its own table. The trigram tokenizer, case-insensitive, matches any substring
 *  of three characters or more — what the LIKE scan it replaces found, mid-word, CJK and punctuation
 *  included. Triggers keep it in step: insert, delete (a conversation's cascade included) and only an
 *  UPDATE OF the indexed column, so the many updates that leave it alone cost nothing. A row still
 *  in the backfill's pending range is left to the backfill, never touched by a trigger: an
 *  external-content index must never be told to delete a row it does not hold, nor hold one twice.
 *  Rows join on rowid: the tables have TEXT primary keys, and VACUUM may renumber such a table's
 *  rowids, so any future VACUUM must run `INSERT INTO <fts>(<fts>) VALUES('rebuild')` after. */
function searchIndexSchema({ table, column }: SearchIndexedColumn): string {
  const fts = `${table}_fts`
  const indexed = (row: 'new' | 'old') => `NOT EXISTS (SELECT 1 FROM search_index_backfill WHERE tbl = '${table}' AND ${row}.rowid BETWEEN next_rowid AND end_rowid)`
  return `
    CREATE VIRTUAL TABLE ${fts} USING fts5(${column}, content='${table}', tokenize='trigram case_sensitive 0');
    CREATE TRIGGER ${fts}_insert AFTER INSERT ON ${table} WHEN ${indexed('new')} BEGIN
      INSERT INTO ${fts}(rowid, ${column}) VALUES (new.rowid, new.${column});
    END;
    CREATE TRIGGER ${fts}_delete AFTER DELETE ON ${table} WHEN ${indexed('old')} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, ${column}) VALUES ('delete', old.rowid, old.${column});
    END;
    CREATE TRIGGER ${fts}_update AFTER UPDATE OF ${column} ON ${table} WHEN ${indexed('old')} BEGIN
      INSERT INTO ${fts}(${fts}, rowid, ${column}) VALUES ('delete', old.rowid, old.${column});
      INSERT INTO ${fts}(rowid, ${column}) VALUES (new.rowid, new.${column});
    END;
  `
}

/** Conversations whose title or any message (inactive variants included, as before) matches. The
 *  FTS form computes each side's matches once; the LIKE form (sql.js, no FTS5, short queries, an
 *  index still being backfilled) stops at the first matching message per conversation. */
const SEARCH_MATCH_FTS = `(
  c.rowid IN (SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH $q)
  OR c.id IN (SELECT messages.conv_id FROM messages_fts JOIN messages ON messages.rowid = messages_fts.rowid WHERE messages_fts MATCH $q)
)`
const SEARCH_MATCH_LIKE = `(
  c.title LIKE $q ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM messages m WHERE m.conv_id = c.id AND m.content LIKE $q ESCAPE '\\')
)`

/** A trigram MATCH for `text` anywhere: one quoted phrase, so FTS syntax in it (AND, NEAR, *, :, -,
 *  parentheses) is plain text, and its trigrams must appear in a row, in order — a substring. */
function ftsSubstring(text: string): string {
  return `"${text.replaceAll('"', '""')}"`
}

/** A LIKE pattern for `text` anywhere, its own %, _ and \ taken literally (with ESCAPE '\'). */
function likeSubstring(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`
}

/** Conversation list rows: every column but compaction_summary, which can run to thousands of
 *  words and only the opened conversation (getConversation) shows. */
const CONV_LIST_COLUMNS = `id, title, system_prompt, model_key, sampling, expert_mode, tool_policy, kind, folder_id, tool_overrides, agent_id, completed_at, read_scope, agent_mode, skill_ids, allowed_tools, preserve_thinking, NULL AS compaction_summary, compaction_upto_message_id, compaction_tokens_before, compaction_applied_at, created_at, updated_at`

/** Message rows for display: every column but doc_context (getMessagesForDisplay). */
const MSG_DISPLAY_COLUMNS = `id, conv_id, seq, role, content, reasoning, attachments, text_attachments, tool_calls, timeline, stats, model_key, research_meta, created_at, variant_group, is_active, branch_of, edited, NULL AS doc_context`

function safeToolOverrides(s: string | null): Record<string, 'allow' | 'deny'> {
  if (!s) return {}
  const parsed = safeJson(s)
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Record<string, 'allow' | 'deny'> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === 'allow' || v === 'deny') out[k] = v
  }
  return out
}

function rowToConv(r: ConvRow): Conversation {
  return { id: r.id, title: r.title, systemPrompt: r.system_prompt, modelKey: r.model_key, sampling: safeJson(r.sampling) as Record<string, unknown>, expertMode: r.expert_mode === 1, toolPolicy: r.tool_policy ?? undefined, kind: (r.kind === 'agent' ? 'agent' : r.kind === 'code' ? 'code' : 'chat'), folderId: r.folder_id ?? null, toolOverrides: safeToolOverrides(r.tool_overrides), agentId: r.agent_id ?? undefined, completedAt: r.completed_at ?? undefined, readScope: r.read_scope ? (safeJson(r.read_scope) as string[]) : undefined, agentMode: r.agent_mode ?? undefined, skillIds: r.skill_ids ? (safeJson(r.skill_ids) as string[]) : undefined, allowedTools: r.allowed_tools ? (safeJson(r.allowed_tools) as string[]) : undefined, preserveThinking: r.preserve_thinking === 1, compactionSummary: r.compaction_summary ?? undefined, compactionUpToMessageId: r.compaction_upto_message_id ?? undefined, compactionTokensBefore: r.compaction_tokens_before ?? undefined, compactionAppliedAt: r.compaction_applied_at ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at }
}

interface MemoryFactRow { id: string; fact_text: string; source_conv_id: string | null; created_at: string }

function rowToMemoryFact(r: MemoryFactRow): MemoryFact {
  return { id: r.id, factText: r.fact_text, sourceConvId: r.source_conv_id ?? undefined, createdAt: r.created_at }
}

function rowToFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at }
}

function rowToExtRun(r: ExtRunRow): ExtRunRecord {
  return {
    id: r.id, chatId: r.chat_id, messageId: r.message_id, tenant: r.tenant, owner: r.owner,
    status: r.status, eventSeq: r.event_seq,
    error: r.error ? (safeJson(r.error) as ExtRunRecord['error']) : null,
    createdAt: r.created_at, endedAt: r.ended_at,
  }
}

function rowToMsg(r: MsgRow): Message {
  const msg: Message = { id: r.id, convId: r.conv_id, seq: r.seq, role: r.role, content: r.content, reasoning: r.reasoning, attachments: safeJson(r.attachments) as string[], textAttachments: r.text_attachments ? safeJson(r.text_attachments) as string[] : [], toolCalls: r.tool_calls ? safeJson(r.tool_calls) as ToolCallRecord[] : [], stats: safeJson(r.stats) as Partial<MessageStats>, createdAt: r.created_at, variantGroup: r.variant_group, isActive: r.is_active !== 0, branchOf: r.branch_of, edited: r.edited === 1 }
  if (r.research_meta) msg.researchMeta = safeJson(r.research_meta) as ResearchMeta
  if (r.timeline) msg.timeline = safeJson(r.timeline) as MessageTimelineBlock[]
  if (r.doc_context) msg.docContext = r.doc_context
  return msg
}

/** SQLite's own name for a database that lives only in RAM. Pass it as `dataDir` for a store
 *  that writes nothing to disk and is gone when closed. */
export { InvalidCursorError, type PageOpts }

export const IN_MEMORY_DATA_DIR = ':memory:'

export class ConversationStore {
  private db: SqlDb

  /** The usage, routine and agent-run query groups over this same handle (5.7). */
  private readonly usage: UsageStatsQueries
  private readonly routines: RoutineRepo
  private readonly agentRuns: AgentRunRepo

  private _chatStore?: SqliteChatStore

  /** Whether chat search's v54 full-text index exists and is kept in step (FTS5 compiled in; never on sql.js). */
  private searchIndexBuilt = false

  /** Whether rows written before the index existed still wait for the backfill (search-index-backfill.ts). */
  private searchIndexBackfillPending = false

  /** The chat images messages.attachments refers to (2.7), in the same data directory as the database. */
  readonly attachments: AttachmentStore

  /** The raw handle, so the pluggable ChatStore can run over the SAME connection and
   *  tables rather than opening a second one (WAL + locking would bite otherwise).
   *  Phase 1 amendment 1: SqliteChatStore sits ALONGSIDE this class, not beneath it. */
  get handle(): SqlDb { return this.db }

  /** Lazily constructed so `new ConversationStore(dir)` stays cheap and so the
   *  migration in the constructor has already run before any store touches a table. */
  get chatStore(): SqliteChatStore {
    if (!this._chatStore) this._chatStore = new SqliteChatStore(this.db)
    return this._chatStore
  }

  constructor(dataDir: string) {
    this.db = openSqlDb(dataDir === IN_MEMORY_DATA_DIR ? IN_MEMORY_DATA_DIR : join(dataDir, 'turbollm.db'))
    this.usage = new UsageStatsQueries(this.db)
    this.routines = new RoutineRepo(this.db)
    this.agentRuns = new AgentRunRepo(this.db)
    this.attachments = new AttachmentStore(dataDir)
    try {
      runMigrations(this.db)
      this.reconcileSearchIndex()
    } catch (e) {
      this.db.close()
      throw e
    }
  }

  /** Chat search reads the full-text index: it exists and holds every row. Until then, LIKE. */
  get searchIndexReady(): boolean { return this.searchIndexBuilt && !this.searchIndexBackfillPending }

  /** Rows written before the index existed are not indexed yet: the backfill has work. */
  get searchIndexPending(): boolean { return this.searchIndexBuilt && this.searchIndexBackfillPending }

  private fts5Compiled(): boolean {
    return (this.db.prepare(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS yes`).get() as { yes: number }).yes === 1
  }

  private schemaHas(name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = $name`).get({ $name: name } as P)
  }

  /** Fits chat search's index to the runtime that opened the database, each open, cheaply:
   *  - no FTS5 (sql.js, Node before 22.16): its triggers go, or every message write would fail
   *    on the missing module; search stays on LIKE. The FTS tables stay (dropping one needs the module).
   *  - FTS5, the index whole: kept, with whatever backfill is still pending.
   *  - FTS5, the index missing or partial (a fresh database, or one written meanwhile by a runtime
   *    without FTS5, whose writes it never saw): created empty, and every existing row is left to
   *    the background backfill — never tokenized here, on the boot path. */
  private reconcileSearchIndex(): void {
    if (!this.fts5Compiled()) {
      this.db.exec(SEARCH_INDEX_TRIGGERS.map((t) => `DROP TRIGGER IF EXISTS ${t};`).join('\n'))
      return
    }
    if (![...SEARCH_INDEX_TABLES, ...SEARCH_INDEX_TRIGGERS].every((name) => this.schemaHas(name))) {
      this.transaction(() => this.createSearchIndex())
    }
    this.searchIndexBuilt = true
    this.refreshSearchIndexBackfillPending()
  }

  private createSearchIndex(): void {
    this.db.exec([
      ...SEARCH_INDEX_TRIGGERS.map((t) => `DROP TRIGGER IF EXISTS ${t};`),
      ...SEARCH_INDEX_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`),
      `${SEARCH_INDEX_BACKFILL_TABLE};`,
      'DELETE FROM search_index_backfill;',
    ].join('\n'))
    const pending = this.db.prepare(`INSERT INTO search_index_backfill (tbl, next_rowid, end_rowid) VALUES ($tbl, $next, $end)`)
    for (const indexed of SEARCH_INDEXED) {
      this.db.exec(searchIndexSchema(indexed))
      const { lo, hi } = this.db.prepare(`SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM ${indexed.table}`).get() as { lo: number | null; hi: number | null }
      if (lo !== null && hi !== null) pending.run({ $tbl: indexed.table, $next: lo, $end: hi } as P)
    }
  }

  private refreshSearchIndexBackfillPending(): void {
    this.searchIndexBackfillPending = !!this.db.prepare(`SELECT 1 FROM search_index_backfill LIMIT 1`).get()
  }

  /** Indexes the next `batchRows` rowids the search index's backfill still has, in one transaction
   *  that also moves its persisted progress past them — so a row is indexed once, by this or (past
   *  the range) by a trigger. Whether there was a batch to do. For search-index-backfill.ts. */
  backfillSearchIndex(batchRows: number): boolean {
    if (!this.searchIndexPending) return false
    this.transaction(() => {
      const range = this.db.prepare(`SELECT tbl, next_rowid, end_rowid FROM search_index_backfill ORDER BY tbl LIMIT 1`)
        .get() as unknown as { tbl: string; next_rowid: number; end_rowid: number }
      const { table, column } = SEARCH_INDEXED.find((s) => s.table === range.tbl)!
      const upTo = Math.min(range.next_rowid + batchRows - 1, range.end_rowid)
      this.db.prepare(`INSERT INTO ${table}_fts (rowid, ${column}) SELECT rowid, ${column} FROM ${table} WHERE rowid BETWEEN $from AND $upTo`)
        .run({ $from: range.next_rowid, $upTo: upTo } as P)
      if (upTo >= range.end_rowid) this.db.prepare(`DELETE FROM search_index_backfill WHERE tbl = $tbl`).run({ $tbl: table } as P)
      else this.db.prepare(`UPDATE search_index_backfill SET next_rowid = $next WHERE tbl = $tbl`).run({ $tbl: table, $next: upTo + 1 } as P)
    })
    this.refreshSearchIndexBackfillPending()
    return true
  }

  listConversations(q?: string, kind: 'chat' | 'agent' | 'all' = 'all'): Conversation[] {
    const query = q?.trim()
    return query ? this.searchConversations(query, kind) : this.listConversationsPage(kind).conversations
  }

  /** Up to 200 conversations whose title or messages hold `query`, case-insensitively, most recently
   *  updated first. The whole query is one substring, spaces included, as it always was. The v54
   *  trigram index answers it once complete and the query has a trigram; otherwise a LIKE scan does.
   *  (The index also folds non-ASCII case, where LIKE folds only ASCII.) */
  private searchConversations(query: string, kind: 'chat' | 'agent' | 'all'): Conversation[] {
    const indexed = this.searchIndexReady && [...query].length >= TRIGRAM_CHARS
    const params: P = { $q: indexed ? ftsSubstring(query) : likeSubstring(query) }
    const kindClause = kind === 'all' ? '' : ' AND c.kind = $kind'
    if (kind !== 'all') params.$kind = kind
    const rows = this.db.prepare(`
      SELECT c.* FROM conversations c
      WHERE ${indexed ? SEARCH_MATCH_FTS : SEARCH_MATCH_LIKE}${kindClause}
      ORDER BY c.updated_at DESC LIMIT 200
    `).all(params) as unknown as ConvRow[]
    return rows.map(rowToConv)
  }

  /** The sidebar list, most recently updated first, a keyset page at a time (200 by default
   *  and at most). Rows leave out the compaction summary (CONV_LIST_COLUMNS). */
  listConversationsPage(kind: 'chat' | 'agent' | 'all', page: PageOpts = {}): { conversations: Conversation[]; nextCursor: string | null } {
    const { rows, nextCursor } = keysetPage<ConvRow>(this.db, {
      columns: CONV_LIST_COLUMNS, table: 'conversations', sortColumn: 'updated_at', sortValue: (r) => r.updated_at,
      where: kind === 'all' ? [] : ['kind = $kind'], params: kind === 'all' ? {} : { $kind: kind },
    }, page, 200, 200)
    return { conversations: rows.map(rowToConv), nextCursor }
  }

  createConversation(partial?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'sampling' | 'expertMode' | 'toolPolicy' | 'kind' | 'folderId' | 'agentId' | 'skillIds' | 'allowedTools' | 'preserveThinking'>>): Conversation {
    const now = new Date().toISOString()
    const id = randomUUID()
    // preserve_thinking's column default is baked in at ALTER TABLE time (v25) and can't
    // be changed retroactively for already-migrated DBs — so "on by default for new chats"
    // is enforced here instead, by always writing an explicit value.
    this.db.prepare(`INSERT INTO conversations (id,title,system_prompt,model_key,sampling,expert_mode,tool_policy,kind,folder_id,agent_id,skill_ids,allowed_tools,preserve_thinking,created_at,updated_at) VALUES ($id,$title,$sp,$mk,$samp,$expert,$tp,$kind,$fid,$aid,$sk,$at,$pt,$now,$now)`)
      .run({ $id: id, $title: partial?.title ?? 'New chat', $sp: partial?.systemPrompt ?? '', $mk: partial?.modelKey ?? '', $samp: JSON.stringify(partial?.sampling ?? {}), $expert: partial?.expertMode ? 1 : 0, $tp: partial?.toolPolicy ?? null, $kind: partial?.kind ?? 'chat', $fid: partial?.folderId ?? null, $aid: partial?.agentId ?? null, $sk: partial?.skillIds ? JSON.stringify(partial.skillIds) : null, $at: partial?.allowedTools ? JSON.stringify(partial.allowedTools) : null, $pt: (partial?.preserveThinking ?? true) ? 1 : 0, $now: now } as P)
    return this.getConversation(id)!
  }

  getConversation(id: string, withMessages = false): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = $id`).get({ $id: id } as P) as unknown as ConvRow | undefined
    if (!row) return null
    const conv = rowToConv(row)
    if (withMessages) conv.messages = this.getMessages(id)
    return conv
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'sampling' | 'modelKey' | 'skillIds' | 'preserveThinking'>>): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = $now']
    const params: Record<string, SqlValue> = { $id: id, $now: now }
    if (patch.title !== undefined)        { sets.push('title = $title');      params.$title = patch.title }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = $sp'); params.$sp    = patch.systemPrompt }
    if (patch.sampling !== undefined)     { sets.push('sampling = $samp');    params.$samp  = JSON.stringify(patch.sampling) }
    if (patch.modelKey !== undefined)     { sets.push('model_key = $mk');     params.$mk    = patch.modelKey }
    if (patch.skillIds !== undefined)     { sets.push('skill_ids = $sk');     params.$sk    = JSON.stringify(patch.skillIds) }
    if (patch.preserveThinking !== undefined) { sets.push('preserve_thinking = $pt'); params.$pt = patch.preserveThinking ? 1 : 0 }
    return ((this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  /** Compaction (ADR-420). Deliberately NOT part of updateConversation's Pick-patch —
   *  that pattern's `!== undefined` guards can only ever WRITE a value, never null one
   *  back out, and compaction needs both (set here, clear via clearConversationCompaction
   *  for undo). Overwrites any prior compaction wholesale — compounding (a second
   *  compaction folding an earlier summary back in) is chat-compaction.ts's job, not
   *  this method's; by the time this is called the caller has already produced the ONE
   *  new summary that should replace whatever was here before. */
  setConversationCompaction(id: string, patch: { summary: string; upToMessageId: string; tokensBefore: number }): boolean {
    const now = new Date().toISOString()
    return ((this.db.prepare(
      `UPDATE conversations SET compaction_summary = $sum, compaction_upto_message_id = $upto, compaction_tokens_before = $tok, compaction_applied_at = $now, updated_at = $now WHERE id = $id`,
    ).run({ $id: id, $sum: patch.summary, $upto: patch.upToMessageId, $tok: patch.tokensBefore, $now: now } as P) as unknown) as Changes).changes > 0
  }

  /** Undo (manual, from the expanded transcript divider): nulls all compaction columns.
   *  No message is touched — this is a pure metadata revert, not a data restore, since
   *  compaction never mutated or deleted anything to begin with. */
  clearConversationCompaction(id: string): boolean {
    const now = new Date().toISOString()
    return ((this.db.prepare(
      `UPDATE conversations SET compaction_summary = NULL, compaction_upto_message_id = NULL, compaction_tokens_before = NULL, compaction_applied_at = NULL, updated_at = $now WHERE id = $id`,
    ).run({ $id: id, $now: now } as P) as unknown) as Changes).changes > 0
  }

  /** Per-conversation tool-approval overrides (tool-call approval gate). Empty object
   *  when unset or the conversation does not exist. */
  getToolOverrides(id: string): Record<string, 'allow' | 'deny'> {
    const row = this.db.prepare(`SELECT tool_overrides FROM conversations WHERE id = $id`).get({ $id: id } as P) as unknown as { tool_overrides: string | null } | undefined
    return safeToolOverrides(row?.tool_overrides ?? null)
  }

  /** Merges `{[toolName]: decision}` into the conversation's persisted tool overrides
   *  ("Allow for this chat" — survives a restart). No-op if the conversation is missing. */
  setToolOverride(id: string, toolName: string, decision: 'allow' | 'deny'): void {
    const current = this.getToolOverrides(id)
    current[toolName] = decision
    this.db.prepare(`UPDATE conversations SET tool_overrides = $json WHERE id = $id`)
      .run({ $id: id, $json: JSON.stringify(current) } as P)
  }

  touchConversation(id: string): void {
    this.db.prepare(`UPDATE conversations SET updated_at = $now WHERE id = $id`).run({ $id: id, $now: new Date().toISOString() } as P)
  }

  deleteConversation(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM conversations WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  /** Active-branch messages only — this is the conversation as the user sees it and as
   *  it's sent to the engine. Regenerated-away siblings (is_active=0) are excluded. */
  getMessages(convId: string): Message[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id AND is_active = 1 ORDER BY seq ASC`).all({ $id: convId } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  /** getMessages for the chat to show (GET /conversations/:id, which the web UI polls): without docContext, the
   *  attached documents' full text, which only a resend reads and no client is sent. */
  getMessagesForDisplay(convId: string): Message[] {
    return (this.db.prepare(`SELECT ${MSG_DISPLAY_COLUMNS} FROM messages WHERE conv_id = $id AND is_active = 1 ORDER BY seq ASC`).all({ $id: convId } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  /** Ids of the messages in rowids (afterRowid, afterRowid + window] whose attachments JSON contains `needle`, and
   *  where the next window starts (null past the last message). A window of rowids, not a LIMIT of matches, bounds
   *  how much one statement scans however few rows match. Only `tenant`'s rows when given (the backfill: the app's
   *  own), every row when not (the collection, which must see each reference). For the attachment janitor. */
  messagesWithAttachment(needle: string, afterRowid: number, window: number, tenant?: string): { ids: string[]; next: number | null } {
    const upTo = afterRowid + window
    const tenantClause = tenant === undefined ? '' : ' AND tenant = $tenant'
    const ids = (this.db.prepare(`SELECT id FROM messages WHERE rowid > $after AND rowid <= $upTo AND instr(attachments, $needle) > 0${tenantClause} ORDER BY rowid`)
      .all({ $after: afterRowid, $upTo: upTo, $needle: needle, ...(tenant === undefined ? {} : { $tenant: tenant }) } as P) as unknown as Array<{ id: string }>).map((r) => r.id)
    const { last } = this.db.prepare(`SELECT MAX(rowid) AS last FROM messages`).get() as unknown as { last: number | null }
    return { ids, next: last !== null && last > upTo ? upTo : null }
  }

  /** A message's attachments as stored (JSON text), for replaceMessageAttachments; null when there is no such row. */
  messageAttachmentsJson(id: string): string | null {
    const row = this.db.prepare(`SELECT attachments FROM messages WHERE id = $id`).get({ $id: id } as P) as unknown as { attachments: string } | undefined
    return row?.attachments ?? null
  }

  /** Replaces a message's attachments only while they are still `previousJson` (messageAttachmentsJson): a row edited
   *  or deleted since it was read is left alone. Only the app's own (local) rows: an External Chat API row keeps what
   *  its client wrote. A replaced row's version goes up, as any change to it does. Whether it was replaced. */
  replaceMessageAttachments(id: string, previousJson: string, attachments: string[]): boolean {
    return ((this.db.prepare(`UPDATE messages SET attachments = $next, version = version + 1 WHERE id = $id AND tenant = $local AND attachments = $previous`)
      .run({ $id: id, $local: LOCAL_SCOPE.tenant, $previous: previousJson, $next: JSON.stringify(attachments) } as P) as unknown) as Changes).changes > 0
  }

  /** The active-branch messages after `markerId`, in order — the tail a compacted Code session
   *  replays, read without loading what the compaction already summarized. null when the marker
   *  is not an active message of this conversation (deleted, regenerated away, or another
   *  conversation's), exactly the cases where it is absent from getMessages. */
  getActiveMessagesAfter(convId: string, markerId: string): Message[] | null {
    const marker = this.db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $cid AND is_active = 1`)
      .get({ $id: markerId, $cid: convId } as P) as unknown as { seq: number } | undefined
    if (!marker) return null
    return (this.db.prepare(`SELECT * FROM messages WHERE conv_id = $cid AND is_active = 1 AND seq > $seq ORDER BY seq ASC`)
      .all({ $cid: convId, $seq: marker.seq } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  /** Like {@link deactivateMessagesFrom}'s own range (seq >= fromMessageId's seq) — but returns
   *  the actual rows regardless of is_active, unlike getMessages' unconditional is_active=1
   *  filter. Needed for Code's /revert file-revert path: a SUPERSEDING revert (ADR-278) that
   *  passes revertFiles=true must be able to see edit-tool patches from a PREVIOUSLY reverted,
   *  already-inactive range too — getMessages alone would silently drop that range, making
   *  revertFileEdits skip files a prior chat-only revert never touched, while the caller's
   *  success toast still claims everything from the new cut onward was reverted. */
  getMessagesFromIncludingInactive(convId: string, fromMessageId: string): Message[] {
    const from = this.db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $cid`).get({ $id: fromMessageId, $cid: convId } as P) as unknown as { seq: number } | undefined
    if (!from) return []
    return (this.db.prepare(`SELECT * FROM messages WHERE conv_id = $cid AND seq >= $seq ORDER BY seq ASC`)
      .all({ $cid: convId, $seq: from.seq } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  addMessage(convId: string, role: 'user' | 'assistant', content: string, extra?: Partial<Pick<Message, 'reasoning' | 'attachments' | 'textAttachments' | 'docContext' | 'toolCalls' | 'stats' | 'variantGroup'>>): Message {
    const id = randomUUID()
    const now = new Date().toISOString()
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS ms FROM messages WHERE conv_id = $id`).get({ $id: convId } as P) as unknown as { ms: number }
    // Attribute assistant replies to the conversation's model so the Models screen
    // can surface last-session gen t/s (spec 04 §5). User turns are left NULL.
    const modelKey = role === 'assistant' ? this.conversationModelKey(convId) : null
    const textAttachments = extra?.textAttachments?.length ? JSON.stringify(extra.textAttachments) : null
    const toolCalls = extra?.toolCalls?.length ? JSON.stringify(extra.toolCalls) : null
    this.db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,reasoning,attachments,text_attachments,doc_context,tool_calls,stats,model_key,created_at,variant_group,is_active) VALUES ($id,$cid,$seq,$role,$content,$reasoning,$attachments,$ta,$dc,$tc,$stats,$mk,$now,$vg,1)`)
      .run({ $id: id, $cid: convId, $seq: row.ms + 1, $role: role, $content: content, $reasoning: extra?.reasoning ?? '', $attachments: JSON.stringify(extra?.attachments ?? []), $ta: textAttachments, $dc: extra?.docContext || null, $tc: toolCalls, $stats: JSON.stringify(extra?.stats ?? {}), $mk: modelKey, $now: now, $vg: extra?.variantGroup ?? null } as P)
    this.touchConversation(convId)
    return this.getMessage(id)!
  }

  /** The model_key a conversation is bound to (empty string → null). */
  private conversationModelKey(convId: string): string | null {
    const r = this.db.prepare(`SELECT model_key FROM conversations WHERE id = $id`).get({ $id: convId } as P) as { model_key?: string } | undefined
    return r?.model_key ? r.model_key : null
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = $id`).get({ $id: id } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  updateMessage(id: string, patch: Partial<Pick<Message, 'content' | 'reasoning' | 'attachments' | 'toolCalls' | 'timeline' | 'stats' | 'researchMeta' | 'edited'>>): boolean {
    const sets: string[] = []
    const params: Record<string, SqlValue> = { $id: id }
    if (patch.attachments  !== undefined) { sets.push('attachments = $att');         params.$att          = JSON.stringify(patch.attachments) }
    if (patch.content      !== undefined) { sets.push('content = $content');         params.$content      = patch.content }
    if (patch.reasoning    !== undefined) { sets.push('reasoning = $reasoning');     params.$reasoning    = patch.reasoning }
    if (patch.toolCalls    !== undefined) { sets.push('tool_calls = $tc');           params.$tc           = JSON.stringify(patch.toolCalls) }
    if (patch.timeline     !== undefined) { sets.push('timeline = $tl');             params.$tl           = JSON.stringify(patch.timeline) }
    if (patch.stats        !== undefined) { sets.push('stats = $stats');             params.$stats        = JSON.stringify(patch.stats) }
    if (patch.researchMeta !== undefined) { sets.push('research_meta = $rm');        params.$rm           = JSON.stringify(patch.researchMeta) }
    if (patch.edited       !== undefined) { sets.push('edited = $edited');           params.$edited       = patch.edited ? 1 : 0 }
    if (!sets.length) return false
    return ((this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  deleteMessage(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM messages WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  /** On daemon startup: a chat reply still with its turn's placeholder stats (`{"aborted":false}`, the exact stats
   *  only the two chat turn routes insert, and which only the save at the end of the turn replaces) belongs to a turn
   *  of a previous process, which died before that save. It stayed that way for good, shown as "This message is
   *  empty." (or, with the text the turn saved while it streamed, as a finished reply) with nothing to say why, so it
   *  is marked stopped, its text kept. A placeholder edited by hand since keeps its text and stats: the two message
   *  edits, the only writers of `edited` (this app's PUT route and the External Chat API's PATCH, through
   *  sqlite-chat-store over this table), set it and leave stats alone, while the turn's saves as it streams never
   *  set it, so `edited` is what tells the two apart now that an unfinished reply can have text. Code sessions
   *  (kind 'code') are Code's own: its run reconcile marks them, and a finished Code turn can carry those same
   *  stats. Returns how many replies were marked. */
  abortUnfinishedReplies(): number {
    // Reads only the partial index idx_messages_unfinished (v53), then checks each hit's
    // conversation by primary key — this runs at every startup, so it must not scan history.
    return ((this.db.prepare(
      `UPDATE messages SET stats = '{"aborted":true}'
        WHERE ${UNFINISHED_REPLY}
          AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conv_id AND c.kind <> 'code')`,
    ).run() as unknown) as Changes).changes
  }

  /** Most-recent assistant gen t/s per model (spec 04 §5 `lastTps`). For each
   *  model_key, takes the newest assistant message that recorded a positive
   *  `stats.tps` and returns its value. Rows with NULL model_key (pre-v2) or no
   *  usable t/s are skipped. Returns an empty map when there's no chat history.
   *  GET /api/v1/models runs this on every poll, so it walks the partial index
   *  idx_messages_model_tps (only rows with a usable t/s): the model keys one seek at a
   *  time (MIN above the previous one — a skip scan), then the newest row of each. */
  lastGenTpsByModel(): Map<string, number> {
    const firstModel = this.db.prepare(`SELECT MIN(model_key) AS m FROM messages WHERE ${USABLE_TPS_ROW}`)
    const nextModel = this.db.prepare(`SELECT MIN(model_key) AS m FROM messages WHERE ${USABLE_TPS_ROW} AND model_key > $after`)
    const newestTps = this.db.prepare(`
      SELECT json_extract(stats, '$.tps') AS tps FROM messages
      WHERE ${USABLE_TPS_ROW} AND model_key = $m
      ORDER BY created_at DESC, seq DESC LIMIT 1
    `)
    const out = new Map<string, number>()
    type ModelRow = { m: string | null } | undefined
    for (let r = firstModel.get() as ModelRow; r?.m != null; r = nextModel.get({ $after: r.m } as P) as ModelRow) {
      const { tps } = newestTps.get({ $m: r.m } as P) as { tps: number }
      out.set(r.m, Math.round(tps * 10) / 10)
    }
    return out
  }

  /** Active branch only — matches getMessages(). Used to find "the last thing the user
   *  currently sees" (e.g. to decide whether a fresh assistant placeholder follows it). */
  getLastMessage(convId: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id AND is_active = 1 ORDER BY seq DESC LIMIT 1`).get({ $id: convId } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  /** Like getLastMessage, but ignores is_active — the globally last-inserted row in this
   *  conversation, regardless of which branch it belongs to. */
  getLastMessageAnyStatus(convId: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id ORDER BY seq DESC LIMIT 1`).get({ $id: convId } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  /** The message immediately after `afterSeq` in this conversation, regardless of
   *  is_active — used right after regenerate deactivates a reply, to find specifically
   *  THAT message (not just "whatever has the highest seq anywhere," which would pick up
   *  an unrelated later branch's messages in a conversation with more than one branch
   *  point — seq is monotonic and per-row-unique, so this is unambiguous). */
  getNextMessageAfterSeq(convId: string, afterSeq: number): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id AND seq > $seq ORDER BY seq ASC LIMIT 1`).get({ $id: convId, $seq: afterSeq } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
  }

  /** Chat branching (GitHub #52): deactivate a message instead of deleting it, and
   *  establish its variant_group (its own id) if this is its first regeneration. Also drops
   *  any branch_of tag: only freezeTail's rows may carry one, and a row restored before
   *  restoreTail cleared tags still has its old one (see restoreTail). */
  deactivateMessage(id: string): void {
    this.db.prepare(`UPDATE messages SET is_active = 0, branch_of = NULL, variant_group = COALESCE(variant_group, id) WHERE id = $id`).run({ $id: id } as P)
  }

  /** All siblings sharing a variant_group (active + inactive), oldest first — the full
   *  set the branch switcher UI (‹ 2/3 ›) needs. */
  getMessageVariants(variantGroup: string): Message[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE variant_group = $vg ORDER BY seq ASC`).all({ $vg: variantGroup } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  /** Switches which sibling in a variant group is the active/shown one. No-op (returns
   *  false) if targetId isn't actually a member of that group. The sibling it turns off
   *  loses any branch_of tag, as in deactivateMessage. */
  setActiveVariant(variantGroup: string, targetId: string): boolean {
    const target = this.getMessage(targetId)
    if (!target || target.variantGroup !== variantGroup) return false
    this.db.prepare(`UPDATE messages SET is_active = 0, branch_of = NULL WHERE variant_group = $vg AND is_active = 1`).run({ $vg: variantGroup } as P)
    this.db.prepare(`UPDATE messages SET is_active = 1 WHERE id = $id`).run({ $id: targetId } as P)
    return true
  }

  /** Chat branching (user-message edits, GitHub #52): freeze the currently-active tail
   *  after `afterSeq` — everything downstream of an edited/switched-away-from message —
   *  by deactivating it and tagging it with `anchorId` so restoreTail can bring back
   *  exactly this state later, including whichever regenerate-sibling was active in it. */
  freezeTail(convId: string, afterSeq: number, anchorId: string): void {
    this.db.prepare(`UPDATE messages SET is_active = 0, branch_of = $anchor WHERE conv_id = $id AND seq > $seq AND is_active = 1`)
      .run({ $id: convId, $seq: afterSeq, $anchor: anchorId } as P)
  }

  /** Chat branching: reactivate every message previously frozen under `anchorId` — the
   *  inverse of freezeTail, used when switching back to that message version. The tag is
   *  cleared as the rows come back: an active row must not carry one, or a reply regenerated
   *  away inside this tail later would still read as "frozen under anchorId" and come back
   *  next to its replacement. freezeTail re-tags whatever is active when the
   *  user switches away again. */
  restoreTail(anchorId: string): void {
    this.db.prepare(`UPDATE messages SET is_active = 1, branch_of = NULL WHERE branch_of = $anchor`).run({ $anchor: anchorId } as P)
  }

  /** Runs `fn` as one transaction: every statement it makes lands, or (when it throws) none do.
   *  For the branch operations that take several statements (an edit's freezeTail +
   *  deactivateMessage + addMessage, a version switch's freezeTail + restoreTail +
   *  setActiveVariant): a statement that failed partway (disk full, an I/O error) left a group
   *  with no active member, or a frozen tail with nothing shown in its place. `fn` must be
   *  synchronous, so nothing else on this connection can run inside it; sql.js (Android) takes
   *  BEGIN/COMMIT/ROLLBACK like node:sqlite, and its periodic flush is a timer, which cannot fire
   *  in the middle either. */
  transaction<T>(fn: () => T): T {
    return inTransaction(this.db, fn)
  }

  // ── Folder methods (v10 migration) ────────────────────────────────────────

  /** All folders in insertion order (sort_order asc, then created_at). */
  listFolders(): Folder[] {
    return (this.db.prepare(`SELECT * FROM folders ORDER BY sort_order ASC, created_at ASC`).all() as unknown as FolderRow[]).map(rowToFolder)
  }

  getFolder(id: string): Folder | null {
    const row = this.db.prepare(`SELECT * FROM folders WHERE id = $id`).get({ $id: id } as P) as unknown as FolderRow | undefined
    return row ? rowToFolder(row) : null
  }

  createFolder(name: string): Folder {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO folders (id,name,sort_order,created_at,updated_at) VALUES ($id,$name,0,$now,$now)`)
      .run({ $id: id, $name: name, $now: now } as P)
    return this.getFolder(id)!
  }

  renameFolder(id: string, name: string): boolean {
    const now = new Date().toISOString()
    return ((this.db.prepare(`UPDATE folders SET name = $name, updated_at = $now WHERE id = $id`).run({ $id: id, $name: name, $now: now } as P) as unknown) as Changes).changes > 0
  }

  /** Delete a folder. Member conversations are UNASSIGNED (folder_id → NULL), never
   *  cascade-deleted. Returns false if the folder did not exist. */
  deleteFolder(id: string): boolean {
    // Unassign members explicitly — do not rely on any SQLite ON DELETE behavior
    // (node:sqlite does not reliably enforce inline FK constraints added via ALTER TABLE).
    this.db.prepare(`UPDATE conversations SET folder_id = NULL WHERE folder_id = $id`).run({ $id: id } as P)
    return ((this.db.prepare(`DELETE FROM folders WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  /** Move a conversation into a folder (or out of any folder when folderId is null).
   *  When folderId is non-null the folder must exist. Returns:
   *   - { ok: true }             on success,
   *   - { ok: false, reason }    when the conversation or the target folder is missing. */
  moveConversationToFolder(convId: string, folderId: string | null): { ok: true } | { ok: false; reason: 'conversation_not_found' | 'folder_not_found' } {
    if (folderId !== null && !this.getFolder(folderId)) return { ok: false, reason: 'folder_not_found' }
    const now = new Date().toISOString()
    const changed = ((this.db.prepare(`UPDATE conversations SET folder_id = $fid, updated_at = $now WHERE id = $id`).run({ $id: convId, $fid: folderId, $now: now } as P) as unknown) as Changes).changes > 0
    return changed ? { ok: true } : { ok: false, reason: 'conversation_not_found' }
  }

  // ── Public API run records (v47 migration, spec 27 §6.4) ──────────────────

  upsertExtRun(r: ExtRunRecord): void {
    this.db.prepare(`INSERT INTO ext_runs (id,chat_id,message_id,tenant,owner,status,event_seq,error,created_at,ended_at)
      VALUES ($id,$c,$m,$t,$o,$s,$seq,$e,$ca,$ea)
      ON CONFLICT(id) DO UPDATE SET status=$s, event_seq=$seq, error=$e, ended_at=$ea`)
      .run({
        $id: r.id, $c: r.chatId, $m: r.messageId, $t: r.tenant, $o: r.owner,
        $s: r.status, $seq: r.eventSeq, $e: r.error ? JSON.stringify(r.error) : null,
        $ca: r.createdAt, $ea: r.endedAt,
      } as P)
  }

  getExtRun(id: string): ExtRunRecord | null {
    const r = this.db.prepare(`SELECT * FROM ext_runs WHERE id = $id`).get({ $id: id } as P) as unknown as ExtRunRow | undefined
    return r ? rowToExtRun(r) : null
  }

  /** `owner` filters in SQL, before the LIMIT: filtering the tenant's newest `limit` rows
   *  afterwards dropped an owner's runs whenever other owners had `limit` newer ones. */
  listExtRuns(tenant: string, owner?: string, limit = 100): ExtRunRecord[] {
    return (this.db.prepare(`SELECT * FROM ext_runs WHERE tenant = $t AND ($o IS NULL OR owner = $o) ORDER BY created_at DESC LIMIT $l`)
      .all({ $t: tenant, $o: owner ?? null, $l: limit } as P) as unknown as ExtRunRow[]).map(rowToExtRun)
  }

  /** Close out runs left mid-stream by a previous process (spec 27 §6.4). A row left with a
   *  terminal status but no ended_at (the run's final write, the one that sets it, failed) gets
   *  one as well, its status kept: a row with no ended_at reads as a running run, so it refused
   *  every turn on its chat, and a restart did not clear it. Returns the rows marked failed. */
  markStreamingExtRunsFailed(code: string, message: string): number {
    const err = JSON.stringify({ type: 'engine', code, message })
    const now = new Date().toISOString()
    const r = this.db.prepare(`UPDATE ext_runs SET status='failed', error=$e, ended_at=$now WHERE status IN ('queued','streaming')`)
      .run({ $e: err, $now: now } as P) as unknown as Changes
    this.db.prepare(`UPDATE ext_runs SET ended_at=$now WHERE ended_at IS NULL`).run({ $now: now } as P)
    return r.changes
  }

  /** Revert-to-message (v33): deactivates `fromMessageId` and every message after it (by `seq`,
   *  within the same conversation) — is_active=0, same mechanism Chat's branching uses. Unlike
   *  clearedUpToMessageId's movable cursor, this correctly discards a range starting anywhere in
   *  history while leaving everything BEFORE it untouched and visible. Returns the number of rows
   *  deactivated (0 if `fromMessageId` doesn't exist). */
  deactivateMessagesFrom(convId: string, fromMessageId: string): number {
    const from = this.db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $cid`).get({ $id: fromMessageId, $cid: convId } as P) as unknown as { seq: number } | undefined
    if (!from) return 0
    return ((this.db.prepare(`UPDATE messages SET is_active = 0 WHERE conv_id = $cid AND seq >= $seq`)
      .run({ $cid: convId, $seq: from.seq } as P) as unknown) as Changes).changes
  }

  /** Undoes {@link deactivateMessagesFrom} — reactivates `fromMessageId` and every message after
   *  it (by `seq`). Safe to call even if `fromMessageId` itself no longer exists (a no-op, 0
   *  rows) — mirrors deactivateMessagesFrom's own lookup-then-range-update shape. */
  reactivateMessagesFrom(convId: string, fromMessageId: string): number {
    const from = this.db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $cid`).get({ $id: fromMessageId, $cid: convId } as P) as unknown as { seq: number } | undefined
    if (!from) return 0
    return ((this.db.prepare(`UPDATE messages SET is_active = 1 WHERE conv_id = $cid AND seq >= $seq`)
      .run({ $cid: convId, $seq: from.seq } as P) as unknown) as Changes).changes
  }

  /** /clear (v34): deactivates `uptoMessageId` and every message BEFORE it (by `seq`) — a real,
   *  resumable PREFIX deactivation (is_active=0), the mirror of {@link deactivateMessagesFrom}'s
   *  suffix and the same mechanism /revert and Chat branching use. Replaces /clear's old
   *  clearedUpToMessageId DISPLAY cursor, which left the "cleared" rows is_active=1 — so
   *  getMessages()/getConversation() (hence session export AND the model's own history replay via
   *  resolveEffectiveHistory) still saw them, applying the cut only client-side. /clear hides
   *  everything up to AND INCLUDING the cut (showing only turns added AFTER it), so this is a
   *  prefix. Returns the number of rows deactivated (0 if `uptoMessageId` doesn't exist). Only ever
   *  called on Code conversations, which have no regenerate/branch siblings, so every prefix row is
   *  active at clear time — same coarse assumption reactivateMessagesFrom already relies on. */
  deactivateMessagesUpTo(convId: string, uptoMessageId: string): number {
    const upto = this.db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $cid`).get({ $id: uptoMessageId, $cid: convId } as P) as unknown as { seq: number } | undefined
    if (!upto) return 0
    return ((this.db.prepare(`UPDATE messages SET is_active = 0 WHERE conv_id = $cid AND seq <= $seq`)
      .run({ $cid: convId, $seq: upto.seq } as P) as unknown) as Changes).changes
  }

  /** Undoes {@link deactivateMessagesUpTo} — reactivates `uptoMessageId` and every message before
   *  it (by `seq`). A NEW turn appended after a /clear has a HIGHER seq than the cut, so /resume
   *  never touches it — only the originally-cleared prefix comes back. Safe if `uptoMessageId` no
   *  longer exists (0 rows). */
  reactivateMessagesUpTo(convId: string, uptoMessageId: string): number {
    const upto = this.db.prepare(`SELECT seq FROM messages WHERE id = $id AND conv_id = $cid`).get({ $id: uptoMessageId, $cid: convId } as P) as unknown as { seq: number } | undefined
    if (!upto) return 0
    return ((this.db.prepare(`UPDATE messages SET is_active = 1 WHERE conv_id = $cid AND seq <= $seq`)
      .run({ $cid: convId, $seq: upto.seq } as P) as unknown) as Changes).changes
  }

  // ── Self-improvement: completion marker + per-agent lessons (redesign §2/§3) ──

  /** Mark a conversation's task complete (archives it from the active agent view). */
  markConversationComplete(id: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`UPDATE conversations SET completed_at = $now, updated_at = $now WHERE id = $id`).run({ $id: id, $now: now } as P)
  }

  /** Reopen a completed/archived conversation so it accepts messages again. */
  reopenConversation(id: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`UPDATE conversations SET completed_at = NULL, updated_at = $now WHERE id = $id`).run({ $id: id, $now: now } as P)
  }

  /** Replace a conversation's read scope (absolute file/folder paths). */
  setConversationReadScope(id: string, paths: string[]): void {
    const now = new Date().toISOString()
    this.db.prepare(`UPDATE conversations SET read_scope = $scope, updated_at = $now WHERE id = $id`)
      .run({ $id: id, $scope: JSON.stringify(paths), $now: now } as P)
  }

  /** Set a conversation's pi permission mode ('ask'|'auto'|'bypass'|'read'). */
  setConversationMode(id: string, mode: string): void {
    this.db.prepare(`UPDATE conversations SET agent_mode = $mode WHERE id = $id`)
      .run({ $id: id, $mode: mode } as P)
  }

  // ── Auto-memory (Release 3) ───────────────────────────────────────────────────
  // Insert/list/delete only — no update. Facts are reviewed and removed, not hand-edited.

  addMemoryFact(row: { factText: string; sourceConvId?: string }): MemoryFact {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO memory_facts (id,fact_text,source_conv_id,created_at) VALUES ($id,$ft,$sc,$now)`)
      .run({ $id: id, $ft: row.factText, $sc: row.sourceConvId ?? null, $now: now } as P)
    return { id, factText: row.factText, sourceConvId: row.sourceConvId, createdAt: now }
  }

  listMemoryFacts(): MemoryFact[] {
    const rows = this.db.prepare(`SELECT * FROM memory_facts ORDER BY created_at DESC`).all() as unknown as MemoryFactRow[]
    return rows.map(rowToMemoryFact)
  }

  /** Facts newest first, a keyset page at a time (200 by default and at most). */
  listMemoryFactsPage(page: PageOpts = {}): { facts: MemoryFact[]; nextCursor: string | null } {
    const { rows, nextCursor } = keysetPage<MemoryFactRow>(this.db, {
      columns: 'id, fact_text, source_conv_id, created_at', table: 'memory_facts', sortColumn: 'created_at', sortValue: (r) => r.created_at, where: [], params: {},
    }, page, 200, 200)
    return { facts: rows.map(rowToMemoryFact), nextCursor }
  }

  /** The text of the `limit` newest facts — the window extraction dedupes a new fact against. */
  recentMemoryFactTexts(limit: number): string[] {
    return (this.db.prepare(`SELECT fact_text FROM memory_facts ORDER BY created_at DESC, id DESC LIMIT $n`)
      .all({ $n: limit } as P) as Array<{ fact_text: string }>).map((r) => r.fact_text)
  }

  deleteMemoryFact(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM memory_facts WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  // ── Query groups pulled out of this class (5.7): same methods, same handle ──────────

  // Usage dashboards and roll-ups: UsageStatsQueries
  tokenUsageStats(range: TokenUsageRange = 'all'): TokenUsageStats {
    return this.usage.tokenUsageStats(range)
  }

  recordApiUsage(rec: { source: ApiUsageSource; modelKey: string | null; promptTokens: number; genTokens: number; codeSessionId?: string | null; durationMs?: number | null; promptTps?: number | null; genTps?: number | null; harness?: string | null }): void {
    this.usage.recordApiUsage(rec)
  }

  setCodeSessionCtxUsed(codeSessionId: string, ctxUsed: number): void {
    this.usage.setCodeSessionCtxUsed(codeSessionId, ctxUsed)
  }

  getLastApiUsageForSession(codeSessionId: string): { ctxUsed: number; promptTokens: number; genTokens: number; promptTps: number | null; genTps: number | null } | null {
    return this.usage.getLastApiUsageForSession(codeSessionId)
  }

  apiUsageStats(range: TokenUsageRange = 'all'): ApiUsageStats {
    return this.usage.apiUsageStats(range)
  }

  rollUpApiUsageBatch(before: string, limit: number, after: ApiUsageCursor | null = null): { rolledUp: number; next: ApiUsageCursor | null } {
    return this.usage.rollUpApiUsageBatch(before, limit, after)
  }

  chatDailyStats(dayIso: string): {
    conversations: number; messages: number; maxMessagesInConversation: number
    medianMessagesInConversation: number; distinctModels: number; toolCalls: number
    regenerates: number; stops: number
  } {
    return this.usage.chatDailyStats(dayIso)
  }

  gatewayDailyStats(dayIso: string): { protocol: ApiUsageSource; harness: string; requests: number; promptTokens: number; genTokens: number; distinctModels: number }[] {
    return this.usage.gatewayDailyStats(dayIso)
  }

  codeDailyStats(dayIso: string): { sessions: number; turns: number; toolCalls: number } {
    return this.usage.codeDailyStats(dayIso)
  }

  codeStats(range: CodeStatsRange = 'all'): CodeStatsResult {
    return this.usage.codeStats(range)
  }

  // Routines and their runs: RoutineRepo
  createRoutine(params: {
    flavor: RoutineFlavor; prompt: string; scheduleDisplay: string; scheduleRule: ScheduleRule
    modelKey: string; agentId?: string; workspacePath?: string; codingAgent?: CodingAgentChoice
    permissionMode?: Routine['permissionMode']
  }): Routine {
    return this.routines.createRoutine(params)
  }

  getRoutine(id: string): Routine | null {
    return this.routines.getRoutine(id)
  }

  listRoutines(): Routine[] {
    return this.routines.listRoutines()
  }

  listDueRoutines(nowIso: string): Routine[] {
    return this.routines.listDueRoutines(nowIso)
  }

  confirmRoutine(id: string, nextFireAtIso: string): Routine | null {
    return this.routines.confirmRoutine(id, nextFireAtIso)
  }

  updateRoutine(
    id: string,
    patch: Partial<Pick<Routine, 'prompt' | 'scheduleDisplay' | 'scheduleRule' | 'nextFireAt' | 'modelKey' | 'workspacePath' | 'codingAgent' | 'permissionMode' | 'status'>>,
  ): Routine | null {
    return this.routines.updateRoutine(id, patch)
  }

  deleteRoutine(id: string): boolean {
    return this.routines.deleteRoutine(id)
  }

  createRoutineRun(params: { routineId: string; configSnapshot: string }): RoutineRun {
    return this.routines.createRoutineRun(params)
  }

  getRoutineRun(id: string): RoutineRun | null {
    return this.routines.getRoutineRun(id)
  }

  listRoutineRuns(routineId: string): RoutineRun[] {
    return this.routines.listRoutineRuns(routineId)
  }

  listRoutineRunsPage(routineId: string, page: PageOpts = {}): { runs: RoutineRun[]; nextCursor: string | null } {
    return this.routines.listRoutineRunsPage(routineId, page)
  }

  countRoutineRuns(routineId: string): number {
    return this.routines.countRoutineRuns(routineId)
  }

  routineRunsBeyondNewest(routineId: string, keep: number, limit: number, after: Pick<PrunableRoutineRun, 'startedAt' | 'id'> | null = null): PrunableRoutineRun[] {
    return this.routines.routineRunsBeyondNewest(routineId, keep, limit, after)
  }

  isRoutineRunContinued(runId: string): boolean {
    return this.routines.isRoutineRunContinued(runId)
  }

  deleteRoutineRuns(runs: PrunableRoutineRun[]): { runs: number; conversations: number } {
    return this.routines.deleteRoutineRuns(runs)
  }

  listParkedRoutineRuns(): RoutineRun[] {
    return this.routines.listParkedRoutineRuns()
  }

  listRunningRoutineRuns(): RoutineRun[] {
    return this.routines.listRunningRoutineRuns()
  }

  updateRoutineRun(
    id: string,
    patch: Partial<Pick<RoutineRun, 'status' | 'skipReason' | 'pendingToolCall' | 'result' | 'error' | 'endedAt' | 'conversationId' | 'codeSessionId'>>,
  ): RoutineRun | null {
    return this.routines.updateRoutineRun(id, patch)
  }

  // Agent / Code session runs, track records, lessons and skills: AgentRunRepo
  createAgentRun(params: { convId: string; title: string; allowedTools: string[]; agentId?: string; repoRoot?: string; repoBranch?: string; useWorktree?: boolean; worktreeBranch?: string; worktreeBase?: string; worktreePath?: string; codeAgent?: 'turbollm' | 'pi' | 'claude' | 'opencode' }): AgentRun {
    return this.agentRuns.createAgentRun(params)
  }

  getAgentRun(id: string): AgentRun | null {
    return this.agentRuns.getAgentRun(id)
  }

  listAgentRuns(opts?: { statuses?: string[] }): AgentRun[] {
    return this.agentRuns.listAgentRuns(opts)
  }

  listAgentRunsPage(opts: { statuses?: string[] } & PageOpts = {}): { runs: AgentRun[]; nextCursor: string | null } {
    return this.agentRuns.listAgentRunsPage(opts)
  }

  updateAgentRun(id: string, patch: Partial<Pick<AgentRun, 'status' | 'error' | 'startedAt' | 'endedAt' | 'title' | 'compactionSummary' | 'compactionUpToMessageId' | 'compactionTokensBefore' | 'titleAutoSynced' | 'terminalLaunchedOnce'>>): boolean {
    return this.agentRuns.updateAgentRun(id, patch)
  }

  setAgentRunArchived(id: string, archived: boolean): boolean {
    return this.agentRuns.setAgentRunArchived(id, archived)
  }

  setClearedUpToMessageId(id: string, messageId: string | null): boolean {
    return this.agentRuns.setClearedUpToMessageId(id, messageId)
  }

  setRevertedFromMessageId(id: string, messageId: string | null): boolean {
    return this.agentRuns.setRevertedFromMessageId(id, messageId)
  }

  deleteCodeSession(runId: string): boolean {
    return this.agentRuns.deleteCodeSession(runId)
  }

  getRunDoc(runId: string): string {
    return this.agentRuns.getRunDoc(runId)
  }

  upsertRunDoc(runId: string, content: string): void {
    this.agentRuns.upsertRunDoc(runId, content)
  }

  addTrackRecord(row: Omit<TrackRecordRow, 'id' | 'ranAt'> & { ranAt?: string }): void {
    this.agentRuns.addTrackRecord(row)
  }

  trackRecordForAgent(agentId: string): TrackRecordRow[] {
    return this.agentRuns.trackRecordForAgent(agentId)
  }

  modelStatsForAgent(agentId: string): ModelStat[] {
    return this.agentRuns.modelStatsForAgent(agentId)
  }

  setRunDisposition(runId: string, completion: 'complete' | 'miss', archive: boolean): boolean {
    return this.agentRuns.setRunDisposition(runId, completion, archive)
  }

  listActiveAgentRuns(): AgentRun[] {
    return this.agentRuns.listActiveAgentRuns()
  }

  listArchivedAgentRuns(agentId?: string): AgentRun[] {
    return this.agentRuns.listArchivedAgentRuns(agentId)
  }

  pruneTrackRecordForAgent(agentId: string): void {
    this.agentRuns.pruneTrackRecordForAgent(agentId)
  }

  addAgentLesson(row: { agentId: string; lesson: string; evidence?: string; convId?: string }): void {
    this.agentRuns.addAgentLesson(row)
  }

  listAgentLessons(agentId: string, limit = 50): AgentLesson[] {
    return this.agentRuns.listAgentLessons(agentId, limit)
  }

  pruneAgentLessons(agentId: string): void {
    this.agentRuns.pruneAgentLessons(agentId)
  }

  addAgentSkill(row: { agentId: string; name: string; description?: string; procedure: string; source?: string }): void {
    this.agentRuns.addAgentSkill(row)
  }

  listAgentSkills(agentId: string, limit = 50): AgentSkill[] {
    return this.agentRuns.listAgentSkills(agentId, limit)
  }

  hasAgentSkillNamed(agentId: string, name: string): boolean {
    return this.agentRuns.hasAgentSkillNamed(agentId, name)
  }

  countAgentSkills(agentId: string): number {
    return this.agentRuns.countAgentSkills(agentId)
  }

  deleteAgentSkill(id: string): void {
    this.agentRuns.deleteAgentSkill(id)
  }

  pruneAgentSkills(agentId: string): void {
    this.agentRuns.pruneAgentSkills(agentId)
  }

  /** Writes the database to disk now, where the backend holds it in memory (sql.js, Android:
   *  POST /api/v1/daemon/flush, before the app's Quit kills the process or its service stops).
   *  true: everything written so far is on disk; false: the write failed (it is retried); null:
   *  nothing to do, as node:sqlite writes every change to the file itself. */
  flush(): boolean | null { return this.db.flush ? this.db.flush() : null }

  close(): void { this.db.close() }
}
