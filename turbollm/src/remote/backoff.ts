/** Restart backoff for a provider that died unexpectedly (spec 30 §2.4): 1s doubling to a
 *  60s cap. The cap matters — a provider whose upstream is down should keep trying about
 *  once a minute forever rather than hammering it, and a user watching the UI should see a
 *  reconnect attempt at a human pace. */
export function backoffDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 60_000)
}

/** After this many consecutive failures the supervisor settles in `failed` and waits for a
 *  manual retry instead of looping forever. Ten attempts at the schedule above is ~3 minutes
 *  of trying, which is long enough to ride out a transient edge outage and short enough that
 *  a genuinely broken configuration reports itself rather than spinning silently. */
export const MAX_CONSECUTIVE_FAILURES = 10
