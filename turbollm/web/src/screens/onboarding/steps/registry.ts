/** The ordered step list — the single source of truth (spec 25 §4).
 *
 *  To add a step: add one `defineStep` below, in position. Nothing else in
 *  this module changes; `deriveSteps`, the skip-coverage test and the
 *  progress indicator all read this array. */

import { defineStep, type StepDescriptor } from './define'

export const REGISTRY: readonly StepDescriptor[] = [
  defineStep({
    id: 'welcome',
    title: 'Welcome',
    appliesTo: () => true,
  }),
  defineStep({
    id: 'profile',
    title: 'How will you use TurboLLM?',
    appliesTo: () => true,
  }),
  defineStep({
    id: 'model',
    title: 'Choose a model',
    appliesTo: () => true,
  }),
  defineStep({
    // Fills otherwise-dead download time; pointless once the bytes have landed.
    id: 'personalize',
    title: 'Personalize',
    appliesTo: (c) => !c.downloadDone,
  }),
  defineStep({
    // Only Developer (tool permissions + endpoint) and Pro (engine picker)
    // have anything to configure here. Casual has no profile-specific step.
    // Enthusiast's only profile-specific content is the auto-tune intro,
    // which is the separate `tune-offer` step later in the sequence — this
    // step must NOT apply to Enthusiast, or there is nothing to render.
    id: 'profile-extra',
    title: 'Set up your workflow',
    appliesTo: (c) => !c.downloadDone && (c.profile === 'developer' || c.profile === 'pro'),
  }),
  defineStep({
    id: 'load',
    title: 'Loading your model',
    appliesTo: () => true,
  }),
  defineStep({
    // Auto-tune is offered right after Load, BEFORE the payoff — tune the config
    // before proving it works, not after (founder-reported ordering; an
    // auto-tune run always leaves the engine stopped when it finishes, so
    // TuneOfferStep itself reloads the model before handing off to Payoff).
    // NEVER on T0 — a hardware override that outranks profile (§6.2).
    id: 'tune-offer',
    title: 'Make it faster',
    appliesTo: (c) => !c.isT0 && (c.profile === 'enthusiast' || c.profile === 'pro' || c.profile === 'developer'),
  }),
  defineStep({
    // Last step — creates the real conversation/Code session AND completes
    // onboarding AND navigates there, all from one click. Used to be two
    // steps (this one, then a separate "done" step that actually finished
    // up); merged after a reported abrupt-feeling extra screen between
    // "Start chatting" and actually chatting — see PayoffStep's own header
    // comment for why the split existed and why it's safe to remove now.
    id: 'payoff',
    title: 'Try it',
    appliesTo: () => true,
  }),
]

export type StepId = (typeof REGISTRY)[number]['id']

export const STEP_IDS: readonly string[] = REGISTRY.map((s) => s.id)
