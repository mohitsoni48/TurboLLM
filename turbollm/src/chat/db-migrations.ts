// The chat database's schema ladder (scalability review 5.7). MIGRATIONS is append-only and
// ordered: the step at index i brings user_version from i to i+1, so the array's length is the
// current schema version. To change the schema, append one function; never edit or reorder a step
// that has shipped (a database already past it would never run the edit), and never insert in the
// middle. Two branches that each append will conflict only on the line where the array ends.
//
// Every shipped step keeps the exact statements it had inline in ConversationStore, so a database
// at any older version migrates to the schema a fresh one gets (db-migrations.test.ts checks
// both, per version, on node:sqlite and sql.js). Versions 1..55 were consecutive, none skipped or
// reused, so no placeholder step is needed.
import { inTransaction, type SqlDb } from './store/sqlite-adapter.js'

/** What a migration step may use: the open database, and the few helpers the shipped steps need. */
export interface MigrationContext {
  db: SqlDb
  /** Whether `table` already has `column` — guards ADD COLUMN steps that may have
   *  already run under an earlier version number (this branch's migration ladder has
   *  been renumbered more than once across its history; a stored user_version can lag
   *  behind columns a prior run already added). */
  hasColumn(table: string, column: string): boolean
  maxRowid(table: string): number
  log(message: string): void
}

export type Migration = (ctx: MigrationContext) => void

/** A reply that recorded a usable generation speed — `typeof stats.tps === 'number' && tps > 0`,
 *  in SQL. It is both lastGenTpsByModel's filter and the WHERE of the partial index
 *  idx_messages_model_tps (v53): SQLite only uses a partial index when the query repeats its
 *  terms, so the two share this one string. The CASE keeps json_type/json_extract off malformed
 *  stats, where they would throw (and fail the write that stored them). */
export const USABLE_TPS_ROW = `role = 'assistant' AND model_key IS NOT NULL AND CASE WHEN json_valid(stats) THEN json_type(stats, '$.tps') IN ('integer', 'real') AND json_extract(stats, '$.tps') > 0 ELSE 0 END`

/** A chat turn's reply still holding the placeholder stats its turn started with (see
 *  abortUnfinishedReplies). Shared with the partial index idx_messages_unfinished (v53), as above. */
export const UNFINISHED_REPLY = `role = 'assistant' AND stats = '{"aborted":false}' AND edited = 0`

/** The rowids of each indexed table still waiting for the background backfill (search-index-backfill.ts):
 *  [next_rowid, end_rowid]. A table's row goes once its last batch is indexed; no rows, the index is complete. */
export const SEARCH_INDEX_BACKFILL_TABLE = `CREATE TABLE IF NOT EXISTS search_index_backfill (tbl TEXT PRIMARY KEY, next_rowid INTEGER NOT NULL, end_rowid INTEGER NOT NULL)`

/** Above this many messages, the v53 index build is announced: it reads the whole table once. */
const LARGE_HISTORY_ROWS = 100_000

/** Applied in order; index + 1 is the user_version a step leaves behind. */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  (ctx) => {
    ctx.db.exec(`
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
      `)
  },
  // v2 (spec 04 §5): attribute each assistant reply to the model that produced it
  // so the Models screen can show last-session gen t/s per model. Nullable — old
  // rows stay NULL and are simply not counted (non-breaking).
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE messages ADD COLUMN model_key TEXT;
        CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model_key, created_at);
      `)
  },
  // v3 (spec 08 §2): mark the built-in TurboLLM Expert thread so its server-managed
  // system prompt stays hidden from the UI. Additive — existing conversations get 0.
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE conversations ADD COLUMN expert_mode INTEGER NOT NULL DEFAULT 0;
      `)
  },
  // v4 (spec 07 §9b): store text-file attachment filenames on user messages so the
  // UI can render file chips in the sent bubble. Nullable — existing rows get NULL
  // and are decoded as [] in rowToMsg (non-breaking).
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE messages ADD COLUMN text_attachments TEXT;
      `)
  },
  // v5 (v0.7.0 agentic): store tool call records on assistant messages so the UI
  // can render tool invocations + results inline. Nullable — existing rows get NULL
  // and are decoded as [] in rowToMsg (non-breaking).
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE messages ADD COLUMN tool_calls TEXT;
      `)
  },
  // v6 (v0.7.0 agentic): per-conversation tool policy. 'force_web_search' forces
  // the model to call web_search on the first iteration. Nullable — existing rows
  // get NULL and default to standard auto tool_choice (non-breaking).
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE conversations ADD COLUMN tool_policy TEXT;
      `)
  },
  // v7 (F-021/F-022): research metadata — confidence score, ranked sources, and
  // referee verdicts stored as JSON alongside the assistant message. Nullable —
  // only set on Research-persona replies that use the retrieval service.
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE messages ADD COLUMN research_meta TEXT;
      `)
  },
  // v8 (ADR-112): background agent runs table. Each run maps to a dedicated
  // conversation of kind='agent'. Ring buffer events are in-memory only;
  // this table stores the durable run record and status.
  (ctx) => {
    ctx.db.exec(`
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
      `)
  },
  // v9 (ADR-112): conversations.kind column — 'chat' (default) or 'agent'.
  // Agent conversations are owned by a run and excluded from the chat sidebar.
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
      `)
  },
  // v10: chat folders. Flat (no nesting) — conversations reference a folder via the
  // nullable folder_id column. Deleting a folder UNASSIGNS its members (folder_id set
  // to NULL in app code — see deleteFolder), it never cascade-deletes conversations,
  // so no inline REFERENCES/ON DELETE constraint is added here. sort_order is reserved
  // for a future drag-to-reorder; folders currently list in insertion order.
  (ctx) => {
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        ALTER TABLE conversations ADD COLUMN folder_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_conversations_folder ON conversations(folder_id);
      `)
  },
  // v11 (tool-call approval gate): per-conversation "Allow for this chat" overrides,
  // persisted as JSON so they survive a restart. Nullable — existing rows get NULL
  // and are decoded as {} in rowToConv (non-breaking).
  (ctx) => {
    ctx.db.exec("ALTER TABLE conversations ADD COLUMN tool_overrides TEXT")
  },
  // v12: agent_runs.agent_id — link runs to the AgentType config.
  // Additive column; existing rows get NULL (backwards-compatible with pre-agent-id runs).
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE agent_runs ADD COLUMN agent_id TEXT;
      `)
  },
  // v13 (spec 13 §13): the durable working doc — one current doc per run. Survives
  // /compact (it is NOT part of the compressible transcript). Cascades on run delete.
  (ctx) => {
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_run_docs (
          run_id     TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
          content    TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
      `)
  },
  // v14 (spec 13 §13): per-Hitman track record — one row per finished contract
  // (incl. first-try successes). agent_id is a config id (not a DB FK); run_id cascades.
  (ctx) => {
    ctx.db.exec(`
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
      `)
  },
  // v15 (spec 13 §13): archive + completion outcome on the run row.
  (ctx) => {
    ctx.db.exec(`
        ALTER TABLE agent_runs ADD COLUMN archived_at TEXT;
        ALTER TABLE agent_runs ADD COLUMN completion TEXT;
      `)
  },
  // v16 (spec 13 redesign §1): bind a CHAT conversation to an Agent. Null = a plain
  // chat (no agent, no FS/tools). Additive; existing chats get NULL = unchanged behavior.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'agent_id')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT;`)
  },
  // v17 (spec 13 redesign §2/§3): completion marker on a conversation + the per-agent
  // lessons store (Reflexion). completed_at null = in-progress. agent_lessons is keyed by
  // the config agent id (not a DB FK); pruned when the agent is deleted.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'completed_at')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN completed_at TEXT;`)
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_lessons (
          id         TEXT PRIMARY KEY,
          agent_id   TEXT NOT NULL,
          lesson     TEXT NOT NULL,
          evidence   TEXT,
          conv_id    TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lessons_agent ON agent_lessons(agent_id, created_at);
      `)
  },
  // v18 (spec 13 redesign §3.3): per-agent SKILLS grown from experience (Voyager) — a
  // distilled name + description + procedure, injected on future runs. Keyed by config
  // agent id (not a DB FK); pruned on agent delete.
  (ctx) => {
    ctx.db.exec(`
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
      `)
  },
  // v19 (spec 13 redesign): per-conversation read scope — JSON array of file/folder paths
  // the bound agent may read. Read access is chat-bound (attached via picker), not agent-bound.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'read_scope')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN read_scope TEXT;`)
  },
  // v20: per-conversation pi permission mode ('ask'|'auto'|'bypass'|'read'). Null = 'auto'.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'agent_mode')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN agent_mode TEXT;`)
  },
  // v21: skill ids enabled for a conversation (JSON string[]) — the shared SKILL.md
  // library injected into chat directly, replacing the agent-bound tool/skill picker.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'skill_ids')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN skill_ids TEXT;`)
  },
  // v22 (Customize → Agents): tool-name allow-list baked in from a custom chat
  // Agent at conversation creation (JSON string[]). Null/absent = unrestricted —
  // built-in personas never set this, preserving today's behavior byte-for-byte.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'allowed_tools')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN allowed_tools TEXT;`)
  },
  // v23 (GitHub #52 item 2 — chat branching): regenerating a reply used to delete it
  // outright. Now the old message is kept and deactivated instead — `variant_group`
  // groups a message with its regenerated siblings (defaults to the group's own first
  // message id), `is_active` marks which one is currently shown/sent as history.
  // Existing rows default to is_active=1, variant_group=NULL (no branch UI for them).
  (ctx) => {
    if (!ctx.hasColumn('messages', 'variant_group')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN variant_group TEXT;`)
    if (!ctx.hasColumn('messages', 'is_active')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`)
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_variant_group ON messages(conv_id, variant_group);`)
  },
  // v24 (GitHub #52 item 2, extended to user-message edits): editing an earlier user
  // message used to hard-delete everything after it. Now that whole downstream tail is
  // frozen (deactivated) instead, tagged with `branch_of` = the specific message version
  // it was frozen under, so switching back to that version can restore exactly what was
  // there — including whichever regenerate-sibling (variant_group) was active within it.
  (ctx) => {
    if (!ctx.hasColumn('messages', 'branch_of')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN branch_of TEXT;`)
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_branch_of ON messages(conv_id, branch_of);`)
  },
  // v25 (GitHub #52 item 1): per-conversation "preserve thinking across turns" toggle.
  // Off by default — matches today's behavior, where only the final visible content of
  // past turns is ever resent to the engine, never raw reasoning.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'preserve_thinking')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN preserve_thinking INTEGER NOT NULL DEFAULT 0;`)
  },
  // v26: "Edited" tag — set only when a user explicitly edits an assistant reply's text
  // in place (the PUT /messages/:msgId assistant-role path), never by the normal
  // generation-completion save, so it means what it says.
  (ctx) => {
    if (!ctx.hasColumn('messages', 'edited')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;`)
  },
  // v27 (Release 3, auto-memory): durable facts extracted from the user's own chat
  // messages, injected into future new conversations. No FK to conversations — deleting
  // a source chat shouldn't delete the fact it produced (same provenance-column pattern
  // as agent_lessons above).
  (ctx) => {
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_facts (
          id             TEXT PRIMARY KEY,
          fact_text      TEXT NOT NULL,
          source_conv_id TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_facts_created ON memory_facts(created_at);
      `)
  },
  // v28 (Code, real pi-SDK agent): a 'code'-kind run stores the scratch/repo folder it
  // runs against (the pi cwd + containment root), the sidebar branch label, and the
  // composer's worktree intent (captured but NOT acted on in Phase 1). Diff stat columns
  // default to 0 for Phase 1. All additive + nullable — existing agent_runs rows get NULL
  // and are decoded as undefined in rowToAgentRun (non-breaking). hasColumn-guarded because
  // this branch's migration ladder has been renumbered before (see hasColumn's comment).
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'repo_root'))       ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN repo_root TEXT;`)
    if (!ctx.hasColumn('agent_runs', 'repo_branch'))     ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN repo_branch TEXT;`)
    if (!ctx.hasColumn('agent_runs', 'use_worktree'))    ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN use_worktree INTEGER;`)
    if (!ctx.hasColumn('agent_runs', 'worktree_branch')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN worktree_branch TEXT;`)
    if (!ctx.hasColumn('agent_runs', 'worktree_base'))   ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN worktree_base TEXT;`)
    if (!ctx.hasColumn('agent_runs', 'lines_added'))     ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN lines_added INTEGER;`)
    if (!ctx.hasColumn('agent_runs', 'lines_removed'))   ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN lines_removed INTEGER;`)
  },
  // v29 (Code, manual /compact): one active compaction per session — a summary plus the last
  // DB message id it covers. Not incremental (a second /compact re-summarizes everything up
  // to that point again, replacing the old summary), which keeps seedPriorHistory's replay
  // logic (code-session.ts) simple: at most one summary entry, then raw messages after it.
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'compaction_summary'))          ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN compaction_summary TEXT;`)
    if (!ctx.hasColumn('agent_runs', 'compaction_upto_message_id'))  ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN compaction_upto_message_id TEXT;`)
    if (!ctx.hasColumn('agent_runs', 'compaction_tokens_before'))    ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN compaction_tokens_before INTEGER;`)
  },
  // v30 (Code, /clear + /resume): a soft "clear chat" marker — the last DB message id
  // covered by a clear, mirroring compaction_upto_message_id's shape but with no summary
  // text (a clear is a blank slate, not a summarized carry-forward). Null = never cleared,
  // or resumed back from one. resolveEffectiveHistory (code-session.ts) takes whichever of
  // this and the compaction cut point is later in the message sequence.
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'cleared_upto_message_id')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN cleared_upto_message_id TEXT;`)
  },
  // v31 (Code, founder-reported gap 2026-07-13, item 6): an ordered text/tool-call timeline
  // for assistant messages, so a completed Code turn can render in TRUE chronological order
  // instead of today's fixed "reasoning → all tool calls grouped → final text" layout — the
  // persisted `content`+`toolCalls` shape has no interleave-position marker to reconstruct from.
  // JSON array of {type:'text',text} | {type:'tool',id} blocks (tool blocks reference an id in
  // `toolCalls` rather than duplicating it). Nullable — existing rows get NULL and the UI falls
  // back to the pre-fix grouped rendering for them (non-breaking, no backfill).
  (ctx) => {
    if (!ctx.hasColumn('messages', 'timeline')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN timeline TEXT;`)
  },
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
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'title_auto_synced')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN title_auto_synced INTEGER;`)
  },
  // v33 (Code, founder-reported bug 2026-07-17, found live against a real 40-message session):
  // revert-to-message previously reused clearedUpToMessageId (a movable prefix cursor), which
  // can only hide "everything before X, show everything after" — backwards from what a revert
  // needs (discard the reverted message and everything after it, keep everything before it),
  // and structurally incapable of that for any message that isn't already at the tail. Real
  // deactivation (is_active=0, the same mechanism Chat's branching already uses — getMessages()
  // filters is_active=1 unconditionally) fixes both: it needs a marker of its own so /resume
  // knows what to reactivate. Nullable — existing rows get NULL (never reverted).
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'reverted_from_message_id')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN reverted_from_message_id TEXT;`)
  },
  // v34 (GitHub #71): tokens hitting the gateway (/v1/messages, /v1/chat/completions) from
  // external clients — Claude Code, other CLIs/extensions — never landed in `messages` (that
  // table is chat-conversation rows only; gateway requests create no conversation). Usage was
  // silently invisible to the Tokens dashboard. One row per completed gateway request, kept
  // deliberately separate from `messages` (no conv_id/role — it isn't a chat turn) rather than
  // merged into the existing streak/session semantics there, which are chat-specific concepts.
  (ctx) => {
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS api_usage (
          id             TEXT PRIMARY KEY,
          created_at     TEXT NOT NULL,
          source         TEXT NOT NULL,
          model_key      TEXT,
          prompt_tokens  INTEGER NOT NULL DEFAULT 0,
          gen_tokens     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
      `)
  },
  // v35 (ADR-283, Code agent selector): which coding agent a session launches with
  // (config.ts's code.defaultAgent, snapshotted at creation). Additive + nullable —
  // existing rows get NULL, decoded as undefined (→ 'turbollm') in rowToAgentRun.
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'code_agent')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN code_agent TEXT;`)
  },
  // v36 (ADR-284, terminal-agent composer parity): api_usage rows gain a code_session_id
  // (which Code session a gateway request belongs to, resolved from the session-scoped
  // token — session-auth.ts) and duration_ms (elapsed wall-clock time of the request, so
  // prompt/gen tokens-per-second can be computed the same way lastRealStats already is for
  // chat sessions). Both additive + nullable — pre-existing rows (and any request whose
  // token doesn't resolve to a Code session) simply have no session/timing to attribute.
  (ctx) => {
    if (!ctx.hasColumn('api_usage', 'code_session_id')) ctx.db.exec(`ALTER TABLE api_usage ADD COLUMN code_session_id TEXT;`)
    if (!ctx.hasColumn('api_usage', 'duration_ms')) ctx.db.exec(`ALTER TABLE api_usage ADD COLUMN duration_ms INTEGER;`)
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_api_usage_code_session ON api_usage(code_session_id, created_at);`)
  },
  // v37 (terminal-agent auto-resume across a daemon restart): whether a terminal has ever
  // been created for this session — lets terminal-routes.ts tell a genuinely first-ever
  // launch apart from a restart-reconnect (the in-memory PTY died with the daemon, the
  // session didn't) and pass the CLI's own continue/resume flag on the latter. Additive +
  // defaulted to 0 — every pre-existing row reads as "never launched", which just means its
  // NEXT terminal open is treated as fresh (the same behavior as today), never wrongly
  // resumed into a conversation that was never actually interrupted.
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'terminal_launched_once')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN terminal_launched_once INTEGER NOT NULL DEFAULT 0;`)
  },
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
  (ctx) => {
    ctx.db.exec(`UPDATE agent_runs SET terminal_launched_once = 0;`)
  },
  // v39 (ADR-300): the engine's OWN per-phase rates, as llama.cpp measured them
  // (`timings.prompt_per_second` / `timings.predicted_per_second`). v36 stored only a single
  // `duration_ms` for the whole request and derived both rates from it, which cannot be right
  // for either phase — prefill and decode run one after the other, so dividing each token count
  // by the TOTAL duration understates both. Measured on a live claude session: 763 generated
  // tokens over a 62 s request read as 12.3 tok/s while the engine's own decode rate was ~78.
  // Additive + nullable: pre-existing rows keep the old derived approximation (below).
  (ctx) => {
    if (!ctx.hasColumn('api_usage', 'prompt_tps')) ctx.db.exec(`ALTER TABLE api_usage ADD COLUMN prompt_tps REAL;`)
    if (!ctx.hasColumn('api_usage', 'gen_tps')) ctx.db.exec(`ALTER TABLE api_usage ADD COLUMN gen_tps REAL;`)
  },
  // v40 (Code, real worktrees): the ABSOLUTE path of the git worktree a session actually runs
  // in, when it was created with "Use worktree". Kept separate from `repo_root` rather than
  // overwriting it: repo_root stays the base repository, which is what worktree removal has to
  // run `git worktree remove` FROM, and what the UI should keep showing as the session's project.
  // Null for every session that isn't using a worktree — including all existing rows, whose
  // `use_worktree` intent was captured but never acted on (v28's comment), so they correctly
  // decode as "no worktree" rather than claiming one that was never created.
  (ctx) => {
    if (!ctx.hasColumn('agent_runs', 'worktree_path')) ctx.db.exec(`ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT;`)
  },
  // v41 (Routines, Phase 1 foundation): scheduled tasks (chat or code) that fire on a
  // cron-like schedule. routine_runs cascades on routine delete (FK + ON DELETE CASCADE,
  // relying on the `PRAGMA foreign_keys = ON` set above) — unlike agent_runs' explicit
  // multi-table delete, a routine's runs have no other referents to clean up.
  (ctx) => {
    ctx.db.exec(`
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
      `)
  },
  // v42 (Routines: open a run as a real chat/Code session): a chat-flavor run already creates a
  // full conversation (chat-runner.ts) and a code-flavor run already creates a full Code session
  // (code-runner.ts) — both were previously un-lookup-able from the run row itself, so the only
  // way to see what a run actually did was the flattened `result` text. Nullable/additive: every
  // pre-existing run correctly decodes as "no linked session" (it genuinely has none — the id was
  // never persisted), falling back to `result`.
  (ctx) => {
    if (!ctx.hasColumn('routine_runs', 'conversation_id')) ctx.db.exec(`ALTER TABLE routine_runs ADD COLUMN conversation_id TEXT;`)
    if (!ctx.hasColumn('routine_runs', 'code_session_id')) ctx.db.exec(`ALTER TABLE routine_runs ADD COLUMN code_session_id TEXT;`)
  },
  // v43 (spec 23 §3.5, telemetry Phase 5): which coding-tool CLI made this gateway request,
  // classified from its User-Agent header (classify.ts's classifyHarness) at the two gateway
  // entry points (gateway.ts) — the gateway read zero request headers before this. Additive +
  // nullable: every pre-existing row simply has no header to have classified, and reads as
  // 'unknown' (gatewayDailyStats' own fallback), the same bucket a genuinely unrecognized
  // client falls into going forward.
  (ctx) => {
    if (!ctx.hasColumn('api_usage', 'harness')) ctx.db.exec(`ALTER TABLE api_usage ADD COLUMN harness TEXT;`)
  },
  // v44 (founder-reported: a terminal-agent session's ctx-fill ring jumped between full and
  // empty within the same session): getLastApiUsageForSession now picks the row with the
  // MAX prompt_tokens for the session instead of literally the most-recently-inserted one —
  // see that method's own doc comment for the full root cause (Task-tool sub-agent requests
  // share the main turn's code_session_id, and a smaller sub-agent row finishing after the
  // real turn used to silently win). This index serves that new query pattern the same way
  // idx_api_usage_code_session (v36) served the old ORDER BY created_at.
  (ctx) => {
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_api_usage_code_session_tokens ON api_usage(code_session_id, prompt_tokens);`)
  },
  (ctx) => {
    // Spec 27 §9.1: tenancy for the public chat API. Every column is NOT NULL with a
    // DEFAULT, so this is a metadata-only ALTER in SQLite and existing rows land in the
    // local scope untouched. hasColumn guards each ADD because this branch's ladder has
    // been renumbered before and a stored user_version can lag behind reality.
    if (!ctx.hasColumn('conversations', 'tenant'))   ctx.db.exec(`ALTER TABLE conversations ADD COLUMN tenant TEXT NOT NULL DEFAULT 'local';`)
    if (!ctx.hasColumn('conversations', 'owner'))    ctx.db.exec(`ALTER TABLE conversations ADD COLUMN owner TEXT NOT NULL DEFAULT 'default';`)
    if (!ctx.hasColumn('conversations', 'version'))  ctx.db.exec(`ALTER TABLE conversations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`)
    if (!ctx.hasColumn('conversations', 'metadata')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';`)

    if (!ctx.hasColumn('messages', 'tenant'))   ctx.db.exec(`ALTER TABLE messages ADD COLUMN tenant TEXT NOT NULL DEFAULT 'local';`)
    if (!ctx.hasColumn('messages', 'owner'))    ctx.db.exec(`ALTER TABLE messages ADD COLUMN owner TEXT NOT NULL DEFAULT 'default';`)
    if (!ctx.hasColumn('messages', 'status'))   ctx.db.exec(`ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';`)
    if (!ctx.hasColumn('messages', 'version'))  ctx.db.exec(`ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`)
    if (!ctx.hasColumn('messages', 'metadata')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';`)

    // The three indexes spec 27 §4.1 requires of every adapter. Unlike the ADD COLUMNs
    // these DO scan, so a large messages table takes a moment on first open after upgrade.
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_scope_updated ON conversations(tenant, owner, updated_at DESC);`)
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_scope_chat_seq ON messages(tenant, owner, conv_id, seq);`)
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_variant ON messages(tenant, conv_id, variant_group);`)

  },
  (ctx) => {
    // Phase 2 Task 4: folder scoping for the FolderStore capability group (spec 27
    // §4.2). Deliberately a NEW block rather than an extension of v45 above — v45 has
    // already run (and bumped user_version to 45) on every database that has been
    // opened since Task 1 landed, so an edit to that block would never execute again
    // on any of those databases and the folders columns would silently never appear.
    // hasColumn-guarded for the same reason as every other ALTER here: this ladder has
    // been renumbered before and a stored user_version can lag behind reality.
    if (!ctx.hasColumn('folders', 'tenant')) ctx.db.exec(`ALTER TABLE folders ADD COLUMN tenant TEXT NOT NULL DEFAULT 'local';`)
    if (!ctx.hasColumn('folders', 'owner'))  ctx.db.exec(`ALTER TABLE folders ADD COLUMN owner TEXT NOT NULL DEFAULT 'default';`)
    ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_scope ON folders(tenant, owner, sort_order);`)
  },
  (ctx) => {
    // Public API run records (spec 27 §6.4). Local-only: a run is node-local operational
    // state (an abort controller, a cursor, an engine target), never integrator data, so it
    // must NOT sit behind the pluggable store — that would force every adapter author to
    // build a job table before streaming worked at all.
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS ext_runs (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          tenant TEXT NOT NULL,
          owner TEXT NOT NULL,
          status TEXT NOT NULL,
          event_seq INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ext_runs_tenant ON ext_runs(tenant, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ext_runs_status ON ext_runs(status);
      `)
  },
  (ctx) => {
    // Audit trail for tenant-scoped mutations (spec 27 §10). There is deliberately NO
    // content column: the log records THAT a chat or message changed, never what was said.
    // A content-carrying audit log is a second, unscoped copy of every conversation.
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS ext_audit (
          id TEXT PRIMARY KEY,
          tenant TEXT NOT NULL,
          owner TEXT NOT NULL,
          action TEXT NOT NULL,
          target_id TEXT,
          request_id TEXT NOT NULL,
          status INTEGER NOT NULL,
          key_prefix TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ext_audit_tenant_at ON ext_audit(tenant, at DESC);
      `)
  },
  (ctx) => {
    // v49 (ADR-386, ctx-gauge-freeze fix): api_usage gains a `ctx_used` column that tracks the
    // current context size, updated during /compact so the ring reflects post-compaction reality.
    // `prompt_tokens` still carries the largest-request value (sub-agent safety net), but the
    // ring now reads `ctx_used` — the actual context window fill — which compaction updates.
    if (!ctx.hasColumn('api_usage', 'ctx_used')) ctx.db.exec(`ALTER TABLE api_usage ADD COLUMN ctx_used INTEGER DEFAULT 0;`)
  },
  // v50 (ADR-420): chat compaction — mirrors agent_runs's compaction_summary /
  // compaction_upto_message_id / compaction_tokens_before columns exactly (same names,
  // same semantics), so the pattern reads as one system across Chat and Code.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'compaction_summary'))         ctx.db.exec(`ALTER TABLE conversations ADD COLUMN compaction_summary TEXT;`)
    if (!ctx.hasColumn('conversations', 'compaction_upto_message_id')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN compaction_upto_message_id TEXT;`)
    if (!ctx.hasColumn('conversations', 'compaction_tokens_before'))   ctx.db.exec(`ALTER TABLE conversations ADD COLUMN compaction_tokens_before INTEGER;`)
  },
  // v51: when the compaction was applied. The chat header's context meter reads the LAST
  // assistant message's recorded ctxUsed — a measurement of what THAT turn actually sent,
  // which compaction deliberately never rewrites. So right after compacting, the meter
  // still shows the pre-compaction number and the feature looks like it did nothing
  // (founder-reported 2026-09-12). This timestamp is what lets the UI tell "that
  // measurement predates the compaction, project the new size" apart from "a real turn has
  // since run on the compacted prompt, trust the measurement" — the two cases are otherwise
  // indistinguishable, and survive a reload only if it's persisted.
  (ctx) => {
    if (!ctx.hasColumn('conversations', 'compaction_applied_at')) ctx.db.exec(`ALTER TABLE conversations ADD COLUMN compaction_applied_at TEXT;`)
  },
  // v52: a user turn's attached-document text (Message.docContext). It used to exist only in
  // the request that first sent the turn, so a regenerate or edit-and-resend sent the turn
  // again without its documents. Nullable, no default: most turns attach nothing.
  (ctx) => {
    if (!ctx.hasColumn('messages', 'doc_context')) ctx.db.exec(`ALTER TABLE messages ADD COLUMN doc_context TEXT;`)
  },
  // v53 (scalability review Tier 2): indexes so the hot reads stop scanning whole history
  // tables on the event loop. All CREATE INDEX IF NOT EXISTS, so a crash before the version
  // bump just re-runs them.
  //  - messages(created_at): the dashboards' and daily roll-ups' date ranges.
  //  - idx_messages_model_tps: partial, only replies that recorded a usable t/s, in
  //    (model_key, created_at, seq) order, so lastGenTpsByModel is one seek per model. Its
  //    WHERE must stay word-for-word USABLE_TPS_ROW, or SQLite will not use it.
  //  - idx_messages_unfinished: partial, only the turn placeholders the startup reconcile
  //    looks for, which a finished turn's stats save removes from it — so it stays tiny.
  //  - the list views' keyset orders: conversations by kind, agent runs, a routine's runs,
  //    memory facts.
  (ctx) => {
    const messages = ctx.maxRowid('messages')
    if (messages > LARGE_HISTORY_ROWS) ctx.log(`[db] indexing ${messages} chat messages, once; this can take a while`)
    ctx.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_model_tps ON messages(model_key, created_at, seq) WHERE ${USABLE_TPS_ROW};
        CREATE INDEX IF NOT EXISTS idx_messages_unfinished ON messages(conv_id) WHERE ${UNFINISHED_REPLY};
        CREATE INDEX IF NOT EXISTS idx_conversations_kind_updated ON conversations(kind, updated_at, id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_updated ON agent_runs(updated_at, id);
        CREATE INDEX IF NOT EXISTS idx_routine_runs_routine_started ON routine_runs(routine_id, started_at, id);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_created_id ON memory_facts(created_at, id);
      `)
  },
  // v54 (scalability review 2.2): full-text indexes for chat search, which used to LIKE-scan
  // every message body. The migration adds only the backfill's progress table, on every
  // runtime; the index itself follows the runtime that opens the database (reconcileSearchIndex),
  // since only some have FTS5: node:sqlite from Node 22.16, never the bundled sql.js (Android).
  (ctx) => {
    ctx.db.exec(SEARCH_INDEX_BACKFILL_TABLE)
  },
  // v55 (scalability review 2.4, data retention): `api_usage` gains a row per gateway request
  // forever. The retention sweep (chat/retention.ts) folds rows older than its cutoff into one
  // row per local day and dashboard group here, then deletes them; every reader sums both.
  // model_key/harness hold '' for api_usage's NULL, so the primary key can upsert them.
  // first_at/first_seq carry the group's earliest created_at and rowid, which apiUsageStats
  // orders its groups by. idx_api_usage_code_session_ctx finds a Code session's peak-context
  // row (getLastApiUsageForSession's MAX), which the sweep keeps raw, in one seek.
  (ctx) => {
    ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS api_usage_daily (
          day           TEXT NOT NULL,
          source        TEXT NOT NULL,
          model_key     TEXT NOT NULL DEFAULT '',
          harness       TEXT NOT NULL DEFAULT '',
          requests      INTEGER NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          gen_tokens    INTEGER NOT NULL,
          first_at      TEXT NOT NULL,
          first_seq     INTEGER NOT NULL,
          PRIMARY KEY (day, source, model_key, harness)
        );
        CREATE INDEX IF NOT EXISTS idx_api_usage_code_session_ctx ON api_usage(code_session_id, ctx_used);
      `)
  },
]

function contextFor(db: SqlDb): MigrationContext {
  return {
    db,
    hasColumn: (table, column) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((r) => r.name === column),
    maxRowid: (table) => (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`).get() as { n: number }).n,
    log: (message) => console.log(message),
  }
}

/** Brings `db` to schema version `upTo` (default: the latest). Each step runs once, when the
 *  database is older, as one transaction together with its user_version bump: a step that throws
 *  (or a crash midway) leaves neither half of it, and the next open runs it again. PRAGMAs that do
 *  nothing inside a transaction (journal_mode, foreign_keys) stay in this preamble, outside every step. */
export function runMigrations(db: SqlDb, upTo: number = MIGRATIONS.length): void {
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`)
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const ctx = contextFor(db)
  for (let version = current + 1; version <= upTo; version++) {
    inTransaction(db, () => {
      MIGRATIONS[version - 1](ctx)
      db.exec(`PRAGMA user_version = ${version}`)
    })
  }
}
