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
import { TELEMETRY_SCHEMA_VERSION, REGISTRY, type EventName } from './schema'
import { recordFeatureUse, flushStaleDailyUsage, persistDailyUsage } from './daily-usage'
import { recordUiAction, flushStaleUiUsage, persistUiDailyUsage } from './runtime/ui-daily-usage'

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

/** Events that require the `full` level, DERIVED from each event's own declared
 *  `consent` (registry, not a hand-maintained list) — deliberately, after finding
 *  this was a literal `Set(['error'])` that predates the registry (ADR-299
 *  Decision 6, before `model_load`/`gateway_daily`/`chat_daily`/`code_daily`/
 *  `harness_first_seen` existed) and was never extended when those events were
 *  added with `consent: 'full'` in their own schema. That gap meant an `anon`
 *  install's machine would have sent model identity, harness identity, and
 *  daily-rollup detail anyway — exactly the leak spec 23 §6's "consent levels"
 *  open question worried about, silently unenforced. Deriving from `REGISTRY`
 *  is the same fix the whole registry redesign exists to generalize: one
 *  source of truth, not a second list someone has to remember to update. */
const REQUIRES_FULL = new Set<EventName>(
  (Object.keys(REGISTRY) as EventName[]).filter((name) => REGISTRY[name].consent === 'full'),
)

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

  /**
   * Like {@link emit}, but also attaches a second top-level envelope block
   * beside `payload` — the only shape `bench_result`'s `hw` field needs
   * (`extraEnvelopeBlock`, `core/types.ts`). Before this existed, the only
   * way to send an `hw`-bearing event was `bench.ts`'s `queueTelemetry`
   * bypassing `Emitter` entirely and hand-duplicating machineId-minting —
   * this gives any future `hw`-shaped (or similarly-shaped) event a real way
   * to reuse the same consent/kill-switch/machineId machinery every other
   * event already gets, instead of a second copy of it.
   */
  emitWithExtra(event: EventName, payload: Record<string, unknown> | undefined, extraKey: string, extraValue: unknown): void {
    try {
      if (!this.canSend(event)) return

      enqueue(this.o.dataDir, {
        schema: TELEMETRY_SCHEMA_VERSION,
        event,
        ts: new Date().toISOString(),
        machineId: this.machineId(),
        app: { version: this.o.version, os: this.o.os },
        [extraKey]: extraValue,
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

  /** Emit `harness_first_seen` the first time THIS harness value is ever seen
   *  on this machine's gateway (spec 23 §3.5) — same parametrized-once shape
   *  as {@link firstUse}, keyed on the harness rather than a feature name.
   *  Fires even for `'unknown'` — see `events/gateway.ts`'s doc comment for why. */
  harnessFirstSeen(harness: string, protocol: 'anthropic' | 'openai'): void {
    if (!this.canSend('harness_first_seen')) return
    if (this.claim(`harness:${harness}`)) this.emit('harness_first_seen', { harness, protocol })
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
   * Record one UI click (`ui_action`, spec 23 §3.8) and emit `ui_daily` the
   * moment its screen's calendar day rolls over — the click-stream analogue of
   * `useFeature`/`feature_used_daily`. Consent is checked BEFORE any count is
   * recorded, same reasoning as `useFeature`'s own doc comment: usage while
   * telemetry is off must never silently contribute to a count reported after
   * the user opts in later.
   */
  uiAction(screen: string, action: string): void {
    if (!this.canSend('ui_action')) return
    this.emit('ui_action', { screen, action })
    const rolled = recordUiAction(this.o.dataDir, screen, action, this.today())
    if (rolled) this.emit('ui_daily', { screen, actions: rolled.actions, distinctActions: rolled.distinctActions })
  }

  /**
   * Roll over any screen whose UI-click tally is from a day earlier than
   * today, then persist whatever's left (today's still-in-progress counts) to
   * disk. Called periodically (cli.ts, alongside `flushDailyUsage`) for the
   * same two reasons: a screen used only on a user's LAST active day still
   * gets reported, and same-day counts (in-memory only) get a chance to
   * survive a crash instead of living only until the next rollover.
   */
  flushUiDailyUsage(): void {
    if (!this.canSend('ui_daily')) return
    for (const { screen, actions, distinctActions } of flushStaleUiUsage(this.o.dataDir, this.today())) {
      this.emit('ui_daily', { screen, actions, distinctActions })
    }
    persistUiDailyUsage(this.o.dataDir)
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
