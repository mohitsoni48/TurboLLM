/** The onboarding wizard's React binding (spec 25 §9, ADR-340).
 *
 *  This file owns ONLY step-sequencing state — it wraps Plan 1's already-tested
 *  pure `reduce`/`deriveSteps` (`screens/onboarding/machine.ts`) in a reducer,
 *  and persists the two durable facts (`status`, `profile`) through the real
 *  `/api/v1/onboarding` route (Task 7) — see the localStorage note below for
 *  the one narrow exception. It does NOT fetch
 *  the model recommendation or poll download/load state — those are each
 *  step's own concern via `useOnboardingRecommendation` and the existing
 *  downloads/status queries, patched back in via `patchCtx`.
 *
 *  One reducer instance for the whole wizard, shared via Context: every step
 *  component calls the SAME `useOnboardingMachine()`, not a fresh one — a
 *  step calling `useReducer` on its own would silently fork a second,
 *  disconnected copy of the sequencing state, which is the exact
 *  multiple-sources-of-truth failure this rewrite exists to remove.
 *
 *  Does NOT reach into `src/onboarding/state.ts` — that is a daemon module;
 *  the web bundle mirrors only what it needs via `onboarding-api.ts`'s DTOs.
 *
 *  ONE deliberate exception to "the server holds status/profile, nothing
 *  else is durable" (spec 25 §9.3): the current step ID is cached in
 *  `localStorage` under a single dedicated key, purely so a closed tab
 *  resumes at the same STEP, not just the same profile (acceptance
 *  criterion 5). This is pure client-side UI position — it never gates the
 *  funnel and a stale/missing value degrades safely through `resumeAt`'s
 *  existing fallback — so it does not need the tamper-resistance a
 *  server-owned fact would. Profile and completion status are still never
 *  read from or written to `localStorage` anywhere in this file. */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { deriveSteps, reduce } from '../../screens/onboarding/machine'
import type { ProfileId, StepContext, StepDescriptor } from '../../screens/onboarding/steps/define'
import { useOnboardingState, useSetOnboardingState } from '../onboarding-queries'

const STEP_ID_STORAGE_KEY = 'tllm.onboarding.currentStepId'

const INITIAL_CTX: StepContext = {
  profile: null,
  downloadDone: false,
  isT0: false,
  recommendationKind: null,
  expectedModelKey: null,
  payoffDestination: null,
  loadCompletedOnce: false,
}

export interface UseOnboardingMachineResult {
  ctx: StepContext
  steps: StepDescriptor[]
  currentStep: StepDescriptor | null
  currentStepIndex: number
  totalSteps: number
  advance: () => void
  goBack: () => void
  /** Resolves only once the server has actually recorded status='skipped' —
   *  await this before navigating anywhere afterward, or App.tsx's
   *  OnboardingGate can read the still-stale cached status and bounce the
   *  new route straight back to /onboarding. */
  skip: () => Promise<void>
  goToStep: (id: string) => void
  /** Feeds a real signal (download finished, hardware tier known, …) back into
   *  the sequencing context. The only way steps become applicable/inapplicable
   *  after mount — see `steps/registry.ts`'s `appliesTo` predicates. */
  patchCtx: (patch: Partial<StepContext>) => void
  /** Sets the chosen profile in BOTH the local sequencing context (so
   *  `deriveSteps` re-derives immediately) and the server (Task 7's PUT), so a
   *  closed tab resumes with the same profile. */
  setProfile: (profile: ProfileId) => void
  /** Resolves only once the server has actually recorded status='completed' —
   *  same reason as `skip`'s note above. Always await before navigating. */
  completeOnboarding: () => Promise<void>
}

function readSavedStepId(): string | null {
  try {
    return localStorage.getItem(STEP_ID_STORAGE_KEY)
  } catch {
    return null
  }
}

function useOnboardingMachineState(): UseOnboardingMachineResult {
  const [state, dispatch] = useReducer(
    reduce,
    undefined,
    () => ({ currentId: readSavedStepId(), ctx: INITIAL_CTX }),
  )
  const onboardingQuery = useOnboardingState()
  const setOnboarding = useSetOnboardingState()

  // No saved position at all (a genuinely fresh visit) — land on the first
  // applicable step immediately rather than waiting on the server query.
  useEffect(() => {
    if (state.currentId === null) dispatch({ type: 'ctx', patch: {} })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-validate against real server truth exactly once, when the query
  // settles — fires even when `profile` is null. That "even when null" is
  // required, not incidental: a saved step that NEEDS a profile
  // (`profile-extra`) and turns out to have none would otherwise never be
  // re-checked, leaving `currentStep` permanently unresolvable — a blank
  // screen — instead of `resumeAt`'s existing fallback correctly bumping it
  // back to the first applicable step. Firing on every settle, not just
  // truthy profiles, is what closes that gap.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!onboardingQuery.isSuccess || hydratedRef.current) return
    hydratedRef.current = true
    dispatch({ type: 'ctx', patch: { profile: onboardingQuery.data.profile } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingQuery.isSuccess])

  // Persist step POSITION only (never status/profile — those stay
  // server-owned via setOnboarding above) so a closed tab reopens on the
  // same step, not just with the same profile (spec 25 acceptance
  // criterion 5).
  useEffect(() => {
    try {
      if (state.currentId) localStorage.setItem(STEP_ID_STORAGE_KEY, state.currentId)
      else localStorage.removeItem(STEP_ID_STORAGE_KEY)
    } catch {
      // best-effort — a UI-position cache is not worth failing over
    }
  }, [state.currentId])

  const steps = useMemo(() => deriveSteps(state.ctx), [state.ctx])
  const currentStepIndex = useMemo(
    () => steps.findIndex((s) => s.id === state.currentId),
    [steps, state.currentId],
  )
  const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : null

  const advance = useCallback(() => dispatch({ type: 'next' }), [])
  const goBack = useCallback(() => dispatch({ type: 'back' }), [])
  const goToStep = useCallback((id: string) => dispatch({ type: 'goto', id }), [])
  const patchCtx = useCallback((patch: Partial<StepContext>) => dispatch({ type: 'ctx', patch }), [])

  const clearSavedStepId = () => {
    try { localStorage.removeItem(STEP_ID_STORAGE_KEY) } catch { /* best-effort */ }
  }

  // Both skip() and completeOnboarding() are awaited by their callers before
  // navigating anywhere. Found by a real click-through, not by any test:
  // `.mutate()` is fire-and-forget, so a caller that fires the mutation and
  // immediately calls navigate() races the query cache update. App.tsx's
  // OnboardingGate reads the STALE cached status ('pending') at that instant,
  // bounces the new route straight back to /onboarding, and by the time the
  // mutation actually resolves the user is looking at OnboardingScreen's own
  // "already done" effect, which hardcodes its destination to
  // /workspace/chat — silently overriding wherever the user actually meant
  // to go (a Developer's Code session, in the reported case). `.mutateAsync`
  // resolves only after `onSuccess` has already updated the cache, so
  // awaiting it before navigating closes the race.
  const skip = useCallback(async () => {
    dispatch({ type: 'skip' })
    await setOnboarding.mutateAsync({ status: 'skipped' })
    clearSavedStepId()
  }, [setOnboarding])

  const setProfile = useCallback(
    (profile: ProfileId) => {
      patchCtx({ profile })
      setOnboarding.mutate({ profile })
    },
    [patchCtx, setOnboarding],
  )

  const completeOnboarding = useCallback(async () => {
    await setOnboarding.mutateAsync({ status: 'completed' })
    clearSavedStepId()
  }, [setOnboarding])

  return {
    ctx: state.ctx,
    steps,
    currentStep,
    currentStepIndex,
    totalSteps: steps.length,
    advance,
    goBack,
    skip,
    goToStep,
    patchCtx,
    setProfile,
    completeOnboarding,
  }
}

const OnboardingMachineContext = createContext<UseOnboardingMachineResult | null>(null)

/** Mounted once, at `OnboardingScreen`'s root. Every step component reaches
 *  the SAME instance through `useOnboardingMachine()` below. */
export function OnboardingMachineProvider({ children }: { children: ReactNode }) {
  const value = useOnboardingMachineState()
  return <OnboardingMachineContext.Provider value={value}>{children}</OnboardingMachineContext.Provider>
}

export function useOnboardingMachine(): UseOnboardingMachineResult {
  const ctx = useContext(OnboardingMachineContext)
  if (!ctx) throw new Error('useOnboardingMachine() called outside <OnboardingMachineProvider>')
  return ctx
}
