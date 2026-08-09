import { DoorOpen, ExternalLink, Rocket, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { OnboardingCtx } from '../../../lib/onboarding/types'

/** Step 7 — Done (spec 25 §4). "You're set up" plus profile-appropriate next
 *  links. No share-link feature: there is no app-level share URL in a
 *  single-user local product (the per-conversation LAN share link is a
 *  different, existing feature and out of scope here).
 *
 *  This is now the ONLY step that calls `completeOnboarding()` and performs
 *  the final navigation — PayoffStep just advances into the sequence (see
 *  its own header comment for why). An adversarial QA pass found the
 *  previous version's buttons never called `completeOnboarding()` at all:
 *  `onboarding.status` stayed 'pending' forever even after the user believed
 *  they'd finished, and "Launch TurboLLM →" was wired to `onContinue`
 *  (`advance()`), which no-ops on the last step — the button visibly did
 *  nothing. Every action below now finishes onboarding for real before
 *  navigating, using the REAL destination Payoff already created
 *  (`ctx.payoffDestination`) rather than a generic route with no id. */
export default function DoneStep({
  onContinue: _onContinue,
  ctx,
}: {
  onContinue: () => void
  onSkip: () => void
  ctx: OnboardingCtx
}) {
  const navigate = useNavigate()
  const { completeOnboarding } = useOnboardingMachine()

  const openDestination = async () => {
    await completeOnboarding()
    const dest = ctx.payoffDestination
    navigate(dest ? `/workspace/${dest.kind}/${dest.id}` : '/workspace/chat')
  }

  const openModels = async () => {
    await completeOnboarding()
    navigate('/models')
  }

  const actions = [
    {
      icon: DoorOpen,
      text: ctx.profile === 'developer' ? 'Open Code' : 'Open TurboLLM',
      desc:
        ctx.profile === 'developer'
          ? 'Start your first Code session right now'
          : 'Start using your model right now',
      onClick: openDestination,
    },
    {
      icon: Rocket,
      text: 'Explore models',
      desc: 'Browse and download more models any time',
      onClick: openModels,
    },
    {
      icon: ExternalLink,
      text: 'Visit turbollm.dev',
      desc: 'Explore the full website and docs',
      onClick: () => window.open('https://turbollm.dev', '_blank'),
    },
  ]

  return (
    <div className="text-center space-y-6">
      <div className="flex items-center justify-center gap-3 mb-2">
        <Sparkles size={28} className="text-accent" />
        <h3 className="text-xl font-semibold text-ink">You're all set!</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        Your model is ready and waiting. No setup required — just start chatting.
      </p>

      <div className="grid grid-cols-1 gap-3">
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <button
              type="button"
              key={action.text}
              className="flex items-center gap-3 p-4 rounded-lg border border-border bg-panel hover:border-accent/30 hover:bg-panel-2 transition-all duration-200 text-left"
              onClick={action.onClick}
            >
              <div className="flex-shrink-0 p-2 rounded bg-accent/10 text-accent">
                <Icon size={20} />
              </div>
              <div className="flex-1 text-left">
                <span className="text-sm font-medium text-ink">{action.text}</span>
                <p className="text-xs text-muted mt-0.5">{action.desc}</p>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between pt-2">
        <span className="text-xs text-faint">You can change your profile any time in Settings</span>
        <button
          type="button"
          onClick={openDestination}
          className="rounded-lg border border-border bg-panel px-4 py-2 text-sm text-muted hover:border-accent/50 hover:text-ink transition-colors"
        >
          Launch TurboLLM →
        </button>
      </div>
    </div>
  )
}
