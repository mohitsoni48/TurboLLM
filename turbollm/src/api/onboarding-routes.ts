/** Onboarding persistence (spec 25 §9.2). Deliberately thin: the server holds
 *  only `{status, profile}` (plus the server-only `everLoadedModel` flag);
 *  every other fact the wizard needs (download progress, provision status,
 *  load status) already has a route. Also serves the model recommendation
 *  (spec 25 §5.2) — computed here, server-side, against the real detected
 *  hardware, so the client never needs its own copy of `recommend()`/`BLESSED`
 *  or a way to learn total system RAM (there is no client-facing endpoint for
 *  that today; duplicating the resolver in the browser would also reintroduce
 *  the exact drift risk spec 25 §5.3 rejected a backend-served model list to
 *  avoid — the recommendation still ships with the client via this daemon,
 *  never a network call to anywhere else). */

import type { Hono } from 'hono'
import {
  normalizeOnboarding, ONBOARDING_STATUSES, PROFILE_IDS,
  type OnboardingState, type ProfileId,
} from '../onboarding/state'
import { recommend, type HardwareFacts } from '../onboarding/recommend'
import { getSysInfo } from '../sysinfo/sysinfo'
import type { ConfigStore } from '../config/config'
import type { Emitter } from '../telemetry/emit'

export interface OnboardingPatch {
  status?: string
  profile?: string
}

/** T0 per spec 25 §5.4/§6.2: CPU-only or < 4 GB VRAM. A hardware override that
 *  suppresses auto-tune for EVERY profile, including Pro — unlike model
 *  resolution, which Pro skips entirely regardless of tier. */
function isT0(hw: HardwareFacts): boolean {
  return hw.usableVramMb < 4096
}

/** Real detected hardware -> the shape `recommend()` needs. Apple unified
 *  memory tiering is out of scope here (spec 25 §12 open question); until
 *  resolved, only discrete/dedicated VRAM is treated as `usableVramMb`. */
export function hardwareFactsFromSysInfo(): HardwareFacts {
  const info = getSysInfo()
  const primaryVramMb = info.gpus[0]?.vramMb ?? 0
  const unifiedMemory = info.gpus.some((g) => g.unified === true)
  return { usableVramMb: primaryVramMb, systemRamMb: info.ramMB, unifiedMemory }
}

/** Pure, so the transition rules are testable without a server. `now` is
 *  injected rather than read from the clock for the same reason.
 *
 *  `OnboardingPatch` has no `everLoadedModel` field, so a well-typed caller
 *  cannot set it — but the route parses an arbitrary request body, so this
 *  function only ever copies the two fields it explicitly recognises onto
 *  `next` (never spreads the raw patch), which is what actually keeps a
 *  hand-crafted `{everLoadedModel: true}` body from taking effect. */
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
  deps: { store: ConfigStore; telemetry?: Emitter },
): void {
  app.get('/api/v1/onboarding', (c) => c.json(normalizeOnboarding(deps.store.snapshot().onboarding)))

  app.put('/api/v1/onboarding', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as OnboardingPatch
    const current = normalizeOnboarding(deps.store.snapshot().onboarding)
    const next = applyOnboardingPatch(current, body, Date.now())
    deps.store.update((cfg) => { cfg.onboarding = next })
    // spec 25 §8.2 / ADR-338 Decision 8, wired by ADR-350: the cohorting key the whole
    // derived funnel breaks down by. Guarded once-ever inside the Emitter itself, so
    // calling this on every PUT that carries a profile (not just the very first) is
    // safe — a returning user changing their profile in Settings never double-counts.
    if (next.profile) deps.telemetry?.onboardingProfileChosen(next.profile)
    return c.json(next)
  })

  // Model recommendation (spec 25 §5.2/§5.4). Query param `profile` — an
  // invalid or missing one 400s rather than silently guessing, since a wrong
  // guess here is a wrong model download.
  app.get('/api/v1/onboarding/recommendation', (c) => {
    const profile = c.req.query('profile')
    if (!profile || !(PROFILE_IDS as readonly string[]).includes(profile)) {
      return c.json({ error: 'invalid or missing profile' }, 400)
    }
    const hw = hardwareFactsFromSysInfo()
    const recommendation = recommend(profile as ProfileId, hw)
    return c.json({ recommendation, isT0: isT0(hw) })
  })
}

/** Called once from `cli.ts`'s `manager.onLoadSettled` on a REAL successful
 *  load (never from a client request) — the one and only writer of this flag.
 *  A no-op once already true, so it never re-stamps or races. */
export function markEverLoadedModel(store: ConfigStore): void {
  if (normalizeOnboarding(store.snapshot().onboarding).everLoadedModel) return
  store.update((cfg) => {
    cfg.onboarding = { ...normalizeOnboarding(cfg.onboarding), everLoadedModel: true }
  })
}
