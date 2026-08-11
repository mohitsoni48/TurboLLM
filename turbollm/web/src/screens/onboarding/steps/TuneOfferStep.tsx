import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Loader2 } from 'lucide-react'
import { useStatus } from '../../../lib/queries'
import { loadModel, startBench, stopEngine, track } from '../../../lib/api'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step "tune-offer" (spec 25 §6.2, ADR-338). Offered right after Load, BEFORE
 *  the payoff — never on T0 (enforced by `registry.ts`'s `appliesTo`, not
 *  here). Triggers a REAL auto-tune run and shows the REAL live `step` text
 *  from `bench.ts` while it runs.
 *
 *  Deliberately shows NO speed number and NO duration estimate anywhere —
 *  an earlier draft of this step hardcoded "~120 tokens/s", which directly
 *  contradicted the founder's "no need to show speed during onboarding"
 *  decision already recorded in ADR-338. The full result (including t/s) is
 *  still shown later by the existing results dialog outside onboarding. */
export default function TuneOfferStep({ onContinue }: StepComponentProps) {
  const { data: status } = useStatus()
  const running = status?.bench?.running ?? false
  const done = status?.bench?.done ?? false
  const engineState = status?.engine.state

  // The runner requires a fully free engine (409 otherwise) — the model Payoff needs is
  // still loaded at this point, so a bare `startBench` call 409s every time. Found live:
  // "Run auto-tuner" appeared to do nothing because the click's promise was fire-and-forget
  // (`void startBench(...)`), silently swallowing that exact 409. Mirrors
  // ModelDetailDialog's "Stop & benchmark" pattern — stop first, fire the sweep once the
  // engine actually reports stopped.
  const [pendingBenchKey, setPendingBenchKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Captured at the moment "Run auto-tuner" is clicked, before the stop-then-bench sequence
  // clears `status.model` — bench.ts always leaves the engine stopped when a run finishes
  // (cancelled or not), so Payoff's "your model is ready" premise needs this to reload it.
  // A ref, not onboarding ctx: it only needs to survive this component's own lifetime.
  const modelKeyRef = useRef<string | null>(null)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    if (pendingBenchKey && (engineState === 'stopped' || engineState === 'error')) {
      const key = pendingBenchKey
      setPendingBenchKey(null)
      void startBench(key).catch((e) => setError(e instanceof Error ? e.message : 'Could not start auto-tune.'))
    }
  }, [pendingBenchKey, engineState])

  const run = () => {
    const modelKey = status?.model?.key
    if (!modelKey) return
    track('onboarding', 'accept_autotune')
    modelKeyRef.current = modelKey
    setError(null)
    if (engineState === 'stopped' || engineState === 'error') {
      void startBench(modelKey).catch((e) => setError(e instanceof Error ? e.message : 'Could not start auto-tune.'))
    } else {
      setPendingBenchKey(modelKey)
      void stopEngine().catch((e) => {
        setPendingBenchKey(null)
        setError(e instanceof Error ? e.message : 'Could not stop the engine to start auto-tune.')
      })
    }
  }

  const continueToPayoff = async () => {
    // "Declined" means Continue was clicked without ever running a sweep — modelKeyRef only
    // gets set inside `run()`, so its absence here is exactly that signal. Continuing AFTER a
    // sweep (accepted, possibly still catching up) is not a decline, just proceeding onward.
    if (!modelKeyRef.current) track('onboarding', 'decline_autotune')
    if (!status?.model && modelKeyRef.current) {
      setReloading(true)
      // Best-effort: if this genuinely fails, Payoff's own "Start chatting"/"Open Code"
      // click will surface a real error instead of silently proceeding on a dead engine.
      try { await loadModel(modelKeyRef.current) } catch { /* see above */ }
      setReloading(false)
    }
    onContinue()
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
        ) : running || pendingBenchKey ? (
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="text-accent animate-spin" />
            <span className="text-sm text-ink">{running ? (status?.bench?.step ?? 'Running…') : 'Stopping the current model…'}</span>
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
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      </div>

      {/* No per-step "Skip onboarding" here — the shell's own top-bar and bottom-link
          skip already cover every step; a third, redundant copy here duplicated one of
          them exactly, found live: two identically-labeled buttons on one screen. */}
      <div className="pt-2">
        <button
          type="button"
          onClick={continueToPayoff}
          disabled={reloading}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-panel px-4 py-2 text-sm text-muted hover:border-accent/50 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {reloading ? <Loader2 size={14} className="animate-spin" /> : null}
          {reloading ? 'Loading your model…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
