/** Onboarding events (spec 25 §8.2, ADR-338 Decision 8).
 *
 *  Only TWO events, on purpose. The funnel itself stays DERIVED in PostHog
 *  from `app_first_run` → `engine_installed` → `model_downloaded` →
 *  `model_load` → `chat_daily`/`code_daily`; step progression rides the
 *  generic `ui_action`. `onboarding_step` is NOT coming back (ADR-336). */

import { defineEvent, f } from '../core/define'

export const PROFILES = ['casual', 'developer', 'enthusiast', 'pro'] as const

/** Cohorting key: lets the whole derived funnel break down by branch, which is
 *  the only way to learn whether branching worked at all. */
export const onboardingProfile = defineEvent({
  name: 'onboarding_profile',
  since: 2,
  consent: 'anon',
  lifecycle: 'once',
  description: 'The user chose an onboarding profile.',
  payload: { profile: f.enum(PROFILES) },
})

export const RECOVERY_FAILURES = [
  'oom', 'no_engine', 'bad_gguf', 'unsupported_arch', 'timeout', 'cancelled', 'other',
  'network', 'no_asset', 'unsupported_platform', 'disk_full', 'permission_denied',
] as const

export const RECOVERY_ACTIONS = [
  'retry', 'use_existing_folder', 'alt_build_variant', 'hf_search', 'llamafile',
  'build_from_source', 'smaller_quant', 'show_path_fix', 'lower_quant_retry',
  'redownload', 'alt_engine', 'longer_timeout', 'back_to_engine', 'resume',
  'show_launch_command',
] as const

/** The ROI measurement for the entire recovery half: which failure, which
 *  remedy the user chose, and whether it actually worked. */
export const onboardingRecovery = defineEvent({
  name: 'onboarding_recovery',
  since: 2,
  consent: 'anon',
  lifecycle: 'per-action',
  description: 'A user took a recovery action after an onboarding failure.',
  payload: {
    failure: f.enum(RECOVERY_FAILURES),
    action: f.enum(RECOVERY_ACTIONS),
    outcome: f.enum(['ok', 'fail'] as const),
  },
})
