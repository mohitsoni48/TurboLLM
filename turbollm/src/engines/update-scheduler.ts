// Background auto-update checker (ADR-085, Phase 6, Layer 3). On daemon start and
// every UPDATE_CHECK_INTERVAL_MS, re-checks installed engines via the UpdateChecker.
// For 'auto' engines with an available update AND an idle engine, applies the Layer-2
// rollback-safe update; 'notify' just keeps the status fresh so the UI can badge it;
// 'off' is skipped. The "should this engine auto-apply now?" choice is the pure,
// unit-tested decideAutoUpdate() — this module is the thin scheduling/I-O shell.
//
// Why a callback for apply: the rollback-safe update lives behind the HTTP layer
// (registry + manager + provision wiring). The scheduler stays dependency-light and
// testable by taking an `applyUpdate(engine)` it can call when the pure decision says so.

import type { ConfigStore, Engine } from '../config/config'
import type { Manager } from './manager'
import { ProbeError } from './probe'
import type { Registry } from './registry'
import { UPDATE_CHECK_INTERVAL_MS, UpdateChecker, decideAutoUpdate, normalizeUpdatePolicy } from './update'

export interface UpdateSchedulerDeps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  updates: UpdateChecker
  /** Apply the rollback-safe update for one engine (Layer 2). Provided by the wiring
   *  layer; the scheduler only calls it when decideAutoUpdate() returns true. */
  applyUpdate: (engine: Engine) => Promise<void>
  /** The engine a running auto-tune tunes, or null (BenchRunner.tuningEngine). Its model is stopped between two probes,
   *  which engineIsIdle reads as idle, so an auto-update stopped the probe it caught and swapped the build under the
   *  rest of the run. That engine is skipped while the run lasts, and retried at the next check, as a busy one is. */
  tuningEngine?: () => Pick<Engine, 'id'> | null
}

/** Is the engine idle (safe to auto-apply an update)? Idle = not currently generating.
 *  We use the live manager state: a running engine with zero in-flight completions, or
 *  an engine that's simply stopped, is idle; one mid-generation is NOT (an update would
 *  kill the in-flight request). Best-effort and conservative — when in doubt, busy. */
export function engineIsIdle(manager: Manager): boolean {
  const st = manager.status()
  if (st.state === 'starting' || st.state === 'stopping') return false
  if (st.state !== 'running') return true // stopped/error → nothing generating
  // Running: idle only when no completion is streaming right now.
  return (manager.sessionStats().activeRequests ?? 0) === 0
}

export class UpdateScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  /** The first pass, 30 s after start. stop() cancels it too: a restart from a terminal keeps the old process as the
   *  keeper of its replacement (cli.ts becomeKeeper), where a pass still pending ran on, a check and perhaps an engine
   *  update applied from the old process, beside the replacement's own. */
  private firstPass: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** Per engine, the latest version whose auto-update failed its probe: the new build does not run on this machine,
   *  so applying it again only downloads it again (every check, for good). Skipped until upstream publishes another
   *  version or the daemon restarts; the user's own Update is never held back by it. */
  private failedProbe = new Map<string, string>()

  constructor(private deps: UpdateSchedulerDeps) {}

  /** Start the periodic checker. Runs one pass shortly after start, then every
   *  UPDATE_CHECK_INTERVAL_MS. Idempotent; unref'd so it never holds the process open. */
  start(): void {
    if (this.timer) return
    // First pass shortly after boot (let the daemon settle / engines seed first).
    this.firstPass = setTimeout(() => {
      this.firstPass = null
      void this.runOnce()
    }, 30_000)
    this.firstPass.unref()
    this.timer = setInterval(() => void this.runOnce(), UPDATE_CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.firstPass) {
      clearTimeout(this.firstPass)
      this.firstPass = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One scheduler pass: refresh statuses, then auto-apply for eligible engines. Guarded
   *  so overlapping ticks (a slow network pass) can't run concurrently. */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const engines = this.deps.registry.list().engines
      this.deps.updates.prune(new Set(engines.map((e) => e.id)))
      await this.deps.updates.checkAll(engines)
      for (const e of engines) {
        const policy = normalizeUpdatePolicy(e.updatePolicy)
        const status = this.deps.updates.get(e.id)
        const hasUpdate = !!status?.hasUpdate
        const idle = engineIsIdle(this.deps.manager) && this.deps.tuningEngine?.()?.id !== e.id
        if (decideAutoUpdate({ policy, hasUpdate, idle })) {
          const latest = status?.latest ?? ''
          if (this.failedProbe.get(e.id) === latest) continue
          try {
            await this.deps.applyUpdate(e)
            this.failedProbe.delete(e.id)
          } catch (err) {
            // Auto-apply failure: leave the engine as-is (rollback is the apply path's
            // job). The status stays cached; the next tick or a manual update retries —
            // except a build that failed its probe, which would fail it again.
            if (err instanceof ProbeError) this.failedProbe.set(e.id, latest)
          }
        }
      }
    } finally {
      this.running = false
    }
  }
}
