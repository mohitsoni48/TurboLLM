/**
 * The journey-event emitter (ADR-299 Decision 6).
 *
 * One place owns every reason not to send: the kill switch, the consent level,
 * the per-event level requirement, and the once-only ledger. Call sites just
 * say what happened — they cannot accidentally bypass a check, because they
 * never see one.
 *
 * Everything here is fire-and-forget and non-throwing (ADR-009). A call site
 * that reports "the user opened Code for the first time" must never be able to
 * fail because of telemetry.
 */

import { randomUUID } from 'node:crypto'
import { enqueue } from './queue'
import { claimOnce } from './ledger'
import { telemetryDisabled } from './disabled'
import { TELEMETRY_SCHEMA_VERSION, type EventName } from './schema'
import { recordFeatureUse, flushStaleDailyUsage, persistDailyUsage } from './daily-usage'

/** Just enough of ConfigStore for the emitter — kept structural so tests need
 *  no real config file. */
interface StoreLike {
  snapshot(): { telemetry: { level: string; machineId: string } }
  update(fn: (c: { telemetry: { level: string; machineId: string } }) => void): void
}

export interface EmitterOpts {
  dataDir: string
  store: StoreLike
  version: string
  os: string
  /** Injectable so the daily-dedupe logic is testable without waiting a day. */
  today?: () => string
}

/** Events that require the `full` level. Crash diagnostics are the extra step a
 *  user opts into separately; `anon` must not send them. */
const REQUIRES_FULL = new Set<EventName>(['error'])

export class Emitter {
  private readonly o: EmitterOpts
  private readonly today: () => string

  constructor(opts: EmitterOpts) {
    this.o = opts
    this.today = opts.today ?? (() => new Date().toISOString().slice(0, 10))
  }

  /**
   * Whether this event may be sent right now — kill switch, consent level, and
   * the per-event level requirement.
   *
   * Public because the once-only helpers MUST consult it before spending a
   * ledger claim. Claiming first would mean a user who browses the app before
   * answering the consent card burns every `first_use` key while telemetry is
   * off, and opting in afterwards would permanently lose the whole
   * feature-discovery picture — the exact data this system exists to collect.
   */
  canSend(event: EventName): boolean {
    if (telemetryDisabled()) return false
    const level = this.o.store.snapshot().telemetry.level
    if (level !== 'anon' && level !== 'full') return false
    if (REQUIRES_FULL.has(event) && level !== 'full') return false
    return true
  }

  /** Emit one event. Silently does nothing whenever it must not send. */
  emit(event: EventName, payload?: Record<string, unknown>): void {
    try {
      if (!this.canSend(event)) return

      enqueue(this.o.dataDir, {
        schema: TELEMETRY_SCHEMA_VERSION,
        event,
        ts: new Date().toISOString(),
        machineId: this.machineId(),
        app: { version: this.o.version, os: this.o.os },
        ...(payload === undefined ? {} : { payload }),
      })
    } catch {
      // Best-effort by contract.
    }
  }

  /** Emit an event at most once for the lifetime of this install (e.g.
   *  `app_first_run`, which must count installs — not daemon starts). */
  once(event: EventName): void {
    if (!this.canSend(event)) return
    if (this.claim(`once:${event}`)) this.emit(event)
  }

  /** Emit `feature_first_use` the first time a feature is touched, ever. */
  firstUse(feature: string): void {
    if (!this.canSend('feature_first_use')) return
    if (this.claim(`first_use:${feature}`)) this.emit('feature_first_use', { feature })
  }

  /** Emit `daily_active` at most once per calendar day. */
  dailyActive(): void {
    if (!this.canSend('daily_active')) return
    if (this.claim(`daily:${this.today()}`)) this.emit('daily_active')
  }

  /**
   * Count one use of `feature` toward today's tally, emitting a bucketed
   * `feature_used_daily` for the previous day the moment the calendar day
   * rolls over. Consent is checked BEFORE any count is recorded — same
   * reasoning as `firstUse` above (see its doc comment): usage while
   * telemetry is off must never silently contribute to a count reported
   * after the user opts in later.
   */
  useFeature(feature: string): void {
    if (!this.canSend('feature_used_daily')) return
    const rolled = recordFeatureUse(this.o.dataDir, feature, this.today())
    if (rolled) this.emit('feature_used_daily', { feature, countBucket: rolled.bucket })
  }

  /**
   * Roll over any feature whose tally is from a day earlier than today, then
   * persist whatever's left (today's still-in-progress counts) to disk.
   * Called periodically (cli.ts, alongside the queue flush) for two reasons:
   * a feature used only on a user's LAST active day still gets reported
   * instead of waiting indefinitely for a next use that may never come, AND
   * same-day counts — which `useFeature` only ever keeps in memory, to avoid
   * a disk write on every matching API request — get a chance to survive a
   * crash instead of living only until the next rollover.
   */
  flushDailyUsage(): void {
    if (!this.canSend('feature_used_daily')) return
    for (const { feature, bucket } of flushStaleDailyUsage(this.o.dataDir, this.today())) {
      this.emit('feature_used_daily', { feature, countBucket: bucket })
    }
    persistDailyUsage(this.o.dataDir)
  }

  /**
   * Emit `error` — full level only (`REQUIRES_FULL` above), and deliberately
   * NOT once-only: unlike `model_first_load`'s single most-valuable-attempt
   * signal, every crash after the first is still a real data point (ADR-299's
   * "what is failing?" journey question, previously never wired to anything).
   */
  error(fingerprint: string): void {
    this.emit('error', { fingerprint })
  }

  /**
   * Mint the anonymous machine id lazily.
   *
   * Never called while consent is off, because `emit` returns before this
   * point — an install that never opts in must not even have an id generated
   * for it.
   */
  private machineId(): string {
    const existing = this.o.store.snapshot().telemetry.machineId
    if (existing) return existing
    const id = randomUUID()
    this.o.store.update((c) => {
      if (!c.telemetry.machineId) c.telemetry.machineId = id
    })
    return id
  }

  /** Record a once-only key. Returns whether THIS call claimed it (i.e. whether
   *  the caller should go on to emit). Shared with the consent ping so both
   *  agree on what "once" means. */
  private claim(key: string): boolean {
    return claimOnce(this.o.dataDir, key)
  }
}
