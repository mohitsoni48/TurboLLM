// Convenience re-export of the machine's canonical step-gating context (Plan 1,
// spec 25 §9.1). `StepContext` is deliberately minimal — profile/downloadDone/
// isT0/recommendationKind only — because `appliesTo()` predicates are tested
// with synthetic contexts covering hardware nobody owns. Step components that
// need MORE than this to render (the full recommendation entry, live
// download/load state) receive it as a SEPARATE prop, not stuffed onto ctx —
// keeping this type in lockstep with what the tested reducer actually uses.
export type { StepContext as OnboardingCtx, ProfileId } from '../../screens/onboarding/steps/define'
