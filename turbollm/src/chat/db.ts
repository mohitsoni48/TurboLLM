// Conversation + message persistence (spec 01 §4). Uses node:sqlite (Node 22+).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Routine, RoutineRun, RoutineFlavor, RoutineStatus, RoutineRunStatus, CodingAgentChoice, ScheduleRule } from '../routines/schema'

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

const RANGE_WINDOW_DAYS: Record<'30d' | '7d', number> = { '30d': 30, '7d': 7 }

const TOKEN_MILESTONES = [
  1_000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000,
  10_000_000, 50_000_000, 100_000_000, 500_000_000, 1_000_000_000,
]

/** Where a lifetime token total sits on the milestone ladder. Shared by both branches of
 *  tokenUsageStats (empty-rows and the real computation) — as of 2026-07-22 the lifetime
 *  total fed in is the COMBINED chat+API figure, so this only ever computes, never decides
 *  which figure to use. */
function milestoneFor(lifetimeTotalTokens: number): { achieved: number | null; next: number | null; progressPct: number | null } {
  const achieved = [...TOKEN_MILESTONES].reverse().find((m) => m <= lifetimeTotalTokens) ?? null
  const next = TOKEN_MILESTONES.find((m) => m > lifetimeTotalTokens) ?? null
  const progressPct = next !== null
    ? Math.round(((lifetimeTotalTokens - (achieved ?? 0)) / (next - (achieved ?? 0))) * 1000) / 10
    : null
  return { achieved, next, progressPct }
}

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
interface AgentRunRow { id: string; conv_id: string; title: string; status: string; allowed_tools: string; agent_id: string | null; error: string | null; created_at: string; updated_at: string; started_at: string | null; ended_at: string | null; archived_at: string | null; completion: string | null; repo_root: string | null; repo_branch: string | null; use_worktree: number | null; worktree_branch: string | null; worktree_base: string | null; worktree_path: string | null; lines_added: number | null; lines_removed: number | null; compaction_summary: string | null; compaction_upto_message_id: string | null; compaction_tokens_before: number | null; cleared_upto_message_id: string | null; reverted_from_message_id: string | null; title_auto_synced: number | null; code_agent: string | null; terminal_launched_once: number | null }
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
    codeAgent: (r.code_agent as AgentRun['codeAgent']) ?? undefined,
    useWorktree: r.use_worktree === null ? undefined : r.use_worktree === 1,
    worktreeBranch: r.worktree_branch ?? undefined,
    worktreeBase: r.worktree_base ?? undefined,
    worktreePath: r.worktree_path ?? undefined,
    linesAdded: r.lines_added ?? undefined,
    linesRemoved: r.lines_removed ?? undefined,
    compactionSummary: r.compaction_summary ?? undefined,
    compactionUpToMessageId: r.compaction_upto_message_id ?? undefined,
    compactionTokensBefore: r.compaction_tokens_before ?? undefined,
    clearedUpToMessageId: r.cleared_upto_message_id ?? undefined,
    revertedFromMessageId: r.reverted_from_message_id ?? undefined,
    titleAutoSynced: r.title_auto_synced === 1,
    terminalLaunchedOnce: r.terminal_launched_once === 1,
  }
}

interface RoutineRow {
  id: string; flavor: string; status: string; prompt: string
  schedule_display: string; schedule_rule: string; next_fire_at: string | null
  model_key: string; agent_id: string | null; workspace_path: string | null
  coding_agent: string | null; permission_mode: string | null
  created_at: string; updated_at: string
}

function rowToRoutine(r: RoutineRow): Routine {
  return {
    id: r.id,
    flavor: r.flavor as RoutineFlavor,
    status: r.status as RoutineStatus,
    prompt: r.prompt,
    scheduleDisplay: r.schedule_display,
    scheduleRule: JSON.parse(r.schedule_rule) as ScheduleRule,
    nextFireAt: r.next_fire_at,
    modelKey: r.model_key,
    agentId: r.agent_id ?? undefined,
    workspacePath: r.workspace_path ?? undefined,
    codingAgent: (r.coding_agent as CodingAgentChoice | null) ?? undefined,
    permissionMode: (r.permission_mode as Routine['permissionMode']) ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface RoutineRunRow {
  id: string; routine_id: string; status: string; skip_reason: string | null
  config_snapshot: string; pending_tool_call: string | null
  result: string | null; error: string | null; started_at: string; ended_at: string | null
  conversation_id: string | null; code_session_id: string | null
}

function rowToRoutineRun(r: RoutineRunRow): RoutineRun {
  return {
    id: r.id,
    routineId: r.routine_id,
    status: r.status as RoutineRunStatus,
    skipReason: r.skip_reason ?? undefined,
    configSnapshot: r.config_snapshot,
    pendingToolCall: r.pending_tool_call ?? undefined,
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    conversationId: r.conversation_id ?? undefined,
    codeSessionId: r.code_session_id ?? undefined,
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
    // v34 (GitHub #71): tokens hitting the gateway (/v1/messages, /v1/chat/completions) from
    // external clients — Claude Code, other CLIs/extensions — never landed in `messages` (that
    // table is chat-conversation rows only; gateway requests create no conversation). Usage was
    // silently invisible to the Tokens dashboard. One row per completed gateway request, kept
    // deliberately separate from `messages` (no conv_id/role — it isn't a chat turn) rather than
    // merged into the existing streak/session semantics there, which are chat-specific concepts.
    if (v < 34) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS api_usage (
          id             TEXT PRIMARY KEY,
          created_at     TEXT NOT NULL,
          source         TEXT NOT NULL,
          model_key      TEXT,
          prompt_tokens  INTEGER NOT NULL DEFAULT 0,
          gen_tokens     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
        PRAGMA user_version = 34;
      `)
    }
    // v35 (ADR-283, Code agent selector): which coding agent a session launches with
    // (config.ts's code.defaultAgent, snapshotted at creation). Additive + nullable —
    // existing rows get NULL, decoded as undefined (→ 'turbollm') in rowToAgentRun.
    if (v < 35) {
      if (!this.hasColumn('agent_runs', 'code_agent')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN code_agent TEXT;`)
      this.db.exec(`PRAGMA user_version = 35;`)
    }
    // v36 (ADR-284, terminal-agent composer parity): api_usage rows gain a code_session_id
    // (which Code session a gateway request belongs to, resolved from the session-scoped
    // token — session-auth.ts) and duration_ms (elapsed wall-clock time of the request, so
    // prompt/gen tokens-per-second can be computed the same way lastRealStats already is for
    // chat sessions). Both additive + nullable — pre-existing rows (and any request whose
    // token doesn't resolve to a Code session) simply have no session/timing to attribute.
    if (v < 36) {
      if (!this.hasColumn('api_usage', 'code_session_id')) this.db.exec(`ALTER TABLE api_usage ADD COLUMN code_session_id TEXT;`)
      if (!this.hasColumn('api_usage', 'duration_ms')) this.db.exec(`ALTER TABLE api_usage ADD COLUMN duration_ms INTEGER;`)
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_api_usage_code_session ON api_usage(code_session_id, created_at);`)
      this.db.exec(`PRAGMA user_version = 36;`)
    }
    // v37 (terminal-agent auto-resume across a daemon restart): whether a terminal has ever
    // been created for this session — lets terminal-routes.ts tell a genuinely first-ever
    // launch apart from a restart-reconnect (the in-memory PTY died with the daemon, the
    // session didn't) and pass the CLI's own continue/resume flag on the latter. Additive +
    // defaulted to 0 — every pre-existing row reads as "never launched", which just means its
    // NEXT terminal open is treated as fresh (the same behavior as today), never wrongly
    // resumed into a conversation that was never actually interrupted.
    if (v < 37) {
      if (!this.hasColumn('agent_runs', 'terminal_launched_once')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN terminal_launched_once INTEGER NOT NULL DEFAULT 0;`)
      this.db.exec(`PRAGMA user_version = 37;`)
    }
    // v38 (one-time data fix, same day as v37): v37's terminal_launched_once meant "has a
    // terminal been created before" and its next-launch flag was claude's --continue (resume
    // the most recent conversation in this DIRECTORY). Found live within hours of shipping:
    // --continue is ambiguous the moment two Code sessions share a repoRoot, so it was replaced
    // with --session-id/--resume keyed on THIS session's own id — but any row already flagged
    // true under the OLD scheme was never registered with the CLI under that exact id, so its
    // next launch would send --resume <id-the-CLI-has-never-seen> and fail outright ("No
    // conversation found with session ID: ..."). Reset unconditionally: every session's next
    // terminal launch is treated as a fresh --session-id registration exactly once, then
    // resumes correctly from then on — a strictly safe replay of v37's own default for rows
    // that, in practice, only existed for a few hours before this fix landed.
    if (v < 38) {
      this.db.exec(`UPDATE agent_runs SET terminal_launched_once = 0;`)
      this.db.exec(`PRAGMA user_version = 38;`)
    }
    // v39 (ADR-300): the engine's OWN per-phase rates, as llama.cpp measured them
    // (`timings.prompt_per_second` / `timings.predicted_per_second`). v36 stored only a single
    // `duration_ms` for the whole request and derived both rates from it, which cannot be right
    // for either phase — prefill and decode run one after the other, so dividing each token count
    // by the TOTAL duration understates both. Measured on a live claude session: 763 generated
    // tokens over a 62 s request read as 12.3 tok/s while the engine's own decode rate was ~78.
    // Additive + nullable: pre-existing rows keep the old derived approximation (below).
    if (v < 39) {
      if (!this.hasColumn('api_usage', 'prompt_tps')) this.db.exec(`ALTER TABLE api_usage ADD COLUMN prompt_tps REAL;`)
      if (!this.hasColumn('api_usage', 'gen_tps')) this.db.exec(`ALTER TABLE api_usage ADD COLUMN gen_tps REAL;`)
      this.db.exec(`PRAGMA user_version = 39;`)
    }
    // v40 (Code, real worktrees): the ABSOLUTE path of the git worktree a session actually runs
    // in, when it was created with "Use worktree". Kept separate from `repo_root` rather than
    // overwriting it: repo_root stays the base repository, which is what worktree removal has to
    // run `git worktree remove` FROM, and what the UI should keep showing as the session's project.
    // Null for every session that isn't using a worktree — including all existing rows, whose
    // `use_worktree` intent was captured but never acted on (v28's comment), so they correctly
    // decode as "no worktree" rather than claiming one that was never created.
    if (v < 40) {
      if (!this.hasColumn('agent_runs', 'worktree_path')) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT;`)
      this.db.exec(`PRAGMA user_version = 40;`)
    }
    // v41 (Routines, Phase 1 foundation): scheduled tasks (chat or code) that fire on a
    // cron-like schedule. routine_runs cascades on routine delete (FK + ON DELETE CASCADE,
    // relying on the `PRAGMA foreign_keys = ON` set above) — unlike agent_runs' explicit
    // multi-table delete, a routine's runs have no other referents to clean up.
    if (v < 41) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS routines (
          id TEXT PRIMARY KEY,
          flavor TEXT NOT NULL CHECK (flavor IN ('chat','code')),
          status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN ('pending_confirmation','active','paused')),
          prompt TEXT NOT NULL,
          schedule_display TEXT NOT NULL,
          schedule_rule TEXT NOT NULL,
          next_fire_at TEXT,
          model_key TEXT NOT NULL,
          agent_id TEXT,
          workspace_path TEXT,
          coding_agent TEXT,
          permission_mode TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_routines_status_next_fire ON routines(status, next_fire_at);
        CREATE TABLE IF NOT EXISTS routine_runs (
          id TEXT PRIMARY KEY,
          routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('running','ok','skipped','errored','needs_approval')),
          skip_reason TEXT,
          config_snapshot TEXT NOT NULL,
          pending_tool_call TEXT,
          result TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at);
        PRAGMA user_version = 41;
      `)
    }
    // v42 (Routines: open a run as a real chat/Code session): a chat-flavor run already creates a
    // full conversation (chat-runner.ts) and a code-flavor run already creates a full Code session
    // (code-runner.ts) — both were previously un-lookup-able from the run row itself, so the only
    // way to see what a run actually did was the flattened `result` text. Nullable/additive: every
    // pre-existing run correctly decodes as "no linked session" (it genuinely has none — the id was
    // never persisted), falling back to `result`.
    if (v < 42) {
      if (!this.hasColumn('routine_runs', 'conversation_id')) this.db.exec(`ALTER TABLE routine_runs ADD COLUMN conversation_id TEXT;`)
      if (!this.hasColumn('routine_runs', 'code_session_id')) this.db.exec(`ALTER TABLE routine_runs ADD COLUMN code_session_id TEXT;`)
      this.db.exec(`PRAGMA user_version = 42;`)
    }
    // v43 (spec 23 §3.5, telemetry Phase 5): which coding-tool CLI made this gateway request,
    // classified from its User-Agent header (classify.ts's classifyHarness) at the two gateway
    // entry points (gateway.ts) — the gateway read zero request headers before this. Additive +
    // nullable: every pre-existing row simply has no header to have classified, and reads as
    // 'unknown' (gatewayDailyStats' own fallback), the same bucket a genuinely unrecognized
    // client falls into going forward.
    if (v < 43) {
      if (!this.hasColumn('api_usage', 'harness')) this.db.exec(`ALTER TABLE api_usage ADD COLUMN harness TEXT;`)
      this.db.exec(`PRAGMA user_version = 43;`)
    }
    // v44 (founder-reported: a terminal-agent session's ctx-fill ring jumped between full and
    // empty within the same session): getLastApiUsageForSession now picks the row with the
    // MAX prompt_tokens for the session instead of literally the most-recently-inserted one —
    // see that method's own doc comment for the full root cause (Task-tool sub-agent requests
    // share the main turn's code_session_id, and a smaller sub-agent row finishing after the
    // real turn used to silently win). This index serves that new query pattern the same way
    // idx_api_usage_code_session (v36) served the old ORDER BY created_at.
    if (v < 44) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_api_usage_code_session_tokens ON api_usage(code_session_id, prompt_tokens);`)
      this.db.exec(`PRAGMA user_version = 44;`)
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
      // Computed independently — a user with zero in-app chats but real gateway (Claude
      // Code / extension) traffic still has something to show here. "Total tokens" /
      // "Lifetime tokens" (below and in the main branch) are the founder-directed
      // combined figure (2026-07-22) — Overview must reflect ALL usage, not just chat,
      // so a chat-less API-only user still gets a real milestone reading instead of a
      // permanently-stuck-at-zero one.
      const api = this.apiUsageStats(range)
      const milestone = milestoneFor(api.lifetimeTotalTokens)
      return {
        range, sessions: 0, messages: 0, totalTokens: api.totalTokens, activeDays: 0,
        currentStreak: 0, longestStreak: 0, peakHour: null, favoriteModel: null,
        firstMessageAt: null, lifetimeTotalTokens: api.lifetimeTotalTokens, milestone,
        activity: { granularityHours: 24, buckets: [] }, dailyByModel: [], byModel: [],
        api,
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

    let chatLifetimeTotalTokens = 0
    for (const b of dayBuckets.values()) chatLifetimeTotalTokens += b.promptTokens + b.genTokens

    // Founder-directed (2026-07-22): Overview's "Total tokens" / "Lifetime tokens" / milestone
    // ladder must reflect ALL usage, not just in-app chat — a heavy Claude Code / extension user
    // was seeing a headline total that silently excluded most of their real usage, with the API
    // figures only visible by switching to a separate tab. `sessions`/`messages`/streak/peak-hour/
    // favorite-model stay chat-only below: those are chat-conversation-shaped concepts (a gateway
    // request has no conv_id, isn't a "session") with no clean 1:1 API equivalent, and the founder
    // asked specifically about "usage" totals, not those. The isolated `api` breakdown (by source,
    // by model) remains available in its own tab for anyone who wants the split.
    const api = this.apiUsageStats(range)
    const combinedTotalTokens = totalTokens + api.totalTokens
    const combinedLifetimeTotalTokens = chatLifetimeTotalTokens + api.lifetimeTotalTokens
    const milestone = milestoneFor(combinedLifetimeTotalTokens)

    return {
      range, sessions: convIds.size, messages: scopedRows.length, totalTokens: combinedTotalTokens, activeDays,
      currentStreak, longestStreak, peakHour,
      favoriteModel: byModel[0]?.displayName ?? null,
      firstMessageAt, lifetimeTotalTokens: combinedLifetimeTotalTokens, milestone,
      activity, dailyByModel, byModel,
      api,
    }
  }

  /** Insert one completed gateway request (GitHub #71) — called from the two gateway entry
   *  points (gateway.ts) right where in-app chat already records into `messages`. Fully
   *  additive/fail-safe: callers wrap this the same way `recordCompletion` is wrapped.
   *  `codeSessionId`/`durationMs` (ADR-284) are only populated for a terminal-agent session's
   *  own token-identified traffic — undefined for every other gateway client, same as before. */
  recordApiUsage(rec: { source: ApiUsageSource; modelKey: string | null; promptTokens: number; genTokens: number; codeSessionId?: string | null; durationMs?: number | null; promptTps?: number | null; genTps?: number | null; harness?: string | null }): void {
    // `promptTps`/`genTps` (ADR-300) are the ENGINE's own measurements, straight from the
    // llama.cpp response's `timings` — not anything computed here. Passing them through is the
    // whole point: each phase gets its own real rate instead of both being divided by one
    // wall-clock. Absent (an engine that reports no timings) → null, and the reader falls back.
    const rate = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null)
    this.db.prepare(`
      INSERT INTO api_usage (id, created_at, source, model_key, prompt_tokens, gen_tokens, code_session_id, duration_ms, prompt_tps, gen_tps, harness)
      VALUES ($id, $createdAt, $source, $modelKey, $promptTokens, $genTokens, $codeSessionId, $durationMs, $promptTps, $genTps, $harness)
    `).run({
      $id: randomUUID(),
      $createdAt: new Date().toISOString(),
      $source: rec.source,
      $modelKey: rec.modelKey,
      $promptTokens: Math.max(0, Math.floor(rec.promptTokens) || 0),
      $genTokens: Math.max(0, Math.floor(rec.genTokens) || 0),
      $codeSessionId: rec.codeSessionId ?? null,
      $durationMs: rec.durationMs != null && Number.isFinite(rec.durationMs) ? Math.max(0, Math.floor(rec.durationMs)) : null,
      $promptTps: rate(rec.promptTps),
      $genTps: rate(rec.genTps),
      $harness: rec.harness ?? null,
    } as P)
  }

  /** The session's own largest completed gateway request (ADR-284, revised — founder-reported
   *  "ctx fill jumps between full and empty in the same session") — powers TerminalToolbar.tsx's
   *  composer-parity stats row and its Context ring the same way `lastRealStats` already does for
   *  a 'turbollm' chat session's last turn. null when the session has made no gateway requests yet
   *  (fresh session, or a non-terminal-agent one).
   *
   *  Deliberately the MAX prompt_tokens row, not literally the most-recently-INSERTED one. Every
   *  request a real `claude` CLI process makes — the main conversation's own turn AND every
   *  parallel Task-tool sub-agent it spawns — shares the SAME code_session_id: `resolveCodeSession`
   *  (gateway.ts) derives it purely from the bearer token, and the CLI mints exactly one token
   *  (ANTHROPIC_AUTH_TOKEN, set once at launch) for its whole process, sub-agents included. A
   *  sub-agent's own prompt is a small, isolated sub-task — nothing like the full resent
   *  conversation — so whichever of the two finishes last used to decide what the ring showed:
   *  the real, large, ever-growing main-turn prompt one poll, a tiny sub-agent prompt the next,
   *  with no change to the actual conversation in between. The MAX is the honest answer to "how
   *  full has this session's context gotten" — a real Claude Code CLI resends the whole
   *  conversation every turn, so its size only grows within one continuous conversation, and a
   *  sub-agent (always smaller) can never legitimately raise that high-water mark.
   *
   *  Trade-off, accepted: after a real `/clear` inside the CLI (invisible to the daemon — a
   *  terminal-agent session's turns are never persisted here, see ADR-297), this keeps reporting
   *  the pre-clear high-water mark until the new conversation grows past it. A temporarily-stale-
   *  high reading after a rare, deliberate user action beats an unpredictable full/empty flicker
   *  on every ordinary agentic turn with sub-agents. */
  getLastApiUsageForSession(codeSessionId: string): { promptTokens: number; genTokens: number; promptTps: number | null; genTps: number | null } | null {
    const row = this.db.prepare(`
      SELECT prompt_tokens, gen_tokens, duration_ms, prompt_tps, gen_tps FROM api_usage
      WHERE code_session_id = $codeSessionId
      ORDER BY prompt_tokens DESC, created_at DESC LIMIT 1
    `).get({ $codeSessionId: codeSessionId } as P) as unknown as { prompt_tokens: number; gen_tokens: number; duration_ms: number | null; prompt_tps: number | null; gen_tps: number | null } | undefined
    if (!row) return null
    // The engine's own per-phase rates when the row has them (ADR-300) — llama.cpp times prefill
    // and decode separately and reports each, which is the only way either number can be right.
    //
    // The fallback below (both counts ÷ the request's TOTAL wall-clock) is what every row used to
    // get, and it is wrong for both phases by construction: prefill and decode run one after the
    // other, so neither occupies the full duration. Live measurement that started this: 763
    // generated tokens on a 62 s claude request came out as 12.3 tok/s against a real decode rate
    // of ~78. It is kept ONLY so pre-v39 rows still show something rather than nothing, and it is
    // deliberately the lower-priority branch — a new row always carries the real rates unless the
    // engine reported none.
    const seconds = row.duration_ms != null && row.duration_ms > 0 ? row.duration_ms / 1000 : null
    return {
      promptTokens: row.prompt_tokens,
      genTokens: row.gen_tokens,
      promptTps: row.prompt_tps ?? (seconds ? row.prompt_tokens / seconds : null),
      genTps: row.gen_tps ?? (seconds ? row.gen_tokens / seconds : null),
    }
  }

  /** Gateway (external-client) token usage — see `ApiUsageStats`'s doc comment for why this
   *  is a separate bucket from `tokenUsageStats`. Same local-day range scoping as the chat
   *  stats above, but no streak/session concepts (a gateway request isn't a chat turn). */
  apiUsageStats(range: TokenUsageRange = 'all'): ApiUsageStats {
    const rows = this.db.prepare(`
      SELECT created_at, source, model_key, prompt_tokens, gen_tokens FROM api_usage
      ORDER BY created_at ASC
    `).all() as unknown as { created_at: string; source: ApiUsageSource; model_key: string | null; prompt_tokens: number; gen_tokens: number }[]

    let lifetimeTotalTokens = 0
    for (const r of rows) lifetimeTotalTokens += r.prompt_tokens + r.gen_tokens

    if (rows.length === 0) {
      return { range, requests: 0, totalTokens: 0, lifetimeTotalTokens: 0, bySource: [], byModel: [] }
    }

    const todayKey = dayKey(new Date().toISOString())
    const heatStart = range === 'all' ? null : addDays(todayKey, -(RANGE_WINDOW_DAYS[range] - 1))
    const scoped = heatStart === null ? rows : rows.filter((r) => dayKey(r.created_at) >= heatStart)

    const sourceTally = new Map<ApiUsageSource, { requests: number; totalTokens: number }>()
    const modelTally = new Map<string, { requests: number; promptTokens: number; genTokens: number }>()
    let totalTokens = 0
    for (const r of scoped) {
      const tokens = r.prompt_tokens + r.gen_tokens
      totalTokens += tokens
      const st = sourceTally.get(r.source) ?? { requests: 0, totalTokens: 0 }
      st.requests++; st.totalTokens += tokens
      sourceTally.set(r.source, st)
      if (r.model_key) {
        const mt = modelTally.get(r.model_key) ?? { requests: 0, promptTokens: 0, genTokens: 0 }
        mt.requests++; mt.promptTokens += r.prompt_tokens; mt.genTokens += r.gen_tokens
        modelTally.set(r.model_key, mt)
      }
    }

    const byModel: ApiModelUsage[] = [...modelTally.entries()]
      .map(([modelKey, m]) => ({
        modelKey, displayName: titleCaseModelName(modelKey),
        requests: m.requests, promptTokens: m.promptTokens, genTokens: m.genTokens,
        totalTokens: m.promptTokens + m.genTokens,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)

    return {
      range, requests: scoped.length, totalTokens, lifetimeTotalTokens,
      bySource: [...sourceTally.entries()].map(([source, s]) => ({ source, ...s })),
      byModel,
    }
  }

  /**
   * A single UTC-comparable `[start, end)` window for `chat_daily`/`gateway_daily`/
   * `code_daily` (spec 23 §3.4/3.5/3.8, ADR-333) — read-only aggregations over
   * tables that already durably record everything needed, computed once at
   * day-rollover rather than accumulated in memory (unlike `feature_used_daily`,
   * which has no backing table to query and genuinely needs `runtime/rollup.ts`'s
   * accumulator). `dayIso` is a `YYYY-MM-DD` local-calendar-day key, matching
   * `dayKey()`'s own convention above.
   */
  private dayWindow(dayIso: string): { start: string; end: string } {
    const [y, m, d] = dayIso.split('-').map(Number)
    return {
      start: new Date(y, m - 1, d).toISOString(),
      end: new Date(y, m - 1, d + 1).toISOString(),
    }
  }

  /** `chat_daily`'s config block (spec 23 §3.4) for the local calendar day `dayIso`.
   *  `toolCalls` sums `json_array_length(tool_calls)` rather than counting messages
   *  that merely HAVE a tool call, so a message with 3 calls in one turn counts as 3.
   *  `regenerates` counts deactivated variant-group siblings — each one is a message
   *  a real regenerate action superseded (see the `variant_group`/`is_active`
   *  migration note above). `stops` reads `stats.aborted`, the same flag the chat UI
   *  itself uses to render a stopped reply. Median is computed in JS — SQLite has no
   *  built-in median aggregate, and pulling one row per touched conversation is cheap
   *  (a real day's conversation count is nowhere near enough to matter). */
  chatDailyStats(dayIso: string): {
    conversations: number; messages: number; maxMessagesInConversation: number
    medianMessagesInConversation: number; distinctModels: number; toolCalls: number
    regenerates: number; stops: number
  } {
    const { start, end } = this.dayWindow(dayIso)
    const rows = this.db.prepare(`
      SELECT conv_id, model_key, tool_calls, stats FROM messages
      WHERE created_at >= ? AND created_at < ? AND is_active = 1
    `).all(start, end) as unknown as { conv_id: string; model_key: string | null; tool_calls: string | null; stats: string }[]

    const perConv = new Map<string, number>()
    const models = new Set<string>()
    let toolCalls = 0
    let stops = 0
    for (const r of rows) {
      perConv.set(r.conv_id, (perConv.get(r.conv_id) ?? 0) + 1)
      if (r.model_key) models.add(r.model_key)
      if (r.tool_calls) {
        try {
          const parsed: unknown = JSON.parse(r.tool_calls)
          if (Array.isArray(parsed)) toolCalls += parsed.length
        } catch {
          // malformed tool_calls JSON — skip rather than crash a periodic rollup
        }
      }
      try {
        const s: unknown = JSON.parse(r.stats)
        if (typeof s === 'object' && s !== null && (s as { aborted?: unknown }).aborted === true) stops++
      } catch {
        // malformed stats JSON — same treatment
      }
    }

    const counts = [...perConv.values()].sort((a, b) => a - b)
    const median = counts.length === 0 ? 0
      : counts.length % 2 === 1 ? counts[(counts.length - 1) / 2]
      : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2

    const regenerates = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE created_at >= ? AND created_at < ? AND variant_group IS NOT NULL AND is_active = 0
    `).get(start, end) as unknown as { n: number }).n

    return {
      conversations: perConv.size,
      messages: rows.length,
      maxMessagesInConversation: counts.length === 0 ? 0 : counts[counts.length - 1],
      medianMessagesInConversation: median,
      distinctModels: models.size,
      toolCalls,
      regenerates,
      stops,
    }
  }

  /** `gateway_daily`'s config block (spec 23 §3.5) for the local calendar day
   *  `dayIso`, grouped by `source` (protocol) — a read-only aggregation over the
   *  ALREADY-INDEXED `api_usage` table, so this adds no write to the gateway's own
   *  hot request path. Grouped by harness too once Phase 5's client-detection
   *  ships; until then every row reports `harness: 'unknown'` rather than waiting
   *  on that phase to start collecting protocol-level volume at all. */
  /** Grouped by (protocol, harness) — spec 23 §3.5, telemetry Phase 5. Pre-Phase-5 rows (and
   *  any client the gateway didn't classify) have `harness IS NULL`, which reads as `'unknown'`
   *  here rather than a distinct group of its own — that's the same bucket a genuinely
   *  unrecognized live client falls into, so the two cases don't need telling apart downstream. */
  gatewayDailyStats(dayIso: string): { protocol: ApiUsageSource; harness: string; requests: number; promptTokens: number; genTokens: number; distinctModels: number }[] {
    const { start, end } = this.dayWindow(dayIso)
    const rows = this.db.prepare(`
      SELECT source, model_key, harness, prompt_tokens, gen_tokens FROM api_usage
      WHERE created_at >= ? AND created_at < ?
    `).all(start, end) as unknown as { source: ApiUsageSource; model_key: string | null; harness: string | null; prompt_tokens: number; gen_tokens: number }[]

    const byGroup = new Map<string, { protocol: ApiUsageSource; harness: string; requests: number; promptTokens: number; genTokens: number; models: Set<string> }>()
    for (const r of rows) {
      const harness = r.harness ?? 'unknown'
      const key = `${r.source} ${harness}`
      const t = byGroup.get(key) ?? { protocol: r.source, harness, requests: 0, promptTokens: 0, genTokens: 0, models: new Set<string>() }
      t.requests++
      t.promptTokens += r.prompt_tokens
      t.genTokens += r.gen_tokens
      if (r.model_key) t.models.add(r.model_key)
      byGroup.set(key, t)
    }

    return [...byGroup.values()].map((t) => ({
      protocol: t.protocol, harness: t.harness, requests: t.requests, promptTokens: t.promptTokens, genTokens: t.genTokens, distinctModels: t.models.size,
    }))
  }

  /** `code_daily`'s config block (spec 23 §3.6) for the local calendar day `dayIso`
   *  — `sessions`/`turns`/`toolCalls` only. `toolApprovals`/`toolDenials`/
   *  `compactions`/`worktreeSessions` need new instrumentation inside
   *  `code-session.ts` itself (no table records per-call approval decisions or
   *  compaction events today) and are a deliberate, tracked follow-up (TODO.md)
   *  rather than fabricated here. `agent_runs` is a Code session (`codeStats`'s own
   *  precedent for this join); `turns` counts assistant replies within one, the same
   *  unit `chatDailyStats` counts for regular chat. */
  codeDailyStats(dayIso: string): { sessions: number; turns: number; toolCalls: number } {
    const { start, end } = this.dayWindow(dayIso)
    const sessions = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM agent_runs ar JOIN conversations c ON c.id = ar.conv_id
      WHERE c.kind = 'code' AND ar.created_at >= ? AND ar.created_at < ?
    `).get(start, end) as unknown as { n: number }).n

    const rows = this.db.prepare(`
      SELECT m.tool_calls FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE c.kind = 'code' AND m.role = 'assistant' AND m.is_active = 1
        AND m.created_at >= ? AND m.created_at < ?
    `).all(start, end) as unknown as { tool_calls: string | null }[]

    let toolCalls = 0
    for (const r of rows) {
      if (!r.tool_calls) continue
      try {
        const parsed: unknown = JSON.parse(r.tool_calls)
        if (Array.isArray(parsed)) toolCalls += parsed.length
      } catch {
        // malformed tool_calls JSON — skip rather than crash a periodic rollup
      }
    }

    return { sessions, turns: rows.length, toolCalls }
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

  createAgentRun(params: { convId: string; title: string; allowedTools: string[]; agentId?: string; repoRoot?: string; repoBranch?: string; useWorktree?: boolean; worktreeBranch?: string; worktreeBase?: string; worktreePath?: string; codeAgent?: 'turbollm' | 'pi' | 'claude' | 'opencode' }): AgentRun {
    const id = randomUUID()
    const now = new Date().toISOString()
    const agentId = params.agentId ?? null
    // Code runs carry repo/worktree metadata (v28); background 'agent' runs pass none of it
    // and every code column is written NULL (byte-identical to the pre-v28 insert for them).
    this.db.prepare(`INSERT INTO agent_runs (id,conv_id,title,status,allowed_tools,agent_id,repo_root,repo_branch,use_worktree,worktree_branch,worktree_base,worktree_path,lines_added,lines_removed,code_agent,created_at,updated_at) VALUES ($id,$cid,$title,'queued',$at,$aid,$rr,$rb,$uw,$wb,$wbase,$wpath,$la,$lr,$ca,$now,$now)`)
      .run({
        $id: id, $cid: params.convId, $title: params.title, $at: JSON.stringify(params.allowedTools), $aid: agentId,
        $rr: params.repoRoot ?? null,
        $rb: params.repoBranch ?? null,
        $uw: params.useWorktree === undefined ? null : (params.useWorktree ? 1 : 0),
        $wb: params.worktreeBranch ?? null,
        $wbase: params.worktreeBase ?? null,
        $wpath: params.worktreePath ?? null,
        // Phase 1: diff stats are not computed yet — seed a code run's counters at 0 so the
        // sidebar shows +0/-0 rather than a blank; a background 'agent' run leaves them NULL.
        $la: params.repoRoot !== undefined ? 0 : null,
        $lr: params.repoRoot !== undefined ? 0 : null,
        $ca: params.codeAgent ?? null,
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

  updateAgentRun(id: string, patch: Partial<Pick<AgentRun, 'status' | 'error' | 'startedAt' | 'endedAt' | 'title' | 'compactionSummary' | 'compactionUpToMessageId' | 'compactionTokensBefore' | 'titleAutoSynced' | 'terminalLaunchedOnce'>>): boolean {
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
    if (patch.terminalLaunchedOnce     !== undefined) { sets.push('terminal_launched_once = $tlo'); params.$tlo = patch.terminalLaunchedOnce ? 1 : 0 }
    return ((this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  // ── Routine methods (v41 migration) ─────────────────────────────────────────

  createRoutine(params: {
    flavor: RoutineFlavor; prompt: string; scheduleDisplay: string; scheduleRule: ScheduleRule
    modelKey: string; agentId?: string; workspacePath?: string; codingAgent?: CodingAgentChoice
    permissionMode?: Routine['permissionMode']
  }): Routine {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO routines (id, flavor, status, prompt, schedule_display, schedule_rule, next_fire_at,
        model_key, agent_id, workspace_path, coding_agent, permission_mode, created_at, updated_at)
      VALUES ($id, $flavor, 'pending_confirmation', $prompt, $scheduleDisplay, $scheduleRule, NULL,
        $modelKey, $agentId, $workspacePath, $codingAgent, $permissionMode, $now, $now)
    `).run({
      $id: id, $flavor: params.flavor, $prompt: params.prompt,
      $scheduleDisplay: params.scheduleDisplay, $scheduleRule: JSON.stringify(params.scheduleRule),
      $modelKey: params.modelKey, $agentId: params.agentId ?? null, $workspacePath: params.workspacePath ?? null,
      $codingAgent: params.codingAgent ?? null, $permissionMode: params.permissionMode ?? null, $now: now,
    } as P)
    return this.getRoutine(id)!
  }

  getRoutine(id: string): Routine | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = $id').get({ $id: id } as P) as unknown as RoutineRow | undefined
    return row ? rowToRoutine(row) : null
  }

  listRoutines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY created_at DESC').all() as unknown as RoutineRow[]).map(rowToRoutine)
  }

  listDueRoutines(nowIso: string): Routine[] {
    const rows = this.db.prepare(
      `SELECT * FROM routines WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= $now`,
    ).all({ $now: nowIso } as P) as unknown as RoutineRow[]
    return rows.map(rowToRoutine)
  }

  confirmRoutine(id: string, nextFireAtIso: string): Routine | null {
    this.db.prepare(
      `UPDATE routines SET status = 'active', next_fire_at = $nextFireAt, updated_at = $now
       WHERE id = $id AND status = 'pending_confirmation'`,
    ).run({ $id: id, $nextFireAt: nextFireAtIso, $now: new Date().toISOString() } as P)
    return this.getRoutine(id)
  }

  updateRoutine(
    id: string,
    patch: Partial<Pick<Routine, 'prompt' | 'scheduleDisplay' | 'scheduleRule' | 'nextFireAt' | 'modelKey' | 'workspacePath' | 'codingAgent' | 'permissionMode' | 'status'>>,
  ): Routine | null {
    const sets: string[] = []
    const params: P = { $id: id } as P
    if (patch.prompt !== undefined) { sets.push('prompt = $prompt'); params.$prompt = patch.prompt }
    if (patch.scheduleDisplay !== undefined) { sets.push('schedule_display = $scheduleDisplay'); params.$scheduleDisplay = patch.scheduleDisplay }
    if (patch.scheduleRule !== undefined) { sets.push('schedule_rule = $scheduleRule'); params.$scheduleRule = JSON.stringify(patch.scheduleRule) }
    if (patch.nextFireAt !== undefined) { sets.push('next_fire_at = $nextFireAt'); params.$nextFireAt = patch.nextFireAt }
    if (patch.modelKey !== undefined) { sets.push('model_key = $modelKey'); params.$modelKey = patch.modelKey }
    if (patch.workspacePath !== undefined) { sets.push('workspace_path = $workspacePath'); params.$workspacePath = patch.workspacePath }
    if (patch.codingAgent !== undefined) { sets.push('coding_agent = $codingAgent'); params.$codingAgent = patch.codingAgent }
    if (patch.permissionMode !== undefined) { sets.push('permission_mode = $permissionMode'); params.$permissionMode = patch.permissionMode }
    if (patch.status !== undefined) { sets.push('status = $status'); params.$status = patch.status }
    if (sets.length === 0) return this.getRoutine(id)
    sets.push('updated_at = $now')
    params.$now = new Date().toISOString()
    this.db.prepare(`UPDATE routines SET ${sets.join(', ')} WHERE id = $id`).run(params)
    return this.getRoutine(id)
  }

  deleteRoutine(id: string): boolean {
    return ((this.db.prepare('DELETE FROM routines WHERE id = $id').run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  createRoutineRun(params: { routineId: string; configSnapshot: string }): RoutineRun {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO routine_runs (id, routine_id, status, config_snapshot, started_at)
       VALUES ($id, $routineId, 'running', $configSnapshot, $now)`,
    ).run({ $id: id, $routineId: params.routineId, $configSnapshot: params.configSnapshot, $now: now } as P)
    return this.getRoutineRun(id)!
  }

  getRoutineRun(id: string): RoutineRun | null {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE id = $id').get({ $id: id } as P) as unknown as RoutineRunRow | undefined
    return row ? rowToRoutineRun(row) : null
  }

  listRoutineRuns(routineId: string): RoutineRun[] {
    const rows = this.db.prepare(
      'SELECT * FROM routine_runs WHERE routine_id = $routineId ORDER BY started_at DESC',
    ).all({ $routineId: routineId } as P) as unknown as RoutineRunRow[]
    return rows.map(rowToRoutineRun)
  }

  /** Every run row currently parked awaiting an approval decision, across all routines.
   *  RoutineScheduler's `inFlight`/`parked` guard (routines/scheduler.ts) is in-memory only, so
   *  after a daemon restart it is silently empty even though these runs are still correctly
   *  'needs_approval' in the DB — `RoutineScheduler.start()` calls this to repopulate its guard
   *  BEFORE the first tick can fire a routine whose approval is still outstanding from before
   *  the restart. Unindexed scan is fine here: 'needs_approval' rows are rare (one per routine
   *  currently parked) and this only runs once, at startup. */
  listParkedRoutineRuns(): RoutineRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM routine_runs WHERE status = 'needs_approval'`,
    ).all() as unknown as RoutineRunRow[]
    return rows.map(rowToRoutineRun)
  }

  updateRoutineRun(
    id: string,
    patch: Partial<Pick<RoutineRun, 'status' | 'skipReason' | 'pendingToolCall' | 'result' | 'error' | 'endedAt' | 'conversationId' | 'codeSessionId'>>,
  ): RoutineRun | null {
    const sets: string[] = []
    const params: P = { $id: id } as P
    if (patch.status !== undefined) { sets.push('status = $status'); params.$status = patch.status }
    if (patch.skipReason !== undefined) { sets.push('skip_reason = $skipReason'); params.$skipReason = patch.skipReason }
    if (patch.pendingToolCall !== undefined) { sets.push('pending_tool_call = $pendingToolCall'); params.$pendingToolCall = patch.pendingToolCall }
    if (patch.result !== undefined) { sets.push('result = $result'); params.$result = patch.result }
    if (patch.error !== undefined) { sets.push('error = $error'); params.$error = patch.error }
    if (patch.endedAt !== undefined) { sets.push('ended_at = $endedAt'); params.$endedAt = patch.endedAt }
    if (patch.conversationId !== undefined) { sets.push('conversation_id = $conversationId'); params.$conversationId = patch.conversationId }
    if (patch.codeSessionId !== undefined) { sets.push('code_session_id = $codeSessionId'); params.$codeSessionId = patch.codeSessionId }
    if (sets.length === 0) return this.getRoutineRun(id)
    this.db.prepare(`UPDATE routine_runs SET ${sets.join(', ')} WHERE id = $id`).run(params)
    return this.getRoutineRun(id)
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
