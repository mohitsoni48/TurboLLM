import { useEffect, useRef } from 'react'
import type { Routine, RoutineRun } from './routine-types'
import { useRoutinesWithLatestRun, type RoutineWithLatestRun } from './routine-queries'

/** Swappable notification-dispatch interface (spec 20 §7) — today's only implementation is a
 *  best-effort browser Notification call. A future Electron build adds a real native-OS
 *  implementation and passes it into {@link useRoutineNotificationPoller} instead of touching any
 *  call site; the in-app Routines inbox (already built — RoutinesPanel/RoutineEditPage's run
 *  history) remains the durable channel regardless of what this does. */
export interface NotifyRoutineResult {
  (routine: Routine, run: RoutineRun): void
}

function summaryFor(routine: Routine, run: RoutineRun): { title: string; body: string } {
  if (run.status === 'needs_approval') return { title: 'Routine needs approval', body: `"${routine.prompt}" is waiting on you to approve a tool call.` }
  if (run.status === 'errored') return { title: 'Routine errored', body: `"${routine.prompt}" failed: ${run.error ?? 'see the Routines panel for details.'}` }
  if (run.status === 'skipped') return { title: 'Routine skipped', body: `"${routine.prompt}" was skipped${run.skipReason ? ` (${run.skipReason})` : ''}.` }
  return { title: 'Routine finished', body: `"${routine.prompt}" ran successfully.` }
}

/** Best-effort — only fires if a tab is open AND Notification permission was already granted
 *  (this module never itself calls Notification.requestPermission(); that's a separate, explicit
 *  user action elsewhere, out of scope for this phase). Never throws: an unsupported, partially
 *  polyfilled, blocked or denied environment is silently a no-op, exactly as spec 20 §7 describes
 *  this channel.
 *
 *  The whole body is guarded, not just the constructor call the plan wrapped: an embedder can also
 *  throw on merely READING `Notification.permission` (a permissions-policy-blocked iframe), and a
 *  throw escaping here would propagate out of the poller's effect and into the app shell —
 *  taking down the durable in-app channel this is only supposed to supplement. */
export const browserNotifyRoutineResult: NotifyRoutineResult = (routine, run) => {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const { title, body } = summaryFor(routine, run)
    new Notification(title, { body })
  } catch { /* best-effort; never blocks the durable in-app channel */ }
}

/** Statuses worth notifying about — 'running' is excluded (nothing to tell the user yet).
 *  'needs_approval' counts: the run is parked and will not move until the user acts, which is
 *  precisely when a notification earns its keep. */
const TERMINAL: RoutineRun['status'][] = ['ok', 'errored', 'skipped', 'needs_approval']

/** Runs whose status CHANGED into a terminal one since `previouslySeen` was captured.
 *
 *  Deviates from the plan's literal `if (prevStatus !== run.status)`, which fails the plan's own
 *  first test: an unseen run id yields `undefined`, and `undefined !== 'ok'` reports it. The rule
 *  here is deliberately "a status we ALREADY OBSERVED for this run id has changed" — a run id
 *  absent from the previous snapshot is never reported, whatever its status.
 *
 *  That stricter rule is load-bearing well past the first poll, because
 *  `useRoutinesWithLatestRun` resolves in two stages: the routines list first, each routine's runs
 *  a render later. Treating "unseen" as "new" would therefore fire a notification for every
 *  routine's last completed run every single time the app is opened — and no "have we primed yet"
 *  flag can tell that second render apart from a genuine new run, since both are simply "a
 *  terminal run id I have not recorded".
 *
 *  The cost is one missed notification class: a run that starts AND finishes inside a single poll
 *  interval is never observed as 'running', so it is never announced. Acceptable for a channel
 *  spec 20 §7 defines as best-effort supplementary — the run still lands in the run history, which
 *  is the durable channel. */
export function diffNewlyTerminalRuns(items: RoutineWithLatestRun[], previouslySeen: Map<string, RoutineRun['status']>): RoutineWithLatestRun[] {
  const result: RoutineWithLatestRun[] = []
  for (const it of items) {
    const run = it.latestRun
    if (!run || !TERMINAL.includes(run.status)) continue
    const prevStatus = previouslySeen.get(run.id)
    if (prevStatus === undefined || prevStatus === run.status) continue
    result.push(it)
  }
  return result
}

/** Mounted once at the app shell level (App.tsx) — reads the same `useRoutinesWithLatestRun` data
 *  the Routines panel and the nav badge already use (same query keys, so this adds no extra
 *  network traffic), diffs it against the previous poll, and fires `notify` for every run that
 *  just became newly terminal. Takes `notify` as a parameter (defaulting to the browser
 *  implementation) purely so a future Electron build swaps it in without touching this logic.
 *
 *  KNOWN LIMITATION (not a defect to fix here): the underlying queries set
 *  `refetchIntervalInBackground: false`, so polling pauses while the tab is hidden — the moment a
 *  browser notification would be most useful. Results that landed while away are announced on the
 *  next tick after the tab regains focus rather than in real time. Changing that would make three
 *  shared queries poll forever in every background tab, a cross-cutting cost well beyond this
 *  best-effort channel; the in-app run history stays authoritative either way. */
export function useRoutineNotificationPoller(notify: NotifyRoutineResult = browserNotifyRoutineResult): void {
  const { items } = useRoutinesWithLatestRun()
  const seen = useRef(new Map<string, RoutineRun['status']>())

  useEffect(() => {
    for (const it of diffNewlyTerminalRuns(items, seen.current)) {
      const run = it.latestRun
      if (!run) continue
      // A throwing implementation must neither escape into the app shell nor abort the snapshot
      // update below — skipping the update would make every later poll retry the same failing
      // dispatch forever.
      try { notify(it.routine, run) } catch { /* best-effort channel; the run history still has it */ }
    }
    // Rebuilt rather than mutated in place: one entry per CURRENTLY-latest run keeps this bounded
    // for a long-lived tab (a frequent routine would otherwise accumulate an entry per completed
    // run forever). Dropping a forgotten id can only ever cost a notification, never duplicate
    // one, since an unrecorded id is never reported.
    const next = new Map<string, RoutineRun['status']>()
    for (const it of items) if (it.latestRun) next.set(it.latestRun.id, it.latestRun.status)
    seen.current = next
  }, [items, notify])
}
