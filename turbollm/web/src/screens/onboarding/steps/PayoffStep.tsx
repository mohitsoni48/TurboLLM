import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Sparkles, Terminal } from 'lucide-react'
import { createConversation } from '../../../lib/chat-api'
import { createCodeSession } from '../../../lib/code-api'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 6 — Payoff (spec 25 §4). Creates a REAL conversation (Casual/
 *  Enthusiast) or a REAL Code session (Developer), then hands off to the
 *  actual chat/Code screen for the first turn — rather than rendering a
 *  parallel, fake chat UI inside the wizard. The existing screens already own
 *  correct streaming/generation logic; duplicating it here would be the same
 *  mistake this rewrite is fixing elsewhere. */
export default function PayoffStep({ ctx }: StepComponentProps) {
  const navigate = useNavigate()
  const { completeOnboarding } = useOnboardingMachine()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDeveloper = ctx.profile === 'developer'

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      if (isDeveloper) {
        const { convId } = await createCodeSession({
          repoRoot: '.',
          mode: 'auto',
          task: 'Give me a short tour of this repository and suggest one good first thing to try.',
        })
        completeOnboarding()
        navigate(`/workspace/code/${convId}`)
      } else {
        const conv = await createConversation({ title: 'Welcome to TurboLLM' })
        completeOnboarding()
        navigate(`/workspace/chat/${conv.id}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start it — try again.')
      setStarting(false)
    }
  }

  return (
    <div className="space-y-6 text-center">
      <div className="flex items-center justify-center gap-3 mb-2">
        {isDeveloper ? <Terminal size={20} className="text-accent" /> : <Sparkles size={20} className="text-accent" />}
        <h3 className="text-lg font-semibold text-ink">
          {isDeveloper ? 'Try your first Code session' : 'Try it'}
        </h3>
      </div>
      <p className="text-sm text-muted mb-6">
        {isDeveloper
          ? "Your model is ready — let's point it at this repo."
          : "Your model is ready. Let's start a real conversation."}
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        type="button"
        onClick={start}
        disabled={starting}
        className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent/10 text-accent py-2.5 px-5 text-sm font-medium hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {starting ? <Loader2 size={14} className="animate-spin" /> : null}
        {starting ? 'Starting…' : isDeveloper ? 'Open Code' : 'Start chatting'}
      </button>
    </div>
  )
}
