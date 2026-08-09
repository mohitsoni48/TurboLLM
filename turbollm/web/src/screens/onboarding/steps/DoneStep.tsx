import { DoorOpen, ExternalLink, Rocket, Sparkles } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { OnboardingCtx } from '../../../lib/onboarding/types'

/** Step 7 — Done (spec 25 §4). "You're set up" plus profile-appropriate next
 *  links. No share-link feature: there is no app-level share URL in a
 *  single-user local product (the per-conversation LAN share link is a
 *  different, existing feature and out of scope here). */
export default function DoneStep({
  onContinue,
  ctx,
}: {
  onContinue: () => void
  onSkip: () => void
  ctx: OnboardingCtx
}) {
  const navigate = useNavigate()

  const actions = [
    {
      icon: DoorOpen,
      text: ctx.profile === 'developer' ? 'Open Code' : 'Open TurboLLM',
      desc:
        ctx.profile === 'developer'
          ? 'Start your first Code session right now'
          : 'Start using your model right now',
      onClick: () => {
        onContinue()
        navigate(ctx.profile === 'developer' ? '/workspace/code' : '/workspace/chat')
      },
    },
    {
      icon: Rocket,
      text: 'Explore models',
      desc: 'Browse and download more models any time',
      onClick: () => {
        onContinue()
        navigate('/models')
      },
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
          onClick={onContinue}
          className="rounded-lg border border-border bg-panel px-4 py-2 text-sm text-muted hover:border-accent/50 hover:text-ink transition-colors"
        >
          Launch TurboLLM →
        </button>
      </div>
    </div>
  )
}
