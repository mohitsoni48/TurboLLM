/** Persisted onboarding state (spec 25 §3). Deliberately tiny: the wizard is a
 *  client state machine over server truth, so the only durable facts are
 *  whether onboarding is done and which profile was picked. */

export const ONBOARDING_SCHEMA_VERSION = 1

export const ONBOARDING_STATUSES = ['pending', 'completed', 'skipped'] as const
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]

export const PROFILE_IDS = ['casual', 'developer', 'enthusiast', 'pro'] as const
export type ProfileId = (typeof PROFILE_IDS)[number]

export interface OnboardingState {
  status: OnboardingStatus
  profile: ProfileId | null
  completedAt: number | null
  schemaVersion: number
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** Never throws. An unrecognised value degrades to the safe default rather
 *  than failing a daemon boot over a hand-edited config. */
export function normalizeOnboarding(raw: unknown): OnboardingState {
  const r = asRecord(raw)
  const status = (ONBOARDING_STATUSES as readonly string[]).includes(r.status as string)
    ? (r.status as OnboardingStatus)
    : 'pending'
  const profile = (PROFILE_IDS as readonly string[]).includes(r.profile as string)
    ? (r.profile as ProfileId)
    : null
  const completedAt = typeof r.completedAt === 'number' ? r.completedAt : null
  const schemaVersion = typeof r.schemaVersion === 'number' ? r.schemaVersion : ONBOARDING_SCHEMA_VERSION
  return { status, profile, completedAt, schemaVersion }
}
