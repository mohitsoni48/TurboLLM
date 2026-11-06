// Routines and their run history over the chat database (scalability review 5.7), including the
// paging and retention helpers. ConversationStore delegates to this with the same method names.
import { randomUUID } from 'node:crypto'
import { inTransaction, type SqlDb } from './store/sqlite-adapter.js'
import { keysetPage, type Changes, type P, type PageOpts } from './db-support.js'

import type { CodingAgentChoice, Routine, RoutineFlavor, RoutineRun, RoutineRunStatus, RoutineStatus, ScheduleRule } from '../routines/schema'
import type { PrunableRoutineRun } from './db.js'

/** True (SQL, over `routine_runs r`) when someone went on with a routine run's chat or Code session after the run
 *  ended: either opens as a full interactive chat (RoutineEditPage), so the retention sweep must never delete it then.
 *  The signal is the messages, not conversations.updated_at, which renames, folder moves and auto-titles also touch.
 *  A user message after the end is the user's own (every prompt a run sends is written before it ends); any message
 *  more than a minute after the end is a regenerate or the like (a run's own reply may still be saved just after the
 *  end, so not every later message counts). A run with no end recorded is measured from its start, which its own
 *  prompt always follows: kept, when unsure. */
const ROUTINE_RUN_CONTINUED = `EXISTS (
  SELECT 1 FROM messages m
  WHERE m.conv_id IN (r.conversation_id, (SELECT a.conv_id FROM agent_runs a WHERE a.id = r.code_session_id))
    AND (
      (m.role = 'user' AND m.created_at > COALESCE(r.ended_at, r.started_at))
      OR m.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(r.ended_at, r.started_at), '+60 seconds')
    )
)`

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

/** Routine and routine_runs rows, over the same open handle as the ConversationStore that owns it. */
export class RoutineRepo {
  constructor(private readonly db: SqlDb) {}

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

  /** A routine's runs, newest first, a keyset page at a time (50 by default, 200 at most) —
   *  its history grows by a row per fire for good. Full rows: the run list shows `result`. */
  listRoutineRunsPage(routineId: string, page: PageOpts = {}): { runs: RoutineRun[]; nextCursor: string | null } {
    const { rows, nextCursor } = keysetPage<RoutineRunRow>(this.db, {
      columns: '*', table: 'routine_runs', sortColumn: 'started_at', sortValue: (r) => r.started_at,
      where: ['routine_id = $routineId'], params: { $routineId: routineId },
    }, page, 50, 200)
    return { runs: rows.map(rowToRoutineRun), nextCursor }
  }

  countRoutineRuns(routineId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = $routineId').get({ $routineId: routineId } as P) as { n: number }).n
  }

  /** Retention (scalability review 2.4): up to `limit` of a routine's runs older than its newest
   *  `keep`, oldest first, after `after` — never one still running or parked for an approval, nor
   *  one the user went on with (ROUTINE_RUN_CONTINUED). Those still count toward the newest `keep`.
   *  Both seeks walk idx_routine_runs_routine_started. */
  routineRunsBeyondNewest(routineId: string, keep: number, limit: number, after: Pick<PrunableRoutineRun, 'startedAt' | 'id'> | null = null): PrunableRoutineRun[] {
    const oldestKept = this.db.prepare(`
      SELECT started_at, id FROM routine_runs WHERE routine_id = $routineId
      ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET $offset
    `).get({ $routineId: routineId, $offset: keep - 1 } as P) as { started_at: string; id: string } | undefined
    if (!oldestKept) return []
    const rows = this.db.prepare(`
      SELECT id, started_at, conversation_id, code_session_id FROM routine_runs r
      WHERE routine_id = $routineId
        AND (started_at < $keptAt OR (started_at = $keptAt AND id < $keptId))
        ${after ? 'AND (started_at > $afterAt OR (started_at = $afterAt AND id > $afterId))' : ''}
        AND status NOT IN ('running', 'needs_approval')
        AND NOT ${ROUTINE_RUN_CONTINUED}
      ORDER BY started_at, id LIMIT $limit
    `).all({
      $routineId: routineId, $keptAt: oldestKept.started_at, $keptId: oldestKept.id, $limit: limit,
      ...(after ? { $afterAt: after.startedAt, $afterId: after.id } : {}),
    } as P) as unknown as { id: string; started_at: string; conversation_id: string | null; code_session_id: string | null }[]
    return rows.map((r) => ({ id: r.id, startedAt: r.started_at, conversationId: r.conversation_id, codeSessionId: r.code_session_id }))
  }

  /** Deletes `runs` and each one's own chat conversation (chat-runner.ts creates a kind='agent'
   *  one per run; its messages go with it, ON DELETE CASCADE), in one transaction. A linked
   *  conversation of any other kind is left alone. A code run's session is not touched here: it
   *  is deleted first, through the Code session delete's own cleanup (chat/retention.ts). A run
   *  the user went on with since it was listed (ROUTINE_RUN_CONTINUED) is skipped, with its chat. */
  deleteRoutineRuns(runs: PrunableRoutineRun[]): { runs: number; conversations: number } {
    return inTransaction(this.db, () => {
      const continued = this.db.prepare(`SELECT 1 AS yes FROM routine_runs r WHERE r.id = $id AND ${ROUTINE_RUN_CONTINUED}`)
      const delRun = this.db.prepare(`DELETE FROM routine_runs WHERE id = $id`)
      const delConv = this.db.prepare(`DELETE FROM conversations WHERE id = $id AND kind = 'agent'`)
      let deletedRuns = 0, conversations = 0
      for (const run of runs) {
        if (continued.get({ $id: run.id } as P)) continue
        deletedRuns += ((delRun.run({ $id: run.id } as P) as unknown) as Changes).changes
        if (run.conversationId) conversations += ((delConv.run({ $id: run.conversationId } as P) as unknown) as Changes).changes
      }
      return { runs: deletedRuns, conversations }
    })
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

  /** Every run row still at 'running', across all routines — read once by
   *  `RoutineScheduler.start()` to close out runs a daemon restart cut off. Unindexed scan, for
   *  the same reason as listParkedRoutineRuns above. */
  listRunningRoutineRuns(): RoutineRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM routine_runs WHERE status = 'running'`,
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
}
