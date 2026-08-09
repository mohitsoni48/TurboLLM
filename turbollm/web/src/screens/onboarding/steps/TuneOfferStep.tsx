import { ArrowUpRight, Check, Loader2 } from 'lucide-react'
import { useStatus } from '../../../lib/queries'
import { startBench } from '../../../lib/api'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step "tune-offer" (spec 25 §6.2, ADR-338). Offered only after the payoff —
 *  never before, never on T0 (enforced by `registry.ts`'s `appliesTo`, not
 *  here). Triggers a REAL auto-tune run and shows the REAL live `step` text
 *  from `bench.ts` while it runs.
 *
 *  Deliberately shows NO speed number and NO duration estimate anywhere —
 *  an earlier draft of this step hardcoded "~120 tokens/s", which directly
 *  contradicted the founder's "no need to show speed during onboarding"
 *  decision already recorded in ADR-338. The full result (including t/s) is
 *  still shown later by the existing results dialog outside onboarding. */
export default function TuneOfferStep({ onContinue, onSkip }: StepComponentProps) {
  const { data: status } = useStatus()
  const running = status?.bench?.running ?? false
  const done = status?.bench?.done ?? false

  const run = () => {
    const modelKey = status?.model?.key
    if (modelKey) void startBench(modelKey)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <ArrowUpRight size={20} className="text-accent" />
        <h3 className="text-lg font-semibold text-ink">Make it faster</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        Auto-tune can find faster settings for your hardware. It reloads the model several
        times, so it takes a bit — you can keep chatting once it's running.
      </p>

      <div className="bg-panel-2 border border-border rounded-xl p-5">
        {done ? (
          <div className="flex items-center gap-3">
            <Check size={16} className="text-accent" />
            <span className="text-sm text-ink">Auto-tune finished — review the result in Models.</span>
          </div>
        ) : running ? (
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="text-accent animate-spin" />
            <span className="text-sm text-ink">{status?.bench?.step ?? 'Running…'}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={run}
            disabled={!status?.model}
            className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent/10 text-accent py-2.5 px-4 text-sm font-medium hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Run auto-tuner
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onContinue}
          className="rounded-lg border border-border bg-panel px-4 py-2 text-sm text-muted hover:border-accent/50 hover:text-ink transition-colors"
        >
          Continue
        </button>
        <button type="button" onClick={onSkip} className="text-sm text-faint hover:text-muted transition-colors">
          Skip onboarding
        </button>
      </div>
    </div>
  )
}
