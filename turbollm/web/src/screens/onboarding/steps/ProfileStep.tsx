import { Code, Rocket, Sparkles, User, Users } from 'lucide-react'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import { track } from '../../../lib/api'
import type { ProfileId } from '../../../lib/onboarding/types'
import type { StepComponentProps } from '../OnboardingScreen'

const PROFILE_OPTIONS: { id: ProfileId; title: string; icon: typeof Users; description: string }[] = [
  {
    id: 'casual',
    title: 'Casual',
    icon: Users,
    description: 'Chat, brainstorm, and explore ideas. No setup required — just start talking.',
  },
  {
    id: 'developer',
    title: 'Developer',
    icon: Code,
    description: 'Code help, debugging, refactoring, and architecture reviews.',
  },
  {
    id: 'enthusiast',
    title: 'Enthusiast',
    icon: Rocket,
    description: 'See what your machine can run — bigger models, tuning, experimental features.',
  },
  {
    id: 'pro',
    title: 'Pro',
    icon: Sparkles,
    description: 'Max control and speed — pick your own model, quant, and engine.',
  },
]

/** Step 1 — Profile (spec 25 §4). Selecting a card calls the machine's
 *  `setProfile`, which both re-derives the step sequence immediately (so
 *  Casual's shorter path takes effect right away) and persists the choice to
 *  the server (Task 7's PUT /api/v1/onboarding). */
export default function ProfileStep({ onContinue, ctx }: StepComponentProps) {
  const { setProfile } = useOnboardingMachine()

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <User size={20} className="text-accent" />
        <h3 className="text-lg font-semibold text-ink">Choose your profile</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        Pick a role that matches how you'll use TurboLLM. You can always change this later in
        Settings.
      </p>

      <div className="space-y-3" role="radiogroup" aria-label="Onboarding profile">
        {PROFILE_OPTIONS.map((profile) => {
          const Icon = profile.icon
          const selected = ctx.profile === profile.id
          return (
            <button
              type="button"
              key={profile.id}
              className={`w-full flex items-center gap-4 p-4 rounded-lg border transition-all duration-200 text-left ${
                selected
                  ? 'border-accent bg-accent/5 hover:bg-accent/10'
                  : 'border-border bg-panel hover:border-accent/30 hover:bg-panel-2'
              }`}
              onClick={() => { track('onboarding', 'choose_profile'); setProfile(profile.id) }}
              role="radio"
              aria-checked={selected}
            >
              <div className={`flex-shrink-0 p-2.5 rounded-lg ${selected ? 'bg-accent/10 text-accent' : 'text-muted'}`}>
                <Icon size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{profile.title}</span>
                  {selected && <span className="text-xs text-faint">selected</span>}
                </div>
                <p className="text-xs text-muted mt-0.5">{profile.description}</p>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-end pt-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={!ctx.profile}
          className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
