// Agent and Code session runs over the chat database (scalability review 5.7): the run rows and
// their lifecycle, each run's working doc, and the per-agent track record, lessons and skills.
// ConversationStore delegates to this with the same method names.
import { randomUUID } from 'node:crypto'
import type { SqlDb, SqlValue } from './store/sqlite-adapter.js'
import { keysetPage, type Changes, type P, type PageOpts } from './db-support.js'

import type { AgentLesson, AgentRun, AgentSkill, ModelStat, TrackRecordRow } from './db.js'
import { safeJson } from './db-support.js'

interface AgentRunRow { id: string; conv_id: string; title: string; status: string; allowed_tools: string; agent_id: string | null; error: string | null; created_at: string; updated_at: string; started_at: string | null; ended_at: string | null; archived_at: string | null; completion: string | null; repo_root: string | null; repo_branch: string | null; use_worktree: number | null; worktree_branch: string | null; worktree_base: string | null; worktree_path: string | null; lines_added: number | null; lines_removed: number | null; compaction_summary: string | null; compaction_upto_message_id: string | null; compaction_tokens_before: number | null; cleared_upto_message_id: string | null; reverted_from_message_id: string | null; title_auto_synced: number | null; code_agent: string | null; terminal_launched_once: number | null }

/** Agent-run list rows, slimmed the same way (getAgentRun has the summary). */
const AGENT_RUN_LIST_COLUMNS = `id, conv_id, title, status, allowed_tools, agent_id, error, created_at, updated_at, started_at, ended_at, archived_at, completion, repo_root, repo_branch, use_worktree, worktree_branch, worktree_base, worktree_path, lines_added, lines_removed, NULL AS compaction_summary, compaction_upto_message_id, compaction_tokens_before, cleared_upto_message_id, reverted_from_message_id, title_auto_synced, code_agent, terminal_launched_once`

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

/** agent_runs and the tables keyed by a run or an agent, over the same open handle as the ConversationStore that owns it. */
export class AgentRunRepo {
  constructor(private readonly db: SqlDb) {}

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
    return this.listAgentRunsPage(opts).runs
  }

  /** Agent runs, most recently updated first, a keyset page at a time (200 by default and at
   *  most), optionally only those in `statuses`. Rows leave out the compaction summary
   *  (AGENT_RUN_LIST_COLUMNS). */
  listAgentRunsPage(opts: { statuses?: string[] } & PageOpts = {}): { runs: AgentRun[]; nextCursor: string | null } {
    const params: P = {}
    opts.statuses?.forEach((s, i) => { params[`$s${i}`] = s })
    const where = opts.statuses?.length ? [`status IN (${opts.statuses.map((_, i) => `$s${i}`).join(',')})`] : []
    const { rows, nextCursor } = keysetPage<AgentRunRow>(this.db, {
      columns: AGENT_RUN_LIST_COLUMNS, table: 'agent_runs', sortColumn: 'updated_at', sortValue: (r) => r.updated_at, where, params,
    }, opts, 200, 200)
    return { runs: rows.map(rowToAgentRun), nextCursor }
  }

  updateAgentRun(id: string, patch: Partial<Pick<AgentRun, 'status' | 'error' | 'startedAt' | 'endedAt' | 'title' | 'compactionSummary' | 'compactionUpToMessageId' | 'compactionTokensBefore' | 'titleAutoSynced' | 'terminalLaunchedOnce'>>): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = $now']
    const params: Record<string, SqlValue> = { $id: id, $now: now }
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
    const params: Record<string, SqlValue> = { $id: runId, $c: completion, $now: now }
    if (archive) { sets.push('archived_at = $now') }
    return ((this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = $id`).run(params) as unknown) as Changes).changes > 0
  }

  /** Active (non-archived) runs, newest first. */
  listActiveAgentRuns(): AgentRun[] {
    return (this.db.prepare(`SELECT ${AGENT_RUN_LIST_COLUMNS} FROM agent_runs WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 200`).all() as unknown as AgentRunRow[]).map(rowToAgentRun)
  }

  /** Archived contracts, optionally filtered to one Hitman (§15). */
  listArchivedAgentRuns(agentId?: string): AgentRun[] {
    if (agentId) {
      return (this.db.prepare(`SELECT ${AGENT_RUN_LIST_COLUMNS} FROM agent_runs WHERE archived_at IS NOT NULL AND agent_id = $a ORDER BY archived_at DESC LIMIT 200`).all({ $a: agentId } as P) as unknown as AgentRunRow[]).map(rowToAgentRun)
    }
    return (this.db.prepare(`SELECT ${AGENT_RUN_LIST_COLUMNS} FROM agent_runs WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 200`).all() as unknown as AgentRunRow[]).map(rowToAgentRun)
  }

  /** Prune a deleted Hitman's track-record rows (agent_id is a config id, not a DB FK). */
  pruneTrackRecordForAgent(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_track_record WHERE agent_id = $a`).run({ $a: agentId } as P)
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
}
