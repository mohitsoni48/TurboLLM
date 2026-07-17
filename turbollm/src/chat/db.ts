// Conversation + message persistence (spec 01 §4). Uses node:sqlite (Node 22+).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
  /** Whether the composer's "isolate in a worktree" tickbox was checked. */
  useWorktree?: boolean
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

const RANGE_WINDOW_DAYS: Record<'30d' | '7d', number> = { '30d': 30, '7d': 7 }

const TOKEN_MILESTONES = [
  1_000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000,
  10_000_000, 50_000_000, 100_000_000, 500_000_000, 1_000_000_000,
]

/** "gemma 4 e4b|Q6_K|6217256480" -> "Gemma 4 E4b". Good enough for a dashboard label —
 *  the model may since have been renamed/deleted, so this derives purely from the stored
 *  key rather than cross-referencing the live model list. */
function titleCaseModelName(modelKey: string): string {
  const raw = modelKey.split('|')[0] ?? modelKey
  return raw.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Local calendar date key ("YYYY-MM-DD") for a timestamp — this daemon and its user are
 *  always the same machine, so local time (not UTC) is what "today"/"yesterday" means.
 *  Shared by tokenUsageStats and codeStats so both bucket days identically. */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `key` shifted by `n` local calendar days (negative goes back). */
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** Counts +/- lines in a unified diff (skips the +++/--- file-header lines, which start with
 *  the same characters but aren't real changes) — server-side twin of CodeTranscript.tsx's own
 *  diffStats, used to aggregate real "diff shipped" totals for the Code activity stats. */
function countDiffLines(diff: string): { add: number; del: number } {
  let add = 0, del = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
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
  /** Code mode only (pi's edit tool result) — a display-oriented diff and a standard unified
   *  patch of the change. Persisted so the diff panel and revert-to-message (code-routes.ts's
   *  revert endpoint) both still have this after a page reload, not just on the live SSE
   *  stream that produced it. */
  diff?: string
  patch?: string
  firstChangedLine?: number
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

interface ConvRow { id: string; title: string; system_prompt: string; model_key: string; sampling: string; expert_mode: number; tool_policy: string | null; kind: string | null; folder_id: string | null; tool_overrides: string | null; agent_id: string | null; completed_at: string | null; read_scope: string | null; agent_mode: string | null; skill_ids: string | null; allowed_tools: string | null; preserve_thinking: number; created_at: string; updated_at: string }
interface AgentRunRow { id: string; conv_id: string; title: string; status: string; allowed_tools: string; agent_id: string | null; error: string | null; created_at: string; updated_at: string; started_at: string | null; ended_at: string | null; archived_at: string | null; completion: string | null; repo_root: string | null; repo_branch: string | null; use_worktree: number | null; worktree_branch: string | null; worktree_base: string | null; lines_added: number | null; lines_removed: number | null; compaction_summary: string | null; compaction_upto_message_id: string | null; compaction_tokens_before: number | null; cleared_upto_message_id: string | null; reverted_from_message_id: string | null; title_auto_synced: number | null }
interface FolderRow { id: string; name: string; sort_order: number; created_at: string; updated_at: string }
interface MsgRow  { id: string; conv_id: string; seq: number; role: 'user' | 'assistant'; content: string; reasoning: string; attachments: string; text_attachments: string | null; tool_calls: string | null; timeline: string | null; stats: string; model_key: string | null; research_meta: string | null; created_at: string; variant_group: string | null; is_active: number; branch_of: string | null; edited: number }

// node:sqlite named-param objects need an explicit cast to Record<string, SQLInputValue>
type P = Record<string, SQLInputValue>

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return {} } }

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
  return { id: r.id, title: r.title, systemPrompt: r.system_prompt, modelKey: r.model_key, sampling: safeJson(r.sampling) as Record<string, unknown>, expertMode: r.expert_mode === 1, toolPolicy: r.tool_policy ?? undefined, kind: (r.kind === 'agent' ? 'agent' : r.kind === 'code' ? 'code' : 'chat'), folderId: r.folder_id ?? null, toolOverrides: safeToolOverrides(r.tool_overrides), agentId: r.agent_id ?? undefined, completedAt: r.completed_at ?? undefined, readScope: r.read_scope ? (safeJson(r.read_scope) as string[]) : undefined, agentMode: r.agent_mode ?? undefined, skillIds: r.skill_ids ? (safeJson(r.skill_ids) as string[]) : undefined, allowedTools: r.allowed_tools ? (safeJson(r.allowed_tools) as string[]) : undefined, preserveThinking: r.preserve_thinking === 1, createdAt: r.created_at, updatedAt: r.updated_at }
}

function rowToFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at }
}

function rowToAgentRun(r: AgentRunRow): AgentRun {
  return {
    id: r.id, convId: r.conv_id, title: r.title,
    status: r.status as AgentRun['status'],
    allowedTools: safeJson(r.allowed_tools) as string[],
    agentId: r.agent_id ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
    startedAt: r.started_at ?? undefined, endedAt: r.ended_at ?? undefined,
    archivedAt: r.archived_at ?? undefined,
    completion: (r.completion as AgentRun['completion']) ?? undefined,
    repoRoot: r.repo_root ?? undefined,
    repoBranch: r.repo_branch ?? undefined,
    useWorktree: r.use_worktree === null ? undefined : r.use_worktree === 1,
    worktreeBranch: r.worktree_branch ?? undefined,
    worktreeBase: r.worktree_base ?? undefined,
    linesAdded: r.lines_added ?? undefined,
    linesRemoved: r.lines_removed ?? undefined,
    compactionSummary: r.compaction_summary ?? undefined,
    compactionUpToMessageId: r.compaction_upto_message_id ?? undefined,
    compactionTokensBefore: r.compaction_tokens_before ?? undefined,
    clearedUpToMessageId: r.cleared_upto_message_id ?? undefined,
    revertedFromMessageId: r.reverted_from_message_id ?? undefined,
    titleAutoSynced: r.title_auto_synced === 1,
  }
}

function rowToMsg(r: MsgRow): Message {
  const msg: Message = { id: r.id, convId: r.conv_id, seq: r.seq, role: r.role, content: r.content, reasoning: r.reasoning, attachments: safeJson(r.attachments) as string[], textAttachments: r.text_attachments ? safeJson(r.text_attachments) as string[] : [], toolCalls: r.tool_calls ? safeJson(r.tool_calls) as ToolCallRecord[] : [], stats: safeJson(r.stats) as Partial<MessageStats>, createdAt: r.created_at, variantGroup: r.variant_group, isActive: r.is_active !== 0, branchOf: r.branch_of, edited: r.edited === 1 }
  if (r.research_meta) msg.researchMeta = safeJson(r.research_meta) as ResearchMeta
  if (r.timeline) msg.timeline = safeJson(r.timeline) as MessageTimelineBlock[]
  return msg
}

interface Changes { changes: number }

export class ConversationStore {
  private db: DatabaseSync

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, 'turbollm.db'))
    this.migrate()
  }

  /** Whether `table` already has `column` — guards ADD COLUMN migrations that may have
   *  already run under an earlier version number (this branch's migration ladder has
   *  been renumbered more than once across its history; a stored user_version can lag
   *  behind columns a prior run already added). */
  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some((r) => r.name === column)
  }

  private migrate(): void {
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`)
    const { user_version: v } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat',
          system_prompt TEXT NOT NULL DEFAULT '', model_key TEXT NOT NULL DEFAULT '',
          sampling TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content TEXT NOT NULL, reasoning TEXT NOT NULL DEFAULT '',
          attachments TEXT NOT NULL DEFAULT '[]', stats TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL, UNIQUE (conv_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, seq);
        PRAGMA user_version = 1;
      `)
    }
    // v2 (spec 04 §5): attribute each assistant reply to the model that produced it
    // so the Models screen can show last-session gen t/s per model. Nullable — old
    // rows stay NULL and are simply not counted (non-breaking).
    if (v < 2) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN model_key TEXT;
        CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model_key, created_at);
        PRAGMA user_version = 2;
      `)
    }
    // v3 (spec 08 §2): mark the built-in TurboLLM Expert thread so its server-managed
    // system prompt stays hidden from the UI. Additive — existing conversations get 0.
    if (v < 3) {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN expert_mode INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 3;
      `)
    }
    // v4 (spec 07 §9b): store text-file attachment filenames on user messages so the
    // UI can render file chips in the sent bubble. Nullable — existing rows get NULL
    // and are decoded as [] in rowToMsg (non-breaking).
    if (v < 4) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN text_attachments TEXT;
        PRAGMA user_version = 4;
      `)
    }
    // v5 (v0.7.0 agentic): store tool call records on assistant messages so the UI
    // can render tool invocations + results inline. Nullable — existing rows get NULL
    // and are decoded as [] in rowToMsg (non-breaking).
    if (v < 5) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN tool_calls TEXT;
        PRAGMA user_version = 5;
      `)
    }
    // v6 (v0.7.0 agentic): per-conversation tool policy. 'force_web_search' forces
    // the model to call web_search on the first iteration. Nullable — existing rows
    // get NULL and default to standard auto tool_choice (non-breaking).
    if (v < 6) {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN tool_policy TEXT;
        PRAGMA user_version = 6;
      `)
    }
    // v7 (F-021/F-022): research metadata — confidence score, ranked sources, and
    // referee verdicts stored as JSON alongside the assistant message. Nullable —
    // only set on Research-persona replies that use the retrieval service.
    if (v < 7) {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN research_meta TEXT;
        PRAGMA user_version = 7;
      `)
    }
    // v8 (ADR-112): background agent runs table. Each run maps to a dedicated
    // conversation of kind='agent'. Ring buffer events are in-memory only;
    // this table stores the durable run record and status.
    if (v < 8) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT 'Agent run',
          status TEXT NOT NULL DEFAULT 'queued',
          allowed_tools TEXT NOT NULL DEFAULT '[]',
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, created_at);
        PRAGMA user_version = 8;
      `)
    }
    // v9 (ADR-112): conversations.kind column — 'chat' (default) or 'agent'.
    // Agent conversations are owned by a run and excluded from the chat sidebar.
    if (v < 9) {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
        PRAGMA user_version = 9;
      `)
    }
    // v10: chat folders. Flat (no nesting) — conversations reference a folder via the
    // nullable folder_id column. Deleting a folder UNASSIGNS its members (folder_id set
    // to NULL in app code — see deleteFolder), it never cascade-deletes conversations,
    // so no inline REFERENCES/ON DELETE constraint is added here. sort_order is reserved
    // for a future drag-to-reorder; folders currently list in insertion order.
    if (v < 10) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        ALTER TABLE conversations ADD COLUMN folder_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_conversations_folder ON conversations(folder_id);
        PRAGMA user_version = 10;
      `)
    }
    // v11 (tool-call approval gate): per-conversation "Allow for this chat" overrides,
    // persisted as JSON so they survive a restart. Nullable — existing rows get NULL
    // and are decoded as {} in rowToConv (non-breaking).
    if (v < 11) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN tool_overrides TEXT")
      this.db.exec("PRAGMA user_version = 11")
    }
    // v12: agent_runs.agent_id — link runs to the AgentType config.
    // Additive column; existing rows get NULL (backwards-compatible with pre-agent-id runs).
    if (v < 12) {
      this.db.exec(`
        ALTER TABLE agent_runs ADD COLUMN agent_id TEXT;
        PRAGMA user_version = 12;
      `)
    }
    // v13 (spec 13 §13): the durable working doc — one current doc per run. Survives
    // /compact (it is NOT part of the compressible transcript). Cascades on run delete.
    if (v < 13) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_docs (
          run_id     TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
          content    TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 13;
      `)
    }
    // v14 (spec 13 §13): per-Hitman track record — one row per finished contract
    // (incl. first-try successes). agent_id is a config id (not a DB FK); run_id cascades.
    if (v < 14) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_track_record (
          id          TEXT PRIMARY KEY,
          agent_id    TEXT NOT NULL,
          run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          model       TEXT NOT NULL,
          outcome     TEXT NOT NULL,
          feedback    TEXT,
          ran_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_track_agent ON agent_track_record(agent_id);
        PRAGMA user_version = 14;
      `)
    }
    // v15 (spec 13 §13): archive + completion outcome on the run row.
    if (v < 15) {
      this.db.exec(`
        ALTER TABLE agent_runs ADD COLUMN archived_at TEXT;
        ALTER TABLE agent_runs ADD COLUMN completion TEXT;
        PRAGMA user_version = 15;
      `)
    }
    // v16 (spec 13 redesign §1): bind a CHAT conversation to an Agent. Null = a plain
    // chat (no agent, no FS/tools). Additive; existing chats get NULL = unchanged behavior.
    if (v < 16) {
      if (!this.hasColumn('conversations', 'agent_id')) this.db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT;`)
      this.db.exec(`PRAGMA user_version = 16;`)
    }
    // v17 (spec 13 redesign §2/§3): completion marker on a conversation + the per-agent
    // lessons store (Reflexion). completed_at null = in-progress. agent_lessons is keyed by
    // the config agent id (not a DB FK); pruned when the agent is deleted.
    if (v < 17) {
      if (!this.hasColumn('conversations', 'completed_at')) this.db.exec(`ALTER TABLE conversations ADD COLUMN completed_at TEXT;`)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_lessons (
          id         TEXT PRIMARY KEY,
          agent_id   TEXT NOT NULL,
          lesson     TEXT NOT NULL,
          evidence   TEXT,
          conv_id    TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lessons_agent ON agent_lessons(agent_id, created_at);
        PRAGMA user_version = 17;
      `)
    }
    // v18 (spec 13 redesign §3.3): per-agent SKILLS grown from experience (Voyager) — a
    // distilled name + description + procedure, injected on future runs. Keyed by config
    // agent id (not a DB FK); pruned on agent delete.
    if (v < 18) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_skills (
          id          TEXT PRIMARY KEY,
          agent_id    TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          procedure   TEXT NOT NULL,
          source      TEXT,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skills_agent ON agent_skills(agent_id, created_at);
        PRAGMA user_version = 18;
      `)
    }
    // v19 (spec 13 redesign): per-conversation read scope — JSON array of file/folder paths
    // the bound agent may read. Read access is chat-bound (attached via picker), not agent-bound.
    if (v < 19) {
      if (!this.hasColumn('conversations', 'read_scope')) this.db.exec(`ALTER TABLE conversations ADD COLUMN read_scope TEXT;`)
      this.db.exec(`PRAGMA user_version = 19;`)
    }
    // v20: per-conversation pi permission mode ('ask'|'auto'|'bypass'|'read'). Null = 'auto'.
    if (v < 20) {
      if (!this.hasColumn('conversations', 'agent_mode')) this.db.exec(`ALTER TABLE conversations ADD COLUMN agent_mode TEXT;`)
      this.db.exec(`PRAGMA user_version = 20;`)
    }
    // v21: skill ids enabled for a conversation (JSON string[]) — the shared SKILL.md
    // library injected into chat directly, replacing the agent-bound tool/skill picker.
    if (v < 21) {
      if (!this.hasColumn('conversations', 'skill_ids')) this.db.exec(`ALTER TABLE conversations ADD COLUMN skill_ids TEXT;`)
      this.db.exec(`PRAGMA user_version = 21;`)
    }
    // v22 (Customize → Agents): tool-name allow-list baked in from a custom chat
    // Agent at conversation creation (JSON string[]). Null/absent = unrestricted —
    // built-in personas never set this, preserving today's behavior byte-for-byte.
    if (v < 22) {
      if (!this.hasColumn('conversations', 'allowed_tools')) this.db.exec(`ALTER TABLE conversations ADD COLUMN allowed_tools TEXT;`)
      this.db.exec(`PRAGMA user_version = 22;`)
    }
    // v23 (GitHub #52 item 2 — chat branching): regenerating a reply used to delete it
    // outright. Now the old message is kept and deactivated instead — `variant_group`
    // groups a message with its regenerated siblings (defaults to the group's own first
    // message id), `is_active` marks which one is currently shown/sent as history.
    // Existing rows default to is_active=1, variant_group=NULL (no branch UI for them).
    if (v < 23) {
      if (!this.hasColumn('messages', 'variant_group')) this.db.exec(`ALTER TABLE messages ADD COLUMN variant_group TEXT;`)
      if (!this.hasColumn('messages', 'is_active')) this.db.exec(`ALTER TABLE messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`)
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_variant_group ON messages(conv_id, variant_group);`)
      this.db.exec(`PRAGMA user_version = 23;`)
    }
    // v24 (GitHub #52 item 2, extended to user-message edits): editing an earlier user
    // message used to hard-delete everything after it. Now that whole downstream tail is
    // frozen (deactivated) instead, tagged with `branch_of` = the specific message version
    // it was frozen under, so switching back to that version can restore exactly what was
    // there — including whichever regenerate-sibling (variant_group) was active within it.
    if (v < 24) {
      if (!this.hasColumn('messages', 'branch_of')) this.db.exec(`ALTER TABLE messages ADD COLUMN branch_of TEXT;`)
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_branch_of ON messages(conv_id, branch_of);`)
      this.db.exec(`PRAGMA user_version = 24;`)
    }
    // v25 (GitHub #52 item 1): per-conversation "preserve thinking across turns" toggle.
    // Off by default — matches today's behavior, where only the final visible content of
    // past turns is ever resent to the engine, never raw reasoning.
    if (v < 25) {
      if (!this.hasColumn('conversations', 'preserve_thinking')) this.db.exec(`ALTER TABLE conversations ADD COLUMN preserve_thinking INTEGER NOT NULL DEFAULT 0;`)
      this.db.exec(`PRAGMA user_version = 25;`)
    }
    // v26: "Edited" tag — set only when a user explicitly edits an assistant reply's text
    // in place (the PUT /messages/:msgId assistant-role path), never by the normal
    // generation-completion save, so it means what it says.
    if (v < 26) {
      if (!this.hasColumn('messages', 'edited')) this.db.exec(`ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;`)
      this.db.exec(`PRAGMA user_version = 26;`)
    }
    // v27 (Release 3, auto-memory): durable facts extracted from the user's own chat
    // messages, injected into future new conversations. No FK to conversations — deleting
    // a source chat shouldn't delete the fact it produced (same provenance-column pattern
    // as agent_lessons above).
    if (v < 27) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_facts (
          id             TEXT PRIMARY KEY,
          fact_text      TEXT NOT NULL,
          source_conv_id TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_facts_created ON memory_facts(created_at);
        PRAGMA user_version = 27;
      `)
    }
    // v28 (Code, real pi-SDK agent): a 'code'-kind run stores the scratch/repo folder it
    // runs against (the pi cwd + containment root), the sidebar branch label, and the
    // composer's worktree intent (captured but NOT acted on in Phase 1). Diff stat columns
    // default to 0 for Phase 1. All additive + nullable — existing agent_runs rows get NULL
    // and are decoded as undefined in rowToAgentRun (non-breaking). hasColumn-guarded because
    // this branch's migration ladder has been renumbered before (see hasColumn's comment).
    if (v < 28) {
      if (!this.hasColumn('agent_runs', 'repo_root'))       this.db.exec(`ALTER TABLE agent_runs ADD COLUMN repo_root TEXT;`)
      if (!this.hasColumn('agent_runs', 'repo_branch'))     this.db.exec(`ALTER TABLE agent_runs ADD COLUMN repo_branch TEXT;`)
      if (!this.hasColumn('agent_runs', 'use_worktree'))    this.db.exec(`ALTER TABLE agent_runs ADD COLUMN use_worktree INTEGER;`)
      if (!this.hasColumn('agent_runs', 'worktree_branch')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN worktree_branch TEXT;`)
      if (!this.hasColumn('agent_runs', 'worktree_base'))   this.db.exec(`ALTER TABLE agent_runs ADD COLUMN worktree_base TEXT;`)
      if (!this.hasColumn('agent_runs', 'lines_added'))     this.db.exec(`ALTER TABLE agent_runs ADD COLUMN lines_added INTEGER;`)
      if (!this.hasColumn('agent_runs', 'lines_removed'))   this.db.exec(`ALTER TABLE agent_runs ADD COLUMN lines_removed INTEGER;`)
      this.db.exec(`PRAGMA user_version = 28;`)
    }
    // v29 (Code, manual /compact): one active compaction per session — a summary plus the last
    // DB message id it covers. Not incremental (a second /compact re-summarizes everything up
    // to that point again, replacing the old summary), which keeps seedPriorHistory's replay
    // logic (code-session.ts) simple: at most one summary entry, then raw messages after it.
    if (v < 29) {
      if (!this.hasColumn('agent_runs', 'compaction_summary'))          this.db.exec(`ALTER TABLE agent_runs ADD COLUMN compaction_summary TEXT;`)
      if (!this.hasColumn('agent_runs', 'compaction_upto_message_id'))  this.db.exec(`ALTER TABLE agent_runs ADD COLUMN compaction_upto_message_id TEXT;`)
      if (!this.hasColumn('agent_runs', 'compaction_tokens_before'))    this.db.exec(`ALTER TABLE agent_runs ADD COLUMN compaction_tokens_before INTEGER;`)
      this.db.exec(`PRAGMA user_version = 29;`)
    }
    // v30 (Code, /clear + /resume): a soft "clear chat" marker — the last DB message id
    // covered by a clear, mirroring compaction_upto_message_id's shape but with no summary
    // text (a clear is a blank slate, not a summarized carry-forward). Null = never cleared,
    // or resumed back from one. resolveEffectiveHistory (code-session.ts) takes whichever of
    // this and the compaction cut point is later in the message sequence.
    if (v < 30) {
      if (!this.hasColumn('agent_runs', 'cleared_upto_message_id')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN cleared_upto_message_id TEXT;`)
      this.db.exec(`PRAGMA user_version = 30;`)
    }
    // v31 (Code, founder-reported gap 2026-07-13, item 6): an ordered text/tool-call timeline
    // for assistant messages, so a completed Code turn can render in TRUE chronological order
    // instead of today's fixed "reasoning → all tool calls grouped → final text" layout — the
    // persisted `content`+`toolCalls` shape has no interleave-position marker to reconstruct from.
    // JSON array of {type:'text',text} | {type:'tool',id} blocks (tool blocks reference an id in
    // `toolCalls` rather than duplicating it). Nullable — existing rows get NULL and the UI falls
    // back to the pre-fix grouped rendering for them (non-breaking, no backfill).
    if (v < 31) {
      if (!this.hasColumn('messages', 'timeline')) this.db.exec(`ALTER TABLE messages ADD COLUMN timeline TEXT;`)
      this.db.exec(`PRAGMA user_version = 31;`)
    }
    // v32 (Code, founder-reported gap 2026-07-14): a manual session rename used to silently
    // revert on the next completed turn — code-run-manager.ts's pump() unconditionally mirrored
    // conversations.title onto agent_runs.title after EVERY successful turn (auto-title's own
    // regeneration guard only stops conversations.title from changing again, not the mirror
    // re-applying that now-frozen value over a manual rename). Fix (founder-decided): the mirror
    // should only ever run ONCE, at the session's first successful turn, never again after,
    // regardless of any rename in between. 0/NULL = not yet synced; existing rows default to
    // NULL (their title may already have been mirrored under the old unconditional behavior —
    // treated as "not yet synced" is harmless, it just allows exactly one more mirror before
    // this fix's guard takes over for good).
    if (v < 32) {
      if (!this.hasColumn('agent_runs', 'title_auto_synced')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN title_auto_synced INTEGER;`)
      this.db.exec(`PRAGMA user_version = 32;`)
    }
    // v33 (Code, founder-reported bug 2026-07-17, found live against a real 40-message session):
    // revert-to-message previously reused clearedUpToMessageId (a movable prefix cursor), which
    // can only hide "everything before X, show everything after" — backwards from what a revert
    // needs (discard the reverted message and everything after it, keep everything before it),
    // and structurally incapable of that for any message that isn't already at the tail. Real
    // deactivation (is_active=0, the same mechanism Chat's branching already uses — getMessages()
    // filters is_active=1 unconditionally) fixes both: it needs a marker of its own so /resume
    // knows what to reactivate. Nullable — existing rows get NULL (never reverted).
    if (v < 33) {
      if (!this.hasColumn('agent_runs', 'reverted_from_message_id')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN reverted_from_message_id TEXT;`)
      this.db.exec(`PRAGMA user_version = 33;`)
    }
  }

  listConversations(q?: string, kind: 'chat' | 'agent' | 'all' = 'all'): Conversation[] {
    if (q) {
      const kindClause = kind !== 'all' ? ' AND c.kind = $kind' : ''
      const params = kind !== 'all' ? { $q: `%${q}%`, $kind: kind } : { $q: `%${q}%` }
      const rows = this.db.prepare(`
        SELECT DISTINCT c.* FROM conversations c
        LEFT JOIN messages m ON m.conv_id = c.id
        WHERE (c.title LIKE $q OR m.content LIKE $q)${kindClause}
        ORDER BY c.updated_at DESC LIMIT 200
      `).all(params as P) as unknown as ConvRow[]
      return rows.map(rowToConv)
    }
    if (kind !== 'all') {
      return (this.db.prepare(`SELECT * FROM conversations WHERE kind = $kind ORDER BY updated_at DESC LIMIT 200`).all({ $kind: kind } as P) as unknown as ConvRow[]).map(rowToConv)
    }
    return (this.db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200`).all() as unknown as ConvRow[]).map(rowToConv)
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
    const params: Record<string, SQLInputValue> = { $id: id, $now: now }
    if (patch.title !== undefined)        { sets.push('title = $title');      params.$title = patch.title }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = $sp'); params.$sp    = patch.systemPrompt }
    if (patch.sampling !== undefined)     { sets.push('sampling = $samp');    params.$samp  = JSON.stringify(patch.sampling) }
    if (patch.modelKey !== undefined)     { sets.push('model_key = $mk');     params.$mk    = patch.modelKey }
    if (patch.skillIds !== undefined)     { sets.push('skill_ids = $sk');     params.$sk    = JSON.stringify(patch.skillIds) }
    if (patch.preserveThinking !== undefined) { sets.push('preserve_thinking = $pt'); params.$pt = patch.preserveThinking ? 1 : 0 }
    return ((this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
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

  addMessage(convId: string, role: 'user' | 'assistant', content: string, extra?: Partial<Pick<Message, 'reasoning' | 'attachments' | 'textAttachments' | 'toolCalls' | 'stats' | 'variantGroup'>>): Message {
    const id = randomUUID()
    const now = new Date().toISOString()
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS ms FROM messages WHERE conv_id = $id`).get({ $id: convId } as P) as unknown as { ms: number }
    // Attribute assistant replies to the conversation's model so the Models screen
    // can surface last-session gen t/s (spec 04 §5). User turns are left NULL.
    const modelKey = role === 'assistant' ? this.conversationModelKey(convId) : null
    const textAttachments = extra?.textAttachments?.length ? JSON.stringify(extra.textAttachments) : null
    const toolCalls = extra?.toolCalls?.length ? JSON.stringify(extra.toolCalls) : null
    this.db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,reasoning,attachments,text_attachments,tool_calls,stats,model_key,created_at,variant_group,is_active) VALUES ($id,$cid,$seq,$role,$content,$reasoning,$attachments,$ta,$tc,$stats,$mk,$now,$vg,1)`)
      .run({ $id: id, $cid: convId, $seq: row.ms + 1, $role: role, $content: content, $reasoning: extra?.reasoning ?? '', $attachments: JSON.stringify(extra?.attachments ?? []), $ta: textAttachments, $tc: toolCalls, $stats: JSON.stringify(extra?.stats ?? {}), $mk: modelKey, $now: now, $vg: extra?.variantGroup ?? null } as P)
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

  updateMessage(id: string, patch: Partial<Pick<Message, 'content' | 'reasoning' | 'toolCalls' | 'timeline' | 'stats' | 'researchMeta' | 'edited'>>): boolean {
    const sets: string[] = []
    const params: Record<string, SQLInputValue> = { $id: id }
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

  /** Most-recent assistant gen t/s per model (spec 04 §5 `lastTps`). For each
   *  model_key, takes the newest assistant message that recorded a positive
   *  `stats.tps` and returns its value. Rows with NULL model_key (pre-v2) or no
   *  usable t/s are skipped. Returns an empty map when there's no chat history. */
  lastGenTpsByModel(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT model_key, stats FROM messages
      WHERE role = 'assistant' AND model_key IS NOT NULL
      ORDER BY created_at DESC, seq DESC
    `).all() as unknown as { model_key: string; stats: string }[]
    const out = new Map<string, number>()
    for (const r of rows) {
      if (out.has(r.model_key)) continue // rows are newest-first → newest valid wins
      const tps = (safeJson(r.stats) as Partial<MessageStats>).tps
      if (typeof tps === 'number' && tps > 0) out.set(r.model_key, Math.round(tps * 10) / 10)
    }
    return out
  }

  /** Token usage dashboard (Release 3): sessions/messages/tokens/active-days scoped to
   *  `range`, lifetime streaks (a streak isn't a "last N days" concept), the local hour
   *  with the most activity, a per-model breakdown, and the heatmap day buckets — all from
   *  one pass over `messages`. Days are bucketed by LOCAL calendar date (this daemon and its
   *  user are always the same machine), not UTC, so a late-night session lands on the day
   *  the user actually thinks of as "today". */
  tokenUsageStats(range: TokenUsageRange = 'all'): TokenUsageStats {
    const rows = this.db.prepare(`
      SELECT conv_id, created_at, stats, model_key FROM messages
      WHERE role = 'assistant'
      ORDER BY created_at ASC
    `).all() as unknown as { conv_id: string; created_at: string; stats: string; model_key: string | null }[]

    if (rows.length === 0) {
      return {
        range, sessions: 0, messages: 0, totalTokens: 0, activeDays: 0,
        currentStreak: 0, longestStreak: 0, peakHour: null, favoriteModel: null,
        firstMessageAt: null, lifetimeTotalTokens: 0, milestone: { achieved: null, next: null, progressPct: null },
        activity: { granularityHours: 24, buckets: [] }, dailyByModel: [], byModel: [],
      }
    }

    // Per-local-day totals across the FULL history — needed for the lifetime streaks
    // regardless of `range`, and reused below for the heatmap window.
    const dayBuckets = new Map<string, { promptTokens: number; genTokens: number; messageCount: number }>()
    const firstMessageAt = rows[0].created_at
    for (const r of rows) {
      const key = dayKey(r.created_at)
      const b = dayBuckets.get(key) ?? { promptTokens: 0, genTokens: 0, messageCount: 0 }
      const s = safeJson(r.stats) as Partial<MessageStats>
      b.promptTokens += typeof s.promptTokens === 'number' ? s.promptTokens : 0
      b.genTokens += typeof s.genTokens === 'number' ? s.genTokens : 0
      b.messageCount++
      dayBuckets.set(key, b)
    }

    const todayKey = dayKey(new Date().toISOString())
    const firstKey = dayKey(firstMessageAt)

    let longestStreak = 0, run = 0
    for (let key = firstKey; key <= todayKey; key = addDays(key, 1)) {
      if (dayBuckets.has(key)) { run++; longestStreak = Math.max(longestStreak, run) } else { run = 0 }
    }
    let currentStreak = 0
    {
      // Grace period: if today has no activity yet, the streak isn't broken until
      // tomorrow — check from yesterday instead of reporting 0 the moment you wake up.
      let key = dayBuckets.has(todayKey) ? todayKey : addDays(todayKey, -1)
      while (key >= firstKey && dayBuckets.has(key)) { currentStreak++; key = addDays(key, -1) }
    }

    // "all" always shows at least 180 days of boxes (GitHub-graph convention, scaled
    // down) — a brand-new account pads out with empty cells before its first message
    // instead of rendering a tiny, sparse-looking grid. An account older than that still
    // shows its full real history (never truncated).
    const minAllStart = addDays(todayKey, -179)
    const heatStart = range === 'all'
      ? (firstKey < minAllStart ? firstKey : minAllStart)
      : addDays(todayKey, -(RANGE_WINDOW_DAYS[range] - 1))
    // String comparison is safe and deliberately used over Date parsing here — both sides
    // are zero-padded "YYYY-MM-DD" keys, and `new Date("YYYY-MM-DD")` parses as UTC
    // midnight (not local), a classic footgun this sidesteps entirely.
    const scopedRows = range === 'all' ? rows : rows.filter((r) => dayKey(r.created_at) >= heatStart)

    const convIds = new Set<string>()
    const hourTally = new Map<number, number>()
    const modelTally = new Map<string, { messageCount: number; promptTokens: number; genTokens: number }>()
    const dayModelTally = new Map<string, Map<string, number>>()
    let totalTokens = 0
    for (const r of scopedRows) {
      convIds.add(r.conv_id)
      const s = safeJson(r.stats) as Partial<MessageStats>
      const pt = typeof s.promptTokens === 'number' ? s.promptTokens : 0
      const gt = typeof s.genTokens === 'number' ? s.genTokens : 0
      totalTokens += pt + gt
      const hour = new Date(r.created_at).getHours()
      hourTally.set(hour, (hourTally.get(hour) ?? 0) + 1)
      if (r.model_key) {
        const m = modelTally.get(r.model_key) ?? { messageCount: 0, promptTokens: 0, genTokens: 0 }
        m.messageCount++; m.promptTokens += pt; m.genTokens += gt
        modelTally.set(r.model_key, m)

        const day = dayKey(r.created_at)
        const dm = dayModelTally.get(day) ?? new Map<string, number>()
        dm.set(r.model_key, (dm.get(r.model_key) ?? 0) + pt + gt)
        dayModelTally.set(day, dm)
      }
    }

    let peakHour: number | null = null, peakHourCount = -1
    for (const [hour, count] of hourTally) if (count > peakHourCount) { peakHour = hour; peakHourCount = count }

    const byModel: ModelUsage[] = [...modelTally.entries()]
      .map(([modelKey, m]) => ({
        modelKey, displayName: titleCaseModelName(modelKey),
        messageCount: m.messageCount, promptTokens: m.promptTokens, genTokens: m.genTokens,
        totalTokens: m.promptTokens + m.genTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)

    const days: TokenUsageDay[] = []
    const dailyByModel: DailyModelBreakdown[] = []
    let activeDays = 0
    for (let key = heatStart; key <= todayKey; key = addDays(key, 1)) {
      const b = dayBuckets.get(key)
      if (b && b.messageCount > 0) activeDays++
      const dayTotalTokens = (b?.promptTokens ?? 0) + (b?.genTokens ?? 0)
      days.push({
        date: key,
        promptTokens: b?.promptTokens ?? 0, genTokens: b?.genTokens ?? 0,
        totalTokens: dayTotalTokens, messageCount: b?.messageCount ?? 0,
      })
      const dm = dayModelTally.get(key)
      dailyByModel.push({
        date: key, totalTokens: dayTotalTokens,
        byModel: dm ? [...dm.entries()].map(([modelKey, tokens]) => ({ modelKey, tokens })) : [],
      })
    }

    // Overview heatmap: box granularity zooms in as the range narrows so the grid stays
    // visually dense (a 7-cell or 30-cell day-level grid looks broken/sparse) — 1h boxes
    // for 7d, 12h boxes for 30d, 1-day boxes (the classic GitHub-style grid) for all.
    let activity: TokenActivity
    if (range === 'all') {
      activity = {
        granularityHours: 24,
        buckets: days.map((d) => ({ start: d.date, totalTokens: d.totalTokens, messageCount: d.messageCount })),
      }
    } else {
      const granularityHours = range === '7d' ? 1 : 12
      const subTally = new Map<string, { totalTokens: number; messageCount: number }>()
      for (const r of scopedRows) {
        const d = new Date(r.created_at)
        const day = dayKey(r.created_at)
        const bucketKey = granularityHours === 1
          ? `${day}T${String(d.getHours()).padStart(2, '0')}`
          : `${day}-${d.getHours() < 12 ? 'AM' : 'PM'}`
        const s = safeJson(r.stats) as Partial<MessageStats>
        const pt = typeof s.promptTokens === 'number' ? s.promptTokens : 0
        const gt = typeof s.genTokens === 'number' ? s.genTokens : 0
        const b = subTally.get(bucketKey) ?? { totalTokens: 0, messageCount: 0 }
        b.totalTokens += pt + gt; b.messageCount++
        subTally.set(bucketKey, b)
      }
      const buckets: ActivityBucket[] = []
      for (let key = heatStart; key <= todayKey; key = addDays(key, 1)) {
        if (granularityHours === 1) {
          for (let h = 0; h < 24; h++) {
            const bucketKey = `${key}T${String(h).padStart(2, '0')}`
            const b = subTally.get(bucketKey)
            buckets.push({ start: bucketKey, totalTokens: b?.totalTokens ?? 0, messageCount: b?.messageCount ?? 0 })
          }
        } else {
          for (const half of ['AM', 'PM'] as const) {
            const bucketKey = `${key}-${half}`
            const b = subTally.get(bucketKey)
            buckets.push({ start: bucketKey, totalTokens: b?.totalTokens ?? 0, messageCount: b?.messageCount ?? 0 })
          }
        }
      }
      activity = { granularityHours, buckets }
    }

    let lifetimeTotalTokens = 0
    for (const b of dayBuckets.values()) lifetimeTotalTokens += b.promptTokens + b.genTokens
    const achieved = [...TOKEN_MILESTONES].reverse().find((m) => m <= lifetimeTotalTokens) ?? null
    const next = TOKEN_MILESTONES.find((m) => m > lifetimeTotalTokens) ?? null
    const progressPct = next !== null
      ? Math.round(((lifetimeTotalTokens - (achieved ?? 0)) / (next - (achieved ?? 0))) * 1000) / 10
      : null

    return {
      range, sessions: convIds.size, messages: scopedRows.length, totalTokens, activeDays,
      currentStreak, longestStreak, peakHour,
      favoriteModel: byModel[0]?.displayName ?? null,
      firstMessageAt, lifetimeTotalTokens, milestone: { achieved, next, progressPct },
      activity, dailyByModel, byModel,
    }
  }

  /** Code launchpad's "Coding activity" stats — real numbers, replacing code-mock.ts's
   *  CODE_STATS/mockSessionDays (which were always fake). Mirrors tokenUsageStats' own
   *  day-bucket/streak/range pattern closely (dayKey/addDays are the same shared helpers) —
   *  everything computed fresh from agent_runs + messages on each call, not from a maintained
   *  running counter, so it's always internally consistent with whatever data actually exists. */
  codeStats(range: CodeStatsRange = 'all'): CodeStatsResult {
    const runs = this.db.prepare(`
      SELECT ar.id, ar.status, ar.created_at, c.model_key
      FROM agent_runs ar JOIN conversations c ON c.id = ar.conv_id
      WHERE c.kind = 'code'
      ORDER BY ar.created_at ASC
    `).all() as unknown as { id: string; status: string; created_at: string; model_key: string }[]

    if (runs.length === 0) {
      return {
        range, sessions: 0, tasksShipped: 0, filesTouched: 0, diffAdded: 0, diffRemoved: 0,
        activeDays: 0, currentStreak: 0, longestStreak: 0, favoriteModel: null, heatmap: [],
      }
    }

    // Per-local-day run counts across the FULL history — needed for lifetime streaks
    // regardless of `range`, and reused below for the heatmap window.
    const dayBuckets = new Map<string, number>()
    for (const r of runs) {
      const key = dayKey(r.created_at)
      dayBuckets.set(key, (dayBuckets.get(key) ?? 0) + 1)
    }
    const firstKey = dayKey(runs[0].created_at)
    const todayKey = dayKey(new Date().toISOString())

    let longestStreak = 0, run = 0
    for (let key = firstKey; key <= todayKey; key = addDays(key, 1)) {
      if (dayBuckets.has(key)) { run++; longestStreak = Math.max(longestStreak, run) } else { run = 0 }
    }
    let currentStreak = 0
    {
      // Grace period: if today has no session yet, the streak isn't broken until tomorrow.
      let key = dayBuckets.has(todayKey) ? todayKey : addDays(todayKey, -1)
      while (key >= firstKey && dayBuckets.has(key)) { currentStreak++; key = addDays(key, -1) }
    }

    const minAllStart = addDays(todayKey, -179)
    const heatStart = range === 'all'
      ? (firstKey < minAllStart ? firstKey : minAllStart)
      : addDays(todayKey, -(RANGE_WINDOW_DAYS[range] - 1))

    const scopedRuns = range === 'all' ? runs : runs.filter((r) => dayKey(r.created_at) >= heatStart)

    const modelTally = new Map<string, number>()
    let tasksShipped = 0
    const activeDaySet = new Set<string>()
    for (const r of scopedRuns) {
      if (r.status === 'done') tasksShipped++
      if (r.model_key) modelTally.set(r.model_key, (modelTally.get(r.model_key) ?? 0) + 1)
      activeDaySet.add(dayKey(r.created_at))
    }
    let favoriteModelKey: string | null = null, favoriteCount = -1
    for (const [k, n] of modelTally) if (n > favoriteCount) { favoriteModelKey = k; favoriteCount = n }

    const heatmap: CodeStatsDay[] = []
    for (let key = heatStart; key <= todayKey; key = addDays(key, 1)) {
      heatmap.push({ date: key, sessions: dayBuckets.get(key) ?? 0 })
    }

    // filesTouched + diffAdded/diffRemoved: scoped by each MESSAGE's own created_at (when the
    // tool call actually ran), not the owning run's — a long session's later turns land on a
    // later day than its first message, so this is the more honest scoping of the two.
    const msgRows = this.db.prepare(`
      SELECT m.created_at, m.tool_calls FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE c.kind = 'code' AND m.role = 'assistant' AND m.tool_calls IS NOT NULL
    `).all() as unknown as { created_at: string; tool_calls: string }[]

    const filePaths = new Set<string>()
    let diffAdded = 0, diffRemoved = 0
    for (const r of msgRows) {
      if (range !== 'all' && dayKey(r.created_at) < heatStart) continue
      const calls = safeJson(r.tool_calls) as ToolCallRecord[] | undefined
      if (!Array.isArray(calls)) continue
      for (const tc of calls) {
        const path = typeof tc.args?.path === 'string' ? tc.args.path : undefined
        if (path && (tc.name === 'edit' || tc.name === 'write')) filePaths.add(path)
        if (tc.name === 'edit' && tc.diff) {
          const { add, del } = countDiffLines(tc.diff)
          diffAdded += add
          diffRemoved += del
        }
      }
    }

    return {
      range, sessions: scopedRuns.length, tasksShipped, filesTouched: filePaths.size,
      diffAdded, diffRemoved, activeDays: activeDaySet.size, currentStreak, longestStreak,
      favoriteModel: favoriteModelKey ? titleCaseModelName(favoriteModelKey) : null,
      heatmap,
    }
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
   *  establish its variant_group (its own id) if this is its first regeneration. */
  deactivateMessage(id: string): void {
    this.db.prepare(`UPDATE messages SET is_active = 0, variant_group = COALESCE(variant_group, id) WHERE id = $id`).run({ $id: id } as P)
  }

  /** All siblings sharing a variant_group (active + inactive), oldest first — the full
   *  set the branch switcher UI (‹ 2/3 ›) needs. */
  getMessageVariants(variantGroup: string): Message[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE variant_group = $vg ORDER BY seq ASC`).all({ $vg: variantGroup } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  /** Switches which sibling in a variant group is the active/shown one. No-op (returns
   *  false) if targetId isn't actually a member of that group. */
  setActiveVariant(variantGroup: string, targetId: string): boolean {
    const target = this.getMessage(targetId)
    if (!target || target.variantGroup !== variantGroup) return false
    this.db.prepare(`UPDATE messages SET is_active = 0 WHERE variant_group = $vg`).run({ $vg: variantGroup } as P)
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
   *  inverse of freezeTail, used when switching back to that message version. */
  restoreTail(anchorId: string): void {
    this.db.prepare(`UPDATE messages SET is_active = 1 WHERE branch_of = $anchor`).run({ $anchor: anchorId } as P)
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

  // ── Agent run methods (v8 migration) ──────────────────────────────────────

  createAgentRun(params: { convId: string; title: string; allowedTools: string[]; agentId?: string; repoRoot?: string; repoBranch?: string; useWorktree?: boolean; worktreeBranch?: string; worktreeBase?: string }): AgentRun {
    const id = randomUUID()
    const now = new Date().toISOString()
    const agentId = params.agentId ?? null
    // Code runs carry repo/worktree metadata (v28); background 'agent' runs pass none of it
    // and every code column is written NULL (byte-identical to the pre-v28 insert for them).
    this.db.prepare(`INSERT INTO agent_runs (id,conv_id,title,status,allowed_tools,agent_id,repo_root,repo_branch,use_worktree,worktree_branch,worktree_base,lines_added,lines_removed,created_at,updated_at) VALUES ($id,$cid,$title,'queued',$at,$aid,$rr,$rb,$uw,$wb,$wbase,$la,$lr,$now,$now)`)
      .run({
        $id: id, $cid: params.convId, $title: params.title, $at: JSON.stringify(params.allowedTools), $aid: agentId,
        $rr: params.repoRoot ?? null,
        $rb: params.repoBranch ?? null,
        $uw: params.useWorktree === undefined ? null : (params.useWorktree ? 1 : 0),
        $wb: params.worktreeBranch ?? null,
        $wbase: params.worktreeBase ?? null,
        // Phase 1: diff stats are not computed yet — seed a code run's counters at 0 so the
        // sidebar shows +0/-0 rather than a blank; a background 'agent' run leaves them NULL.
        $la: params.repoRoot !== undefined ? 0 : null,
        $lr: params.repoRoot !== undefined ? 0 : null,
        $now: now,
      } as P)
    return this.getAgentRun(id)!
  }

  getAgentRun(id: string): AgentRun | null {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = $id`).get({ $id: id } as P) as unknown as AgentRunRow | undefined
    return row ? rowToAgentRun(row) : null
  }

  listAgentRuns(opts?: { statuses?: string[] }): AgentRun[] {
    if (opts?.statuses?.length) {
      const placeholders = opts.statuses.map((_, i) => `$s${i}`).join(',')
      const params: Record<string, SQLInputValue> = {}
      opts.statuses.forEach((s, i) => { params[`$s${i}`] = s })
      return (this.db.prepare(`SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT 200`).all(params) as unknown as AgentRunRow[]).map(rowToAgentRun)
    }
    return (this.db.prepare(`SELECT * FROM agent_runs ORDER BY updated_at DESC LIMIT 200`).all() as unknown as AgentRunRow[]).map(rowToAgentRun)
  }

  updateAgentRun(id: string, patch: Partial<Pick<AgentRun, 'status' | 'error' | 'startedAt' | 'endedAt' | 'title' | 'compactionSummary' | 'compactionUpToMessageId' | 'compactionTokensBefore' | 'titleAutoSynced'>>): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = $now']
    const params: Record<string, SQLInputValue> = { $id: id, $now: now }
    if (patch.status    !== undefined) { sets.push('status = $status');      params.$status  = patch.status }
    if (patch.error     !== undefined) { sets.push('error = $error');        params.$error   = patch.error }
    if (patch.startedAt !== undefined) { sets.push('started_at = $started'); params.$started = patch.startedAt }
    if (patch.endedAt   !== undefined) { sets.push('ended_at = $ended');     params.$ended   = patch.endedAt }
    if (patch.title     !== undefined) { sets.push('title = $title');       params.$title   = patch.title }
    if (patch.compactionSummary        !== undefined) { sets.push('compaction_summary = $csum');    params.$csum = patch.compactionSummary }
    if (patch.compactionUpToMessageId  !== undefined) { sets.push('compaction_upto_message_id = $cupto'); params.$cupto = patch.compactionUpToMessageId }
    if (patch.compactionTokensBefore   !== undefined) { sets.push('compaction_tokens_before = $ctok'); params.$ctok = patch.compactionTokensBefore }
    if (patch.titleAutoSynced          !== undefined) { sets.push('title_auto_synced = $tas'); params.$tas = patch.titleAutoSynced ? 1 : 0 }
    return ((this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  // ── Code session lifecycle (archive/delete/clear) ───────────────────────────

  /** Archive or unarchive a Code session — a separate, single-purpose setter (not folded into
   *  updateAgentRun's patch) because `archivedAt` needs to be explicitly CLEARABLE (unarchive),
   *  which updateAgentRun's `!== undefined` convention can't express for a nullable field. */
  setAgentRunArchived(id: string, archived: boolean): boolean {
    const now = new Date().toISOString()
    return ((this.db.prepare(`UPDATE agent_runs SET archived_at = $at, updated_at = $now WHERE id = $id`)
      .run({ $id: id, $at: archived ? now : null, $now: now } as P) as unknown) as Changes).changes > 0
  }

  /** Set or clear (`null`) a Code session's /clear cut point — see AgentRun.clearedUpToMessageId. */
  setClearedUpToMessageId(id: string, messageId: string | null): boolean {
    const now = new Date().toISOString()
    return ((this.db.prepare(`UPDATE agent_runs SET cleared_upto_message_id = $mid, updated_at = $now WHERE id = $id`)
      .run({ $id: id, $mid: messageId, $now: now } as P) as unknown) as Changes).changes > 0
  }

  /** Set or clear (`null`) a Code session's revert marker — see AgentRun.revertedFromMessageId. */
  setRevertedFromMessageId(id: string, messageId: string | null): boolean {
    const now = new Date().toISOString()
    return ((this.db.prepare(`UPDATE agent_runs SET reverted_from_message_id = $mid, updated_at = $now WHERE id = $id`)
      .run({ $id: id, $mid: messageId, $now: now } as P) as unknown) as Changes).changes > 0
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

  /** Permanently delete a Code session: its messages, working doc, and the agent_run +
   *  conversation rows. There is no FK cascade on these tables (each is deleted explicitly,
   *  same as chat's own conversation delete never cascaded to messages) — miss one and it's
   *  an orphaned row, not a crash, but still worth getting right. Returns false if the run
   *  didn't exist. */
  deleteCodeSession(runId: string): boolean {
    const run = this.getAgentRun(runId)
    if (!run) return false
    this.db.prepare(`DELETE FROM messages WHERE conv_id = $cid`).run({ $cid: run.convId } as P)
    this.db.prepare(`DELETE FROM agent_run_docs WHERE run_id = $id`).run({ $id: runId } as P)
    this.db.prepare(`DELETE FROM agent_runs WHERE id = $id`).run({ $id: runId } as P)
    this.db.prepare(`DELETE FROM conversations WHERE id = $cid`).run({ $cid: run.convId } as P)
    return true
  }

  // ── Hitman layer (spec 13 §§12-15) ─────────────────────────────────────────

  /** The durable working doc for a run (spec 13 §12.2). '' when none yet. */
  getRunDoc(runId: string): string {
    const row = this.db.prepare(`SELECT content FROM agent_run_docs WHERE run_id = $id`).get({ $id: runId } as P) as { content: string } | undefined
    return row?.content ?? ''
  }

  upsertRunDoc(runId: string, content: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO agent_run_docs (run_id, content, updated_at) VALUES ($id, $c, $now)
      ON CONFLICT(run_id) DO UPDATE SET content = $c, updated_at = $now
    `).run({ $id: runId, $c: content, $now: now } as P)
  }

  /** Record a finished contract's outcome for the per-Hitman track record (§12.3). */
  addTrackRecord(row: Omit<TrackRecordRow, 'id' | 'ranAt'> & { ranAt?: string }): void {
    const id = randomUUID()
    const ranAt = row.ranAt ?? new Date().toISOString()
    this.db.prepare(`INSERT INTO agent_track_record (id,agent_id,run_id,model,outcome,feedback,ran_at) VALUES ($id,$aid,$rid,$m,$o,$f,$t)`)
      .run({ $id: id, $aid: row.agentId, $rid: row.runId, $m: row.model, $o: row.outcome, $f: row.feedback ?? null, $t: ranAt } as P)
  }

  trackRecordForAgent(agentId: string): TrackRecordRow[] {
    const rows = this.db.prepare(`SELECT * FROM agent_track_record WHERE agent_id = $a ORDER BY ran_at DESC`).all({ $a: agentId } as P) as Array<{ id: string; agent_id: string; run_id: string; model: string; outcome: string; feedback: string | null; ran_at: string }>
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, runId: r.run_id, model: r.model, outcome: r.outcome as 'complete' | 'miss', feedback: r.feedback ?? undefined, ranAt: r.ran_at }))
  }

  /** Per-model count + success rate for a Hitman (§12.3). Drives warn/suggest. */
  modelStatsForAgent(agentId: string): ModelStat[] {
    const rows = this.db.prepare(`
      SELECT model,
             COUNT(*) AS total,
             SUM(CASE WHEN outcome = 'complete' THEN 1 ELSE 0 END) AS complete
      FROM agent_track_record WHERE agent_id = $a GROUP BY model
    `).all({ $a: agentId } as P) as Array<{ model: string; total: number; complete: number }>
    return rows.map((r) => ({ model: r.model, total: r.total, complete: r.complete, successRate: r.total ? r.complete / r.total : 0 }))
  }

  /** Archive a contract + record its disposition outcome (§14). */
  setRunDisposition(runId: string, completion: 'complete' | 'miss', archive: boolean): boolean {
    const now = new Date().toISOString()
    const sets = ['completion = $c', 'updated_at = $now']
    const params: Record<string, SQLInputValue> = { $id: runId, $c: completion, $now: now }
    if (archive) { sets.push('archived_at = $now') }
    return ((this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  /** Active (non-archived) runs, newest first. */
  listActiveAgentRuns(): AgentRun[] {
    return (this.db.prepare(`SELECT * FROM agent_runs WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 200`).all() as unknown as AgentRunRow[]).map(rowToAgentRun)
  }

  /** Archived contracts, optionally filtered to one Hitman (§15). */
  listArchivedAgentRuns(agentId?: string): AgentRun[] {
    if (agentId) {
      return (this.db.prepare(`SELECT * FROM agent_runs WHERE archived_at IS NOT NULL AND agent_id = $a ORDER BY archived_at DESC LIMIT 200`).all({ $a: agentId } as P) as unknown as AgentRunRow[]).map(rowToAgentRun)
    }
    return (this.db.prepare(`SELECT * FROM agent_runs WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 200`).all() as unknown as AgentRunRow[]).map(rowToAgentRun)
  }

  /** Prune a deleted Hitman's track-record rows (agent_id is a config id, not a DB FK). */
  pruneTrackRecordForAgent(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_track_record WHERE agent_id = $a`).run({ $a: agentId } as P)
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

  addAgentLesson(row: { agentId: string; lesson: string; evidence?: string; convId?: string }): void {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO agent_lessons (id,agent_id,lesson,evidence,conv_id,created_at) VALUES ($id,$aid,$l,$e,$c,$now)`)
      .run({ $id: id, $aid: row.agentId, $l: row.lesson, $e: row.evidence ?? null, $c: row.convId ?? null, $now: now } as P)
  }

  /** Most-recent lessons for an agent (for injection at run start; the loop limits to top-N). */
  listAgentLessons(agentId: string, limit = 50): AgentLesson[] {
    const rows = this.db.prepare(`SELECT * FROM agent_lessons WHERE agent_id = $a ORDER BY created_at DESC LIMIT $n`)
      .all({ $a: agentId, $n: limit } as P) as Array<{ id: string; agent_id: string; lesson: string; evidence: string | null; conv_id: string | null; created_at: string }>
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, lesson: r.lesson, evidence: r.evidence ?? undefined, convId: r.conv_id ?? undefined, createdAt: r.created_at }))
  }

  pruneAgentLessons(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_lessons WHERE agent_id = $a`).run({ $a: agentId } as P)
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
    const rows = this.db.prepare(`SELECT * FROM memory_facts ORDER BY created_at DESC`)
      .all() as Array<{ id: string; fact_text: string; source_conv_id: string | null; created_at: string }>
    return rows.map((r) => ({ id: r.id, factText: r.fact_text, sourceConvId: r.source_conv_id ?? undefined, createdAt: r.created_at }))
  }

  deleteMemoryFact(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM memory_facts WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  // ── Skills grown from experience (redesign §3.3, Voyager) ─────────────────────

  addAgentSkill(row: { agentId: string; name: string; description?: string; procedure: string; source?: string }): void {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO agent_skills (id,agent_id,name,description,procedure,source,created_at) VALUES ($id,$aid,$n,$d,$p,$s,$now)`)
      .run({ $id: id, $aid: row.agentId, $n: row.name, $d: row.description ?? '', $p: row.procedure, $s: row.source ?? null, $now: now } as P)
  }

  listAgentSkills(agentId: string, limit = 50): AgentSkill[] {
    const rows = this.db.prepare(`SELECT * FROM agent_skills WHERE agent_id = $a ORDER BY created_at DESC LIMIT $n`)
      .all({ $a: agentId, $n: limit } as P) as Array<{ id: string; agent_id: string; name: string; description: string; procedure: string; source: string | null; created_at: string }>
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, name: r.name, description: r.description, procedure: r.procedure, source: r.source ?? undefined, createdAt: r.created_at }))
  }

  /** True if a skill with this (case-insensitive) name already exists for the agent — the
   *  Curator's dedupe check before inserting a new distilled skill. */
  hasAgentSkillNamed(agentId: string, name: string): boolean {
    const r = this.db.prepare(`SELECT 1 FROM agent_skills WHERE agent_id = $a AND lower(name) = lower($n) LIMIT 1`).get({ $a: agentId, $n: name } as P)
    return !!r
  }

  countAgentSkills(agentId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM agent_skills WHERE agent_id = $a`).get({ $a: agentId } as P) as { n: number }).n
  }

  deleteAgentSkill(id: string): void {
    this.db.prepare(`DELETE FROM agent_skills WHERE id = $id`).run({ $id: id } as P)
  }

  pruneAgentSkills(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_skills WHERE agent_id = $a`).run({ $a: agentId } as P)
  }

  close(): void { this.db.close() }
}
