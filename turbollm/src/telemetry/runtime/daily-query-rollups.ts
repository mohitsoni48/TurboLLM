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
import { DailyRollup, daysBetween } from './rollup'
import { chatDaily } from '../events/chat'
import { gatewayDaily, HARNESSES } from '../events/gateway'
import { codeDaily } from '../events/code'

const HARNESS_SET: ReadonlySet<string> = new Set(HARNESSES)

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
  // NEVER THROWS (ADR-009). Found during the v1.11.3 release gate: the three
  // `db.*DailyStats()` calls below were unguarded, and cli.ts drives this from a
  // bare `setInterval`. A throw from the SQLite layer — a locked file, a corrupt
  // page, schema drift after a downgrade — is therefore a synchronous throw in a
  // timer callback, and this process installs an `unhandledRejection` handler but
  // NO `uncaughtException` one, so Node's default applies and the daemon dies.
  // That orphans the llama-server child with the model still resident, which is
  // the exact cascade the crash-safety comment at the top of cli.ts exists to
  // prevent. Telemetry may not be a failure mode of the product; a lost rollup is
  // the correct price, and every other module in this directory already makes the
  // same trade.
  try {
    runDailyQueryRollups(dataDir, db, telemetry, today)
  } catch {
    // Best-effort by contract. The day's counters are lost when this fires —
    // `takeRolledOver()` has already reset and persisted the boundary — but a
    // missing rollup is recoverable and a dead daemon is not.
  }
}

function runDailyQueryRollups(
  dataDir: string,
  db: ConversationStore,
  telemetry: Emitter,
  today: () => string,
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
  const daysAgo = daysBetween(day, today())

  // ZERO-SUPPRESSION (2026-08-21 data-integrity audit). `chat_daily` and `code_daily`
  // used to be emitted unconditionally, right here, on any day boundary — so a machine
  // that had never opened Code still reported a `code_daily` every single day, carrying
  // an all-zero payload. The consequences were not subtle:
  //
  //   - 305 of 385 `code_daily` rows (79%) and 175 of 385 `chat_daily` rows (45%) were
  //     empty, so "98 machines use Code" actually meant 18. Real Code reach was 5x
  //     smaller than reported, and Gateway — which is zero-suppressed for free below,
  //     because it loops over DB rows that only exist when there was traffic — looked
  //     like half of Code when it is really 2.6x its size.
  //   - Because both fired from this one shared boundary check, the two events were
  //     byte-identical in every version bucket and on every day. That was the
  //     "some numbers are constant" symptom, and it made the pair useless as
  //     independent signals.
  //   - Every per-user average (`turns`, `messages`, `medianMessagesInConversation`)
  //     was diluted ~5x by the zero rows sitting in the denominator.
  //
  // A day with no activity is now simply not reported. Absence already means "no usage"
  // for `gateway_daily` and `feature_used_daily`; this makes all four agree, which is
  // the property that lets them be compared to each other at all.
  const chat = db.chatDailyStats(day)
  if (hasActivity(chat)) emit(telemetry, chatDaily, { ...chat, daysAgo })

  const code = db.codeDailyStats(day)
  if (hasActivity(code)) emit(telemetry, codeDaily, { ...code, daysAgo })

  for (const g of db.gatewayDailyStats(day)) {
    // db.ts stores whatever classifyHarness() produced (always a HARNESSES member) plus
    // 'unknown' for pre-Phase-5/unclassified rows — this membership check is defense-in-depth
    // against a hand-edited DB or a future direct writer, not an expected runtime path, and is
    // what lets `harness` below satisfy PayloadOf<>'s literal-enum type at all.
    const harness = HARNESS_SET.has(g.harness) ? (g.harness as (typeof HARNESSES)[number]) : 'unknown'
    emit(telemetry, gatewayDaily, { ...g, harness, daysAgo })
  }
}

/** Whether a rollup's counters describe anything that actually happened.
 *
 *  Deliberately "any counter non-zero" rather than naming one field per event:
 *  a future counter added to either payload is covered automatically, whereas a
 *  hand-picked sentinel field (`messages`, `sessions`) is exactly the kind of
 *  second list that goes stale the moment someone adds a field and forgets this
 *  call site — the failure mode ADR-333's registry redesign exists to stop. */
function hasActivity(counters: Record<string, number>): boolean {
  return Object.values(counters).some((n) => typeof n === 'number' && n > 0)
}
