import { useRef, useState } from 'react'
import { Loader2, Sparkles, Terminal } from 'lucide-react'
import { createConversation } from '../../../lib/chat-api'
import { createCodeSession } from '../../../lib/code-api'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 6 — Payoff (spec 25 §4). Creates a REAL conversation (Casual/
 *  Enthusiast) or a REAL Code session (Developer) — proving generation
 *  actually works — then ADVANCES into the rest of the wizard sequence
 *  (tune-offer / done), the same as every other step. It does NOT complete
 *  onboarding or navigate away itself.
 *
 *  An adversarial QA pass found the previous version doing both of those
 *  directly: it called completeOnboarding() then navigate() to the new
 *  conversation/session. That raced OnboardingScreen's own "already done"
 *  redirect effect — both fire off the exact same underlying event (the
 *  mutation resolving) — and whichever navigate() call won, the wizard's
 *  tune-offer/done steps became permanently unreachable for every profile,
 *  and a Developer's "Open Code" click landed on plain /workspace/chat with
 *  no id. Awaiting the mutation before navigating did NOT fix it, because
 *  the race is structural, not a timing gap.
 *
 *  The real destination is stashed in ctx.payoffDestination; Done is the
 *  step that actually calls completeOnboarding() and performs the final
 *  navigation, once the user has seen the rest of the sequence. */
export default function PayoffStep({ onContinue, ctx }: StepComponentProps) {
  const { patchCtx } = useOnboardingMachine()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Synchronous guard: `starting` is React state, so its re-render (and the
  // button's disabled prop) does not take effect until after the next
  // render commits. A second click fired before that commit bypasses it.
  // Found by adversarial QA: two synchronous clicks created two real
  // conversations, ~25ms apart, with one silently orphaned.
  const startedRef = useRef(false)

  const isDeveloper = ctx.profile === 'developer'

  const start = async () => {
    if (startedRef.current) return
    startedRef.current = true
    setStarting(true)
    setError(null)
    try {
      if (isDeveloper) {
        // createCodeSession() returns BOTH sessionId and convId — every real
        // Code API (messages, stream, export, git) keys off sessionId, and so
        // does the /workspace/code/:sessionId route itself. The re-verification
        // pass caught this: grabbing convId here landed on a URL CodeSessionScreen
        // couldn't resolve ("This session couldn't be found"), even though the
        // session had genuinely been created.
        const { sessionId } = await createCodeSession({
          repoRoot: '.',
          mode: 'auto',
          task: 'Give me a short tour of this repository and suggest one good first thing to try.',
        })
        patchCtx({ payoffDestination: { kind: 'code', id: sessionId } })
      } else {
        const conv = await createConversation({ title: 'Welcome to TurboLLM' })
        patchCtx({ payoffDestination: { kind: 'chat', id: conv.id } })
      }
      onContinue()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start it — try again.')
      setStarting(false)
      startedRef.current = false
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
