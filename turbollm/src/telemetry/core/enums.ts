/**
 * Enum value lists shared across more than one event's field specs
 * (spec 24, ADR-333). Values are unchanged from the original `schema.ts` —
 * this file only relocates them so `events/*.ts` files can import a shared
 * list instead of each re-declaring it, which is exactly the kind of
 * parallel-hand-maintained-list drift (ADR-299 → ADR-323/332, "F1") this
 * whole redesign exists to stop.
 */

/** Product surfaces we count discovery/usage for. Closed set by construction —
 *  a repo name or a chat title can never be expressed as one of these. */
export const FEATURES = ['chat', 'code', 'research', 'artifacts', 'mcp', 'agents', 'autotune', 'skills', 'image'] as const

/** Steps in the install → first-chat journey (ADR-299 Decision 6, amended by
 *  ADR-323). Retired entirely in spec 23 §4 — onboarding becomes a PostHog
 *  funnel derived from real events instead of steps inside one event — but
 *  kept alive here until that migration (Phase 7) actually ships. */
export const ONBOARDING_STEPS = ['engine_install', 'model_download', 'first_load', 'first_chat'] as const

/** How a step or a load ended. */
export const OUTCOMES = ['ok', 'fail', 'cancelled'] as const

/** Why a load failed. Enum'd precisely so a failure can never carry a path or a
 *  driver string — `other` is the deliberate catch-all for the long tail. */
export const FAIL_REASONS = ['oom', 'no_engine', 'bad_gguf', 'unsupported_arch', 'timeout', 'cancelled', 'other'] as const

/** Why provisioning a prebuilt engine failed (`onboarding_step: engine_install`
 *  only — see `classifyProvisionFailure`). A separate enum from `FAIL_REASONS`:
 *  installing an engine archive and loading a model fail in different ways
 *  (network/asset/platform vs. oom/arch/corruption), so the two vocabularies
 *  don't overlap much and shouldn't be merged into one. */
export const PROVISION_FAIL_REASONS = ['network', 'no_asset', 'unsupported_platform', 'disk_full', 'permission_denied', 'other'] as const

/** Usage counts are bucketed, never raw: a raw count is a behavioural fingerprint. */
export const COUNT_BUCKETS = ['1', '2-5', '6-20', '21-100', '100+'] as const

/** Known failure classes. Never log text — a fingerprint the client already
 *  recognises, or nothing at all. */
export const ERROR_FINGERPRINTS = [
  'cuda_oom', 'engine_crash', 'engine_start_timeout', 'model_load_failed',
  'gateway_unreachable', 'download_failed', 'build_failed', 'other',
] as const

/** Consent levels, as sent by `consent_choice`. */
export const CONSENT_LEVELS = ['off', 'anon', 'full'] as const
