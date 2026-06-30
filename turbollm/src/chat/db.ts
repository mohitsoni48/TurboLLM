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
  /** Conversation kind: 'chat' (default user-facing) or 'agent' (background agent run). */
  kind: 'chat' | 'agent'
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
}

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
  stats: Partial<MessageStats>
  /** F-021/F-022: research metadata (confidence, sources, referee verdicts). Absent on non-research messages. */
  researchMeta?: ResearchMeta
  createdAt: string
}

interface ConvRow { id: string; title: string; system_prompt: string; model_key: string; sampling: string; expert_mode: number; tool_policy: string | null; kind: string | null; folder_id: string | null; tool_overrides: string | null; agent_id: string | null; created_at: string; updated_at: string }
interface AgentRunRow { id: string; conv_id: string; title: string; status: string; allowed_tools: string; agent_id: string | null; error: string | null; created_at: string; updated_at: string; started_at: string | null; ended_at: string | null; archived_at: string | null; completion: string | null }
interface FolderRow { id: string; name: string; sort_order: number; created_at: string; updated_at: string }
interface MsgRow  { id: string; conv_id: string; seq: number; role: 'user' | 'assistant'; content: string; reasoning: string; attachments: string; text_attachments: string | null; tool_calls: string | null; stats: string; model_key: string | null; research_meta: string | null; created_at: string }

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
  return { id: r.id, title: r.title, systemPrompt: r.system_prompt, modelKey: r.model_key, sampling: safeJson(r.sampling) as Record<string, unknown>, expertMode: r.expert_mode === 1, toolPolicy: r.tool_policy ?? undefined, kind: (r.kind === 'agent' ? 'agent' : 'chat'), folderId: r.folder_id ?? null, toolOverrides: safeToolOverrides(r.tool_overrides), agentId: r.agent_id ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at }
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
  }
}

function rowToMsg(r: MsgRow): Message {
  const msg: Message = { id: r.id, convId: r.conv_id, seq: r.seq, role: r.role, content: r.content, reasoning: r.reasoning, attachments: safeJson(r.attachments) as string[], textAttachments: r.text_attachments ? safeJson(r.text_attachments) as string[] : [], toolCalls: r.tool_calls ? safeJson(r.tool_calls) as ToolCallRecord[] : [], stats: safeJson(r.stats) as Partial<MessageStats>, createdAt: r.created_at }
  if (r.research_meta) msg.researchMeta = safeJson(r.research_meta) as ResearchMeta
  return msg
}

interface Changes { changes: number }

export class ConversationStore {
  private db: DatabaseSync

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, 'turbollm.db'))
    this.migrate()
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
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN agent_id TEXT;
        PRAGMA user_version = 16;
      `)
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

  createConversation(partial?: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'modelKey' | 'sampling' | 'expertMode' | 'toolPolicy' | 'kind' | 'folderId' | 'agentId'>>): Conversation {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.prepare(`INSERT INTO conversations (id,title,system_prompt,model_key,sampling,expert_mode,tool_policy,kind,folder_id,agent_id,created_at,updated_at) VALUES ($id,$title,$sp,$mk,$samp,$expert,$tp,$kind,$fid,$aid,$now,$now)`)
      .run({ $id: id, $title: partial?.title ?? 'New chat', $sp: partial?.systemPrompt ?? '', $mk: partial?.modelKey ?? '', $samp: JSON.stringify(partial?.sampling ?? {}), $expert: partial?.expertMode ? 1 : 0, $tp: partial?.toolPolicy ?? null, $kind: partial?.kind ?? 'chat', $fid: partial?.folderId ?? null, $aid: partial?.agentId ?? null, $now: now } as P)
    return this.getConversation(id)!
  }

  getConversation(id: string, withMessages = false): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = $id`).get({ $id: id } as P) as unknown as ConvRow | undefined
    if (!row) return null
    const conv = rowToConv(row)
    if (withMessages) conv.messages = this.getMessages(id)
    return conv
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'systemPrompt' | 'sampling' | 'modelKey'>>): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = $now']
    const params: Record<string, SQLInputValue> = { $id: id, $now: now }
    if (patch.title !== undefined)        { sets.push('title = $title');      params.$title = patch.title }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = $sp'); params.$sp    = patch.systemPrompt }
    if (patch.sampling !== undefined)     { sets.push('sampling = $samp');    params.$samp  = JSON.stringify(patch.sampling) }
    if (patch.modelKey !== undefined)     { sets.push('model_key = $mk');     params.$mk    = patch.modelKey }
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

  getMessages(convId: string): Message[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id ORDER BY seq ASC`).all({ $id: convId } as P) as unknown as MsgRow[]).map(rowToMsg)
  }

  addMessage(convId: string, role: 'user' | 'assistant', content: string, extra?: Partial<Pick<Message, 'reasoning' | 'attachments' | 'textAttachments' | 'toolCalls' | 'stats'>>): Message {
    const id = randomUUID()
    const now = new Date().toISOString()
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS ms FROM messages WHERE conv_id = $id`).get({ $id: convId } as P) as unknown as { ms: number }
    // Attribute assistant replies to the conversation's model so the Models screen
    // can surface last-session gen t/s (spec 04 §5). User turns are left NULL.
    const modelKey = role === 'assistant' ? this.conversationModelKey(convId) : null
    const textAttachments = extra?.textAttachments?.length ? JSON.stringify(extra.textAttachments) : null
    const toolCalls = extra?.toolCalls?.length ? JSON.stringify(extra.toolCalls) : null
    this.db.prepare(`INSERT INTO messages (id,conv_id,seq,role,content,reasoning,attachments,text_attachments,tool_calls,stats,model_key,created_at) VALUES ($id,$cid,$seq,$role,$content,$reasoning,$attachments,$ta,$tc,$stats,$mk,$now)`)
      .run({ $id: id, $cid: convId, $seq: row.ms + 1, $role: role, $content: content, $reasoning: extra?.reasoning ?? '', $attachments: JSON.stringify(extra?.attachments ?? []), $ta: textAttachments, $tc: toolCalls, $stats: JSON.stringify(extra?.stats ?? {}), $mk: modelKey, $now: now } as P)
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

  updateMessage(id: string, patch: Partial<Pick<Message, 'content' | 'reasoning' | 'toolCalls' | 'stats' | 'researchMeta'>>): boolean {
    const sets: string[] = []
    const params: Record<string, SQLInputValue> = { $id: id }
    if (patch.content      !== undefined) { sets.push('content = $content');         params.$content      = patch.content }
    if (patch.reasoning    !== undefined) { sets.push('reasoning = $reasoning');     params.$reasoning    = patch.reasoning }
    if (patch.toolCalls    !== undefined) { sets.push('tool_calls = $tc');           params.$tc           = JSON.stringify(patch.toolCalls) }
    if (patch.stats        !== undefined) { sets.push('stats = $stats');             params.$stats        = JSON.stringify(patch.stats) }
    if (patch.researchMeta !== undefined) { sets.push('research_meta = $rm');        params.$rm           = JSON.stringify(patch.researchMeta) }
    if (!sets.length) return false
    return ((this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  deleteMessage(id: string): boolean {
    return ((this.db.prepare(`DELETE FROM messages WHERE id = $id`).run({ $id: id } as P) as unknown) as Changes).changes > 0
  }

  deleteMessagesAfterSeq(convId: string, seq: number): void {
    this.db.prepare(`DELETE FROM messages WHERE conv_id = $id AND seq > $seq`).run({ $id: convId, $seq: seq } as P)
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

  getLastMessage(convId: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE conv_id = $id ORDER BY seq DESC LIMIT 1`).get({ $id: convId } as P) as unknown as MsgRow | undefined
    return row ? rowToMsg(row) : null
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

  createAgentRun(params: { convId: string; title: string; allowedTools: string[]; agentId?: string }): AgentRun {
    const id = randomUUID()
    const now = new Date().toISOString()
    const agentId = params.agentId ?? null
    this.db.prepare(`INSERT INTO agent_runs (id,conv_id,title,status,allowed_tools,agent_id,created_at,updated_at) VALUES ($id,$cid,$title,'queued',$at,$aid,$now,$now)`)
      .run({ $id: id, $cid: params.convId, $title: params.title, $at: JSON.stringify(params.allowedTools), $aid: agentId, $now: now } as P)
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
      return (this.db.prepare(`SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`).all(params) as unknown as AgentRunRow[]).map(rowToAgentRun)
    }
    return (this.db.prepare(`SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 200`).all() as unknown as AgentRunRow[]).map(rowToAgentRun)
  }

  updateAgentRun(id: string, patch: Partial<Pick<AgentRun, 'status' | 'error' | 'startedAt' | 'endedAt'>>): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = $now']
    const params: Record<string, SQLInputValue> = { $id: id, $now: now }
    if (patch.status    !== undefined) { sets.push('status = $status');      params.$status  = patch.status }
    if (patch.error     !== undefined) { sets.push('error = $error');        params.$error   = patch.error }
    if (patch.startedAt !== undefined) { sets.push('started_at = $started'); params.$started = patch.startedAt }
    if (patch.endedAt   !== undefined) { sets.push('ended_at = $ended');     params.$ended   = patch.endedAt }
    return ((this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
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

  close(): void { this.db.close() }
}
