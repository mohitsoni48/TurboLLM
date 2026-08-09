import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { OnboardingMachineProvider, useOnboardingMachine } from '../../lib/onboarding/useOnboardingMachine'
import { useOnboardingRecommendation, useOnboardingState } from '../../lib/onboarding-queries'
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
import DoneStep from './steps/DoneStep'

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
  done: DoneStep,
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
  done: 'All set!',
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
  useEffect(() => {
    const status = onboardingQuery.data?.status
    if (status === 'completed' || status === 'skipped') {
      navigate('/workspace/chat', { replace: true })
    }
  }, [onboardingQuery.data?.status, navigate])

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

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-panel-1">
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
              onClick={skip}
              className="text-[13px] text-faint hover:text-ink transition-colors"
            >
              Skip this step
            </button>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl md:text-3xl font-semibold text-ink mb-2">{currentStep.title}</h2>
            <p className="text-muted text-sm leading-relaxed">{STEP_SUBTITLE[currentStep.id]}</p>
          </div>

          <div className="mb-6">
            <StepComponent onContinue={advance} onSkip={skip} ctx={machine.ctx} />
          </div>
        </div>

        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={skip}
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
