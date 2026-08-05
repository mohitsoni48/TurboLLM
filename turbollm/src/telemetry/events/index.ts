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
import { onboardingStep } from './onboarding'
import { modelFirstLoad, modelLoad } from './model'
import { featureFirstUse, featureUsedDaily } from './feature'
import { errorEvent, consentChoice } from './meta'
import { benchResult } from './perf'
import { chatDaily } from './chat'
import { gatewayDaily, harnessFirstSeen } from './gateway'
import { codeDaily } from './code'

export const REGISTRY = {
  app_first_run: appFirstRun,
  daily_active: dailyActive,
  onboarding_step: onboardingStep,
  model_first_load: modelFirstLoad,
  model_load: modelLoad,
  feature_first_use: featureFirstUse,
  feature_used_daily: featureUsedDaily,
  error: errorEvent,
  consent_choice: consentChoice,
  bench_result: benchResult,
  chat_daily: chatDaily,
  gateway_daily: gatewayDaily,
  harness_first_seen: harnessFirstSeen,
  code_daily: codeDaily,
} as const

export type EventName = keyof typeof REGISTRY

export const EVENT_NAMES = Object.keys(REGISTRY) as EventName[]

export {
  appFirstRun,
  dailyActive,
  onboardingStep,
  modelFirstLoad,
  modelLoad,
  featureFirstUse,
  featureUsedDaily,
  errorEvent,
  consentChoice,
  benchResult,
  chatDaily,
  gatewayDaily,
  harnessFirstSeen,
  codeDaily,
}
