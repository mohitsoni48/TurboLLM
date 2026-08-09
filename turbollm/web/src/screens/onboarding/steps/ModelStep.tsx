import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Compass, Download, ExternalLink, HardDrive, Loader2, Sparkles } from 'lucide-react'
import { useOnboardingRecommendation } from '../../../lib/onboarding-queries'
import { useModels } from '../../../lib/queries'
import { enqueueDownload, loadModel } from '../../../lib/api'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { StepComponentProps } from '../OnboardingScreen'

const GB = 1024 ** 3

/** Step 2 — Model (spec 25 §4, ADR-338 Decision 6b). Pro gets NO
 *  recommendation — it is handed the real Discover tab and picks its own
 *  model and quant. Everyone else sees the server-computed recommendation
 *  (spec 25 §5.2) and can download it for real, or fall back to "use models I
 *  already have" / browse Discover themselves. */
export default function ModelStep({ onContinue, ctx }: StepComponentProps) {
  const navigate = useNavigate()
  const { patchCtx } = useOnboardingMachine()
  const recommendationQuery = useOnboardingRecommendation(ctx.profile)
  const modelsQuery = useModels()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [usingExisting, setUsingExisting] = useState(false)

  const existingModels = modelsQuery.data?.models ?? []

  const useExisting = async () => {
    const entry = existingModels.find((m) => m.key === selectedKey)
    if (!entry) return
    setUsingExisting(true)
    setError(null)
    try {
      // No download to wait for — mark it done immediately so the
      // download-shadow steps (personalize/profile-extra) drop out, then
      // trigger the real load right here. LoadStep's own "watch Status.model"
      // effect advances once it lands. `expectedModelKey` is required, not
      // optional: without it, LoadStep advanced the instant ANY model was
      // already loaded (a leftover from prior use), found by adversarial QA.
      patchCtx({ downloadDone: true, expectedModelKey: entry.key })
      await loadModel(entry.key)
      onContinue()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that model.')
      setUsingExisting(false)
    }
  }

  if (ctx.profile === 'pro') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Compass size={20} className="text-accent" />
          <h3 className="text-lg font-semibold text-ink">Pick your own model</h3>
        </div>
        <p className="text-sm text-muted mb-6">
          You're pro enough to decide — browse Hugging Face directly and choose the exact model
          and quant for your setup.
        </p>
        <button
          type="button"
          onClick={() => {
            onContinue()
            navigate('/models?tab=discover')
          }}
          className="w-full flex items-center gap-3 p-4 rounded-lg border border-accent bg-accent/5 hover:bg-accent/10 transition-colors text-left"
        >
          <div className="flex-shrink-0 p-2.5 rounded-lg bg-accent/10 text-accent">
            <ExternalLink size={20} />
          </div>
          <div className="flex-1">
            <span className="text-sm font-semibold text-ink">Open Discover</span>
            <p className="text-xs text-muted mt-0.5">
              Browse Hugging Face, pick a quant, and download — onboarding resumes when you're
              done.
            </p>
          </div>
        </button>
      </div>
    )
  }

  if (recommendationQuery.isLoading || !ctx.profile) {
    return (
      <div className="flex items-center justify-center gap-2 text-muted py-8">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">Checking your hardware…</span>
      </div>
    )
  }

  const rec = recommendationQuery.data?.recommendation
  const entry = rec?.kind === 'entry' ? rec.entry : null

  const startDownload = async () => {
    if (!entry) return
    setStarting(true)
    setError(null)
    try {
      await enqueueDownload({ repo: entry.repo, rfilename: entry.file })
      onContinue()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the download.')
      setStarting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <Sparkles size={20} className="text-accent" />
        <h3 className="text-lg font-semibold text-ink">Choose your model</h3>
      </div>
      <p className="text-sm text-muted mb-6">Based on your hardware, here's what we recommend.</p>

      {entry ? (
        <div className="bg-panel-2 border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 p-3 rounded-lg bg-accent/10">
              <HardDrive size={24} className="text-accent" />
            </div>
            <div className="flex-1">
              <span className="text-sm font-semibold text-ink">{entry.repo}</span>
              <p className="text-xs text-muted mt-0.5">
                {entry.file} · {(entry.bytes / GB).toFixed(1)} GB
              </p>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="button"
            onClick={startDownload}
            disabled={starting}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-accent bg-accent/10 text-accent py-2.5 px-4 text-sm font-medium hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {starting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {starting ? 'Starting…' : 'Download this'}
          </button>
        </div>
      ) : (
        <div className="bg-panel-2 border border-border rounded-xl p-5 text-sm text-muted">
          Nothing in our short list fits this machine yet — browse Hugging Face for a model that
          does.
        </div>
      )}

      {existingModels.length > 0 && (
        <div className="bg-panel-2 border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-muted" />
            <h4 className="text-sm font-semibold text-ink">Use a model I already have</h4>
          </div>
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm text-ink outline-none focus:border-accent transition-colors"
          >
            <option value="" disabled>
              Choose a model…
            </option>
            {existingModels.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name} · {m.quant} · {m.sizeLabel}
              </option>
            ))}
          </select>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="button"
            onClick={useExisting}
            disabled={!selectedKey || usingExisting}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-panel py-2.5 px-4 text-sm font-medium text-ink hover:border-accent/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {usingExisting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {usingExisting ? 'Loading…' : 'Use this model'}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          onContinue()
          navigate('/models?tab=discover')
        }}
        className="text-sm text-accent hover:text-accent-hover"
      >
        Pick a different model →
      </button>
    </div>
  )
}
