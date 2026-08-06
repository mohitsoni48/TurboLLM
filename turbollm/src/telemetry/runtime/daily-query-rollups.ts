/**
 * Wires the three query-backed daily rollups (`chat_daily`, `gateway_daily`,
 * `code_daily` — spec 23 §3.4/3.5/3.6, ADR-333) into one periodic check.
 *
 * Unlike `feature_used_daily` (`daily-usage.ts`) or a future genuinely
 * in-memory-only rollup, none of these three accumulate anything: the
 * numbers come from a read-only query over tables that already durably
 * record everything needed (`ConversationStore.chatDailyStats`/
 * `gatewayDailyStats`/`codeDailyStats`). The only thing that needs tracking
 * across restarts is "which calendar day was last reported" — reusing
 * `DailyRollup` purely for that day-boundary detection (its own counters are
 * never bumped and never read) rather than inventing a second, near-identical
 * day-tracking mechanism.
 */

import type { ConversationStore } from '../../chat/db'
import type { Emitter } from '../emit'
import { emit } from './typed-emit'
import { DailyRollup } from './rollup'
import { chatDaily } from '../events/chat'
import { gatewayDaily } from '../events/gateway'
import { codeDaily } from '../events/code'

/**
 * Check whether the calendar day has rolled over since the last call, and if
 * so, query and emit yesterday's `chat_daily`/`gateway_daily`/`code_daily`.
 * Called from the same periodic interval as `flushDailyUsage()` (cli.ts) —
 * a missed check (daemon down at midnight) still reports the last real day
 * the next time the daemon runs, the same "don't wait forever for a day that
 * may never come" reasoning `daily-usage.ts`'s own rollover already uses.
 *
 * `today` is injectable (defaults to the real clock) so a test can simulate
 * a day boundary without waiting on the actual calendar — same pattern
 * `DailyRollup`/`Emitter` already use for exactly this reason.
 */
export function checkDailyQueryRollups(
  dataDir: string,
  db: ConversationStore,
  telemetry: Emitter,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): void {
  const boundary = new DailyRollup<Record<string, number>>(dataDir, 'daily-query-rollups', {}, today)
  const rolled = boundary.takeRolledOver()
  if (!rolled) {
    // A fresh `DailyRollup` is constructed on every call (no long-lived instance
    // to hold this in memory across calls, and none would survive a daemon
    // restart anyway), and `takeRolledOver()` only persists state on the
    // ROLLOVER branch — without this, "no rollover yet" is silently never
    // written to disk, so the NEXT call re-initializes to "today" all over
    // again and can never observe a real boundary crossing (found while
    // writing this module's own test: two calls on two different days both
    // reported "no rollover", because the first call's "today" was never
    // persisted for the second call to compare against).
    boundary.persist()
    return
  }

  const day = rolled.day

  const chat = db.chatDailyStats(day)
  emit(telemetry, chatDaily, chat)

  const code = db.codeDailyStats(day)
  emit(telemetry, codeDaily, code)

  for (const g of db.gatewayDailyStats(day)) {
    // Phase 5 (not built yet) is what turns this into a real per-client
    // breakdown — see events/gateway.ts's own doc comment.
    emit(telemetry, gatewayDaily, { harness: 'unknown', ...g })
  }
}
