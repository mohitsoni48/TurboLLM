/** The onboarding wizard's React binding (spec 25 §9, ADR-340).
 *
 *  This file owns ONLY step-sequencing state — it wraps Plan 1's already-tested
 *  pure `reduce`/`deriveSteps` (`screens/onboarding/machine.ts`) in a reducer,
 *  and persists the two durable facts (`status`, `profile`) through the real
 *  `/api/v1/onboarding` route (Task 7), never `localStorage`. It does NOT fetch
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
 *  the web bundle mirrors only what it needs via `onboarding-api.ts`'s DTOs. */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { deriveSteps, reduce, type MachineState } from '../../screens/onboarding/machine'
import type { ProfileId, StepContext, StepDescriptor } from '../../screens/onboarding/steps/define'
import { useOnboardingState, useSetOnboardingState } from '../onboarding-queries'

const INITIAL_CTX: StepContext = {
  profile: null,
  downloadDone: false,
  isT0: false,
  recommendationKind: null,
}

const INITIAL_STATE: MachineState = { currentId: null, ctx: INITIAL_CTX }

export interface UseOnboardingMachineResult {
  ctx: StepContext
  steps: StepDescriptor[]
  currentStep: StepDescriptor | null
  currentStepIndex: number
  totalSteps: number
  advance: () => void
  goBack: () => void
  skip: () => void
  goToStep: (id: string) => void
  /** Feeds a real signal (download finished, hardware tier known, …) back into
   *  the sequencing context. The only way steps become applicable/inapplicable
   *  after mount — see `steps/registry.ts`'s `appliesTo` predicates. */
  patchCtx: (patch: Partial<StepContext>) => void
  /** Sets the chosen profile in BOTH the local sequencing context (so
   *  `deriveSteps` re-derives immediately) and the server (Task 7's PUT), so a
   *  closed tab resumes with the same profile. */
  setProfile: (profile: ProfileId) => void
  completeOnboarding: () => void
}

function useOnboardingMachineState(): UseOnboardingMachineResult {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE)
  const onboardingQuery = useOnboardingState()
  const setOnboarding = useSetOnboardingState()

  // Land on the first applicable step once, on mount. Reuses `reduce`'s own
  // 'ctx' case (which calls the tested `resumeAt`) rather than duplicating it.
  useEffect(() => {
    dispatch({ type: 'ctx', patch: {} })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Hydrate the previously-chosen profile from server truth exactly once,
  // when it first arrives — a later server refetch must not clobber a
  // profile the user is actively changing in this session.
  const serverProfile = onboardingQuery.data?.profile ?? null
  useEffect(() => {
    if (serverProfile && state.ctx.profile === null) {
      dispatch({ type: 'ctx', patch: { profile: serverProfile } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverProfile])

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

  const skip = useCallback(() => {
    dispatch({ type: 'skip' })
    setOnboarding.mutate({ status: 'skipped' })
  }, [setOnboarding])

  const setProfile = useCallback(
    (profile: ProfileId) => {
      patchCtx({ profile })
      setOnboarding.mutate({ profile })
    },
    [patchCtx, setOnboarding],
  )

  const completeOnboarding = useCallback(() => {
    setOnboarding.mutate({ status: 'completed' })
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
