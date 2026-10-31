// Data retention (scalability review 2.4, docs/plans/2026-10-31-scalability-review.md). Two history tables grew by a
// row per event forever: `api_usage` (one per gateway request) and `routine_runs` (one per fire, each with the chat
// conversation or Code session it made). A daily sweep, also run once a minute after startup (never during boot):
//  - folds raw `api_usage` rows older than `apiUsageRawDays` into daily totals (`api_usage_daily`, db.ts v55), which
//    every reader sums with the raw rows, so the dashboards show the same numbers after a fold as before it;
//  - keeps the newest `routineRunsKept` runs per routine and deletes older ones, each with its own conversation, or its
//    Code session through the Code session delete's own cleanup (worktree, LSP clients, background jobs). A run still
//    running or parked for an approval is never deleted, nor one whose Code session has a turn in progress or a
//    worktree that cannot be removed (uncommitted work), nor one the user went on with after it ended: a run's chat
//    or Code session opens as a full interactive one (db.ts ROUTINE_RUN_CONTINUED). Kept runs still count toward the
//    newest `routineRunsKept`.
// Desktop runs node:sqlite synchronously on the event loop, so the work is done in small transactions with a yield to
// the event loop between them: at most RETENTION_BATCH_SIZE gateway usage rows, or ROUTINE_RUN_BATCH_SIZE routine runs
// (each run's delete cascades a whole chat's messages through the search index triggers). A first sweep over millions
// of rows never holds HTTP or SSE for long. One sweep at a time. Nothing here runs VACUUM: should one ever be added, the chat search
// FTS tables must be rebuilt after it (db.ts SEARCH_INDEX_SCHEMA).
//
// Left alone on purpose: memory_facts (the user's own content), ext_audit/ext_runs (the public API's audit trail),
// and the messages of ordinary chats.
import type { RetentionConfig } from '../config/config'
import type { CodeSessionDeletion } from '../deps'
import { daemonTick } from '../util/daemon-ticks'
import type { ApiUsageCursor, ConversationStore, PrunableRoutineRun } from './db'

/** Gateway usage rows per transaction. */
export const RETENTION_BATCH_SIZE = 500
/** Routine runs per transaction: each deletes a whole conversation, every message of it and its search index rows. */
export const ROUTINE_RUN_BATCH_SIZE = 25
const FIRST_SWEEP_DELAY_MS = 60_000
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000

export interface RetentionDeps {
  db: ConversationStore
  /** Read at each sweep, so a Settings change applies to the next one. */
  settings: () => RetentionConfig
  /** The Code session DELETE route's cleanup (Deps.deleteCodeSession). Absent where Code is not loaded; Code routine
   *  runs are then left alone rather than deleted without it. */
  deleteCodeSession?: (sessionId: string) => Promise<CodeSessionDeletion>
  log: (line: string) => void
  now?: () => Date
}

export interface RetentionSummary {
  apiUsageRolledUp: number
  routineRunsPruned: number
  conversationsDeleted: number
  codeSessionsDeleted: number
  batches: number
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export class RetentionSweeper {
  private inFlight: Promise<RetentionSummary | null> | null = null
  private firstSweep: ReturnType<typeof setTimeout> | null = null
  private daily: ReturnType<typeof setInterval> | null = null

  constructor(private readonly d: RetentionDeps) {}

  /** The first sweep a minute from now, then one a day. Neither timer keeps the process alive; the daily one is a
   *  daemonTick, which the restart keeper stops. */
  start(): void {
    this.firstSweep = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS)
    this.firstSweep.unref()
    this.daily = daemonTick(() => void this.sweep(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    if (this.firstSweep) clearTimeout(this.firstSweep)
    if (this.daily) clearInterval(this.daily)
    this.firstSweep = this.daily = null
  }

  /** Runs a sweep, or joins the one already running. Null when retention is off or the sweep failed (logged). */
  sweep(): Promise<RetentionSummary | null> {
    this.inFlight ??= this.run().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async run(): Promise<RetentionSummary | null> {
    try {
      const settings = this.d.settings()
      if (!settings.enabled) return null
      const summary: RetentionSummary = { apiUsageRolledUp: 0, routineRunsPruned: 0, conversationsDeleted: 0, codeSessionsDeleted: 0, batches: 0 }
      await this.rollUpApiUsage(settings.apiUsageRawDays, summary)
      await this.pruneRoutineRuns(settings.routineRunsKept, summary)
      this.d.log(
        `[retention] folded ${summary.apiUsageRolledUp} gateway usage rows into daily totals; pruned ${summary.routineRunsPruned} routine runs ` +
        `(${summary.conversationsDeleted} conversations, ${summary.codeSessionsDeleted} Code sessions) in ${summary.batches} batches`,
      )
      return summary
    } catch (e) {
      this.d.log(`[retention] retention sweep failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** Raw rows from before local midnight `rawDays` days ago, so each day is folded whole. */
  private async rollUpApiUsage(rawDays: number, summary: RetentionSummary): Promise<void> {
    const now = this.d.now?.() ?? new Date()
    const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - rawDays).toISOString()
    let cursor: ApiUsageCursor | null = null
    do {
      const batch = this.d.db.rollUpApiUsageBatch(before, RETENTION_BATCH_SIZE, cursor)
      summary.apiUsageRolledUp += batch.rolledUp
      summary.batches++
      cursor = batch.next
      await yieldToEventLoop()
    } while (cursor)
  }

  private async pruneRoutineRuns(keep: number, summary: RetentionSummary): Promise<void> {
    for (const routine of this.d.db.listRoutines()) {
      let after: PrunableRoutineRun | null = null
      for (;;) {
        const runs = this.d.db.routineRunsBeyondNewest(routine.id, keep, ROUTINE_RUN_BATCH_SIZE, after)
        if (runs.length === 0) break
        after = runs[runs.length - 1]
        const deleted = this.d.db.deleteRoutineRuns(await this.releaseCodeSessions(runs, summary))
        summary.routineRunsPruned += deleted.runs
        summary.conversationsDeleted += deleted.conversations
        summary.batches++
        await yieldToEventLoop()
      }
    }
  }

  /** Deletes the Code session of each Code run among `runs`; the runs that may go now. A run keeps its row when its
   *  session cannot be deleted (a turn in progress, a worktree with uncommitted work, or no Code cleanup here), so its
   *  session is never orphaned. One already gone lets its run go. */
  private async releaseCodeSessions(runs: PrunableRoutineRun[], summary: RetentionSummary): Promise<PrunableRoutineRun[]> {
    const deletable: PrunableRoutineRun[] = []
    for (const run of runs) {
      if (run.codeSessionId) {
        if (!this.d.deleteCodeSession) continue
        const result = await this.d.deleteCodeSession(run.codeSessionId)
        if (!result.deleted && result.reason === 'worktree_kept') {
          this.d.log(`[retention] kept routine run ${run.id}: its Code session ${run.codeSessionId} has a worktree that could not be removed (${result.worktreeNote})`)
        }
        if (!result.deleted && result.reason !== 'not_found') continue
        if (result.deleted) summary.codeSessionsDeleted++
      }
      deletable.push(run)
    }
    return deletable
  }
}
