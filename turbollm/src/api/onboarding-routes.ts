/** Onboarding persistence (spec 25 §9.2). Deliberately thin: the server holds
 *  only `{status, profile}`; every other fact the wizard needs (download
 *  progress, provision status, load status) already has a route. */

import type { Hono } from 'hono'
import {
  normalizeOnboarding, ONBOARDING_STATUSES, PROFILE_IDS,
  type OnboardingState,
} from '../onboarding/state'
import type { ConfigStore } from '../config/config'

export interface OnboardingPatch {
  status?: string
  profile?: string
}

/** Pure, so the transition rules are testable without a server. `now` is
 *  injected rather than read from the clock for the same reason. */
export function applyOnboardingPatch(
  current: OnboardingState,
  patch: OnboardingPatch,
  now: number,
): OnboardingState {
  const next: OnboardingState = { ...current }

  if (patch.profile !== undefined && (PROFILE_IDS as readonly string[]).includes(patch.profile)) {
    next.profile = patch.profile as OnboardingState['profile']
  }
  if (patch.status !== undefined && (ONBOARDING_STATUSES as readonly string[]).includes(patch.status)) {
    next.status = patch.status as OnboardingState['status']
    // Only a genuine completion is stamped. A skip is a choice, not a finish,
    // and conflating them would corrupt the completion metric.
    if (next.status === 'completed' && next.completedAt === null) next.completedAt = now
  }
  return next
}

export function registerOnboardingRoutes(
  app: Hono,
  deps: { store: ConfigStore },
): void {
  app.get('/api/v1/onboarding', (c) => c.json(normalizeOnboarding(deps.store.snapshot().onboarding)))

  app.put('/api/v1/onboarding', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as OnboardingPatch
    const current = normalizeOnboarding(deps.store.snapshot().onboarding)
    const next = applyOnboardingPatch(current, body, Date.now())
    deps.store.update((cfg) => { cfg.onboarding = next })
    return c.json(next)
  })
}
