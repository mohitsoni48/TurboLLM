import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { OnboardingMachineProvider, useOnboardingMachine } from '../../lib/onboarding/useOnboardingMachine'
import { useOnboardingRecommendation, useOnboardingState } from '../../lib/onboarding-queries'
import { track } from '../../lib/api'
import type { OnboardingCtx } from '../../lib/onboarding/types'
import type { StepDescriptor } from './steps/define'

import WelcomeStep from './steps/WelcomeStep'
import ProfileStep from './steps/ProfileStep'
import ModelStep from './steps/ModelStep'
import PersonalizeStep from './steps/PersonalizeStep'
import ProfileExtraStep from './steps/ProfileExtraStep'
import LoadStep from './steps/LoadStep'
import PayoffStep from './steps/PayoffStep'
import TuneOfferStep from './steps/TuneOfferStep'

// Quoted keys throughout — 'profile-extra'/'tune-offer' are not valid bare
// identifiers, and an unquoted use here is what made this file fail to parse
// at all in an earlier draft.
const STEP_COMPONENTS: Record<StepDescriptor['id'], React.ComponentType<StepComponentProps>> = {
  welcome: WelcomeStep,
  profile: ProfileStep,
  model: ModelStep,
  personalize: PersonalizeStep,
  'profile-extra': ProfileExtraStep,
  load: LoadStep,
  payoff: PayoffStep,
  'tune-offer': TuneOfferStep,
}

const STEP_SUBTITLE: Record<StepDescriptor['id'], string> = {
  welcome: 'Welcome to TurboLLM — your local AI platform.',
  profile: 'Choose how you want to use TurboLLM.',
  model: 'Pick a model based on your hardware.',
  personalize: 'Optional — tell us about your setup.',
  'profile-extra': 'A few options for your chosen profile.',
  load: 'Loading your model.',
  payoff: "Let's see it in action.",
  'tune-offer': 'Want to make it faster?',
}

export interface StepComponentProps {
  onContinue: () => void
  onSkip: () => void
  ctx: OnboardingCtx
}

/** The onboarding wizard shell (spec 25 §4/§9.1). Renders whichever step the
 *  machine derives as current; all sequencing state lives in
 *  `useOnboardingMachine`, all persistence in `/api/v1/onboarding` (Task 7).
 *  No `localStorage` — a closed tab resumes from server truth. The provider
 *  wrapper is what lets every step component reach the same machine instance
 *  instead of each forking its own via a fresh `useReducer`. */
export function OnboardingScreen() {
  return (
    <OnboardingMachineProvider>
      <OnboardingScreenInner />
    </OnboardingMachineProvider>
  )
}

function OnboardingScreenInner() {
  const navigate = useNavigate()
  const onboardingQuery = useOnboardingState()
  const machine = useOnboardingMachine()
  const recommendationQuery = useOnboardingRecommendation(machine.ctx.profile)

  // Defense in depth beyond App.tsx's entry predicate: a direct deep-link to
  // /onboarding after the wizard is already done must not re-show it.
  //
  // Fires ONLY on the query's first settle, not reactively on every status
  // change — an adversarial QA pass found that reacting to every change made
  // this race PayoffStep's own navigate(). Both are triggered by the exact
  // same event (Payoff's completeOnboarding() mutation resolving), so there
  // is no reliable ordering between "this effect redirects to a hardcoded
  // /workspace/chat" and "PayoffStep navigates to the real destination it
  // just created" — awaiting the mutation before navigating (tried first)
  // does not fix it, because this effect can still fire on the same cache
  // update. Scoping it to the INITIAL settle only removes the conflict: it
  // still catches a genuine deep-link to an already-finished install, but
  // no longer fires mid-session while the wizard's own steps are driving
  // navigation themselves.
  const initialCompletionCheckDone = useRef(false)
  useEffect(() => {
    if (initialCompletionCheckDone.current) return
    if (!onboardingQuery.isSuccess) return
    initialCompletionCheckDone.current = true
    const status = onboardingQuery.data.status
    if (status === 'completed' || status === 'skipped') {
      navigate('/workspace/chat', { replace: true })
    }
  }, [onboardingQuery.isSuccess, onboardingQuery.data, navigate])

  // Feed the real hardware tier back into the sequencing context once known —
  // this is what makes the T0 auto-tune suppression (spec 25 §6.2) and the
  // Pro Discover-handoff branch (§4 step 2) actually take effect.
  useEffect(() => {
    if (!recommendationQuery.data) return
    machine.patchCtx({
      isT0: recommendationQuery.data.isT0,
      recommendationKind: recommendationQuery.data.recommendation.kind,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendationQuery.data])

  const { currentStep, currentStepIndex, totalSteps, advance, goBack, skip } = machine
  if (!currentStep) return null

  const StepComponent = STEP_COMPONENTS[currentStep.id]

  // `skip()` only persists status='skipped' server-side (mirrors PayoffStep's own
  // completeOnboarding-then-navigate pattern) — it does NOT navigate. Once it resolves,
  // `currentStep` derives to null and this component renders nothing at all (see the
  // early return above), stranding the user on a blank /onboarding forever. The ONLY
  // other navigate-away path is the `initialCompletionCheckDone` effect above, and it is
  // deliberately scoped to fire ONCE, on the query's FIRST settle — which already
  // happened with status='pending' before the user ever clicked Skip, so it can never
  // catch this. Found live: a real click on "I don't need onboarding" left the status
  // genuinely flipped to 'skipped' server-side while the page just sat there blank.
  const handleSkip = async () => {
    // ADR-338 Decision 6c: "every step's skip is tracked with the step it fired from,
    // because *where* people bail is the whole diagnostic value" — one ui_action per
    // registered step (`skip_onboarding_<id>`, ui.ts's UI_ACTIONS), captured before
    // `skip()` clears currentStep. Wired by ADR-350 — the schema predates this call
    // site by days; nothing ever actually fired it until now.
    track('onboarding', `skip_onboarding_${currentStep.id.replace(/-/g, '_')}`)
    await skip()
    navigate('/workspace/chat', { replace: true })
  }

  return (
    // h-screen + overflow-y-auto, not min-h-screen: the app shell locks
    // body/html overflow globally (every other screen manages its own
    // internal scroll region), so a taller-than-viewport min-h-screen div
    // here has nowhere to scroll — confirmed by an adversarial QA pass: with
    // 24 real models populating the "use existing model" list, the page grew
    // to 954px against a 720px viewport with no way to reach the bottom
    // "I don't need onboarding" link. This div now creates its own bounded,
    // scrollable region regardless of the shell's lock.
    //
    // justify-start, not justify-center: found live, a second and worse half of the
    // same class of bug that fix was aimed at. `justify-center` on an overflowing
    // flex+overflow-y-auto container pushes the TOP of tall content into negative
    // scroll space — scrollTop is clamped to >= 0, so a browser can never scroll UP
    // far enough to reach it. On the Profile step (4 cards; content 902px vs a 720px
    // viewport) this left "← Back" permanently unreachable — not a scroll timing
    // issue, a genuine layout dead zone regardless of how long you wait or retry.
    // justify-start + the inner wrapper's own `py-16 md:py-20` still centers short
    // content comfortably; it just stops silently eating the top of tall content.
    <div className="h-screen overflow-y-auto flex flex-col items-center justify-start bg-panel-1">
      <div className="fixed top-0 left-0 w-full bg-panel border-b border-border z-20">
        <div className="h-8 px-6 flex items-center gap-4">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${Math.max(((currentStepIndex + 1) / totalSteps) * 100, 8)}%` }}
            />
          </div>
          <span className="text-xs text-muted font-mono whitespace-nowrap">
            {currentStepIndex + 1} of {totalSteps}
          </span>
        </div>
      </div>

      <div className="max-w-lg w-full mx-auto p-6 py-16 md:py-20">
        <div className="bg-panel rounded-2xl border border-border shadow-[var(--shadow-2)] p-8 md:p-10">
          <div className="flex items-center justify-between mb-8">
            <button
              type="button"
              onClick={goBack}
              disabled={currentStepIndex === 0}
              className="text-[13px] text-muted hover:text-ink disabled:opacity-40 transition-colors flex items-center gap-2"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="text-[13px] text-faint hover:text-ink transition-colors"
            >
              Skip onboarding
            </button>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl md:text-3xl font-semibold text-ink mb-2">{currentStep.title}</h2>
            <p className="text-muted text-sm leading-relaxed">{STEP_SUBTITLE[currentStep.id]}</p>
          </div>

          <div className="mb-6">
            <StepComponent onContinue={advance} onSkip={handleSkip} ctx={machine.ctx} />
          </div>
        </div>

        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={handleSkip}
            className="text-sm text-faint underline underline-offset-4 hover:text-muted"
          >
            I don't need onboarding
          </button>
          <p className="mt-1 text-[11px] text-faint">You can always return to setup anytime from Settings</p>
        </div>
      </div>
    </div>
  )
}
