/**
 * The event registry (spec 24, ADR-333) — the single source of truth for
 * every event that may ever be sent. `EVENT_NAMES`/`EventName` are DERIVED
 * from this, not maintained alongside it: the exact hand-maintained parallel
 * list this redesign exists to eliminate (ADR-299 → ADR-323/332's "F1").
 *
 * To add an event: write one `defineEvent()` in the right domain file above,
 * import it, and add it to `REGISTRY` below. Nothing else in this module
 * needs to change — `schema.ts`'s validator, `EVENT_NAMES`, and the typed
 * `emit()` helpers all read this object.
 */

import { appFirstRun, dailyActive } from './lifecycle'
import { modelFirstLoad, modelLoad, modelDownloaded } from './model'
import { engineInstalled } from './engine'
import { featureFirstUse, featureUsedDaily } from './feature'
import { errorEvent, consentChoice } from './meta'
import { benchResult } from './perf'
import { chatDaily } from './chat'
import { gatewayDaily, harnessFirstSeen } from './gateway'
import { codeDaily } from './code'
import { uiAction, uiDaily } from './ui'

export const REGISTRY = {
  app_first_run: appFirstRun,
  daily_active: dailyActive,
  model_first_load: modelFirstLoad,
  model_load: modelLoad,
  engine_installed: engineInstalled,
  model_downloaded: modelDownloaded,
  feature_first_use: featureFirstUse,
  feature_used_daily: featureUsedDaily,
  error: errorEvent,
  consent_choice: consentChoice,
  bench_result: benchResult,
  chat_daily: chatDaily,
  gateway_daily: gatewayDaily,
  harness_first_seen: harnessFirstSeen,
  code_daily: codeDaily,
  ui_action: uiAction,
  ui_daily: uiDaily,
} as const

export type EventName = keyof typeof REGISTRY

export const EVENT_NAMES = Object.keys(REGISTRY) as EventName[]

export {
  appFirstRun,
  dailyActive,
  modelFirstLoad,
  modelLoad,
  modelDownloaded,
  engineInstalled,
  featureFirstUse,
  featureUsedDaily,
  errorEvent,
  consentChoice,
  benchResult,
  chatDaily,
  gatewayDaily,
  harnessFirstSeen,
  codeDaily,
  uiAction,
  uiDaily,
}
