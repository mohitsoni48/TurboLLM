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

  /** Emit one event. Silently does nothing whenever it must not send. */
  emit(event: EventName, payload?: Record<string, unknown>): void {
    try {
      if (telemetryDisabled()) return

      const level = this.o.store.snapshot().telemetry.level
      if (level !== 'anon' && level !== 'full') return
      if (REQUIRES_FULL.has(event) && level !== 'full') return

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
    if (this.claim(`once:${event}`)) this.emit(event)
  }

  /** Emit `feature_first_use` the first time a feature is touched, ever. */
  firstUse(feature: string): void {
    if (this.claim(`first_use:${feature}`)) this.emit('feature_first_use', { feature })
  }

  /** Emit `daily_active` at most once per calendar day. */
  dailyActive(): void {
    if (this.claim(`daily:${this.today()}`)) this.emit('daily_active')
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
