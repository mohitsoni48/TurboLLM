import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Compass, Download, ExternalLink, HardDrive, Loader2, Sparkles } from 'lucide-react'
import { useOnboardingRecommendation } from '../../../lib/onboarding-queries'
import { useDownloadMutations, useModels, useSysInfo } from '../../../lib/queries'
import { loadModel, track } from '../../../lib/api'
import { pickOnboardingModel } from '../../../lib/onboarding-pick'
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
  const sysQuery = useSysInfo()
  const modelsQuery = useModels()
  const downloadMutations = useDownloadMutations()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [usingExisting, setUsingExisting] = useState(false)

  const existingModels = modelsQuery.data?.models ?? []

  const useExisting = async () => {
    const entry = existingModels.find((m) => m.key === selectedKey)
    if (!entry) return
    track('onboarding', 'use_existing_models')
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

  const isPro = ctx.profile === 'pro'

  // Pro is a real early return ONLY for the loading/no-profile guard below — Pro skips the
  // recommendation query entirely (useOnboardingRecommendation disables it for 'pro'), so
  // there's nothing to wait on. Past that, Pro renders through the SAME return as everyone
  // else (see the shared "use a model I already have" + "pick a different model" sections
  // near the bottom) — it used to be its own early return with ONLY the Discover-handoff
  // card, which meant Pro could never see "use a model I already have" no matter how many
  // models were already on disk. ADR-338 Decision 6b is explicit that this option "is still
  // offered alongside [Discover], so a Pro with a full model folder is never pushed into a
  // download" — found live by adversarial QA as a real, structural violation of that line,
  // not deferred scope.
  //
  // Sysinfo is waited on alongside the recommendation — the pick is screened against it
  // (see `pickOnboardingModel`), so rendering before it lands would show the daemon's
  // entry and then silently swap it for a smaller one a frame later, on exactly the
  // low-memory devices where the swap matters most. The spinner already says "checking
  // your hardware", which is now literally what it is doing. It never blocks for long:
  // that query is `staleTime: Infinity, retry: false`, so a failure resolves rather than
  // hanging, and a null sysinfo just means "trust the daemon" downstream.
  if (!isPro && (recommendationQuery.isLoading || sysQuery.isLoading || !ctx.profile)) {
    return (
      <div className="flex items-center justify-center gap-2 text-muted py-8">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-sm">Checking your hardware…</span>
      </div>
    )
  }

  const rec = recommendationQuery.data?.recommendation
  const entry = rec?.kind === 'entry' ? rec.entry : null

  // The daemon picks by VRAM band; this screens that pick against what THIS device can
  // actually hold and degrades to a smaller real model instead of a 4 GB download that
  // OOMs — see onboarding-pick.ts's header for the phone case that motivates it. `entry`
  // is passed through untouched whenever it fits, which is every desktop with a card.
  const pick = pickOnboardingModel(entry, sysQuery.data ?? null)
  const picked = pick.kind === 'pick' ? pick : null
  const sys = sysQuery.data

  // Only ever a claim we can back with detected hardware: no sysinfo → no fit line at all,
  // rather than a reassuring sentence about a machine we never measured (ADR-012's "always
  // labeled an estimate" applies doubly to a number shown before first run).
  const fitLine = !picked || !picked.budgetMb
    ? null
    : picked.source === 'small-device'
      ? `Sized for this device — about ${(picked.budgetMb / 1024).toFixed(1)} GB is free for a model here, so this is the largest good one that will actually load.`
      : sys?.gpus.length
        ? `Fits your ${sys.gpus[0].name}.`
        : `Fits in your ${Math.round((sys?.ramMB ?? 0) / 1024)} GB of RAM.`

  const startDownload = async () => {
    if (!picked) return
    track('onboarding', 'start_model_download')
    setStarting(true)
    setError(null)
    try {
      // ADR-338 Decision 6: "never pull mmproj-*.gguf — pure added download before first
      // token." Found live by adversarial QA: the blessed entry's own "Download this" was
      // silently pulling the vision projector alongside every recommended model, since
      // enqueue()'s expansion has no per-caller opt-out by default.
      //
      // The MUTATION, not the raw `enqueueDownload()` API call directly: found by an Opus
      // release-review pass, live-traced — the raw call never invalidates the downloads
      // query cache, so LoadStep can mount on the very next render still seeing the
      // pre-download empty list. `useDownloadMutations().enqueue`'s `onSuccess: invalidate`
      // refreshes downloads/models/status immediately, closing that window.
      const { downloads } = await downloadMutations.enqueue.mutateAsync({ repo: picked.repo, rfilename: picked.file, excludeMmproj: true })
      // Stamp the specific download record LoadStep should wait for — its eventual model
      // key isn't known yet (the file doesn't exist to scan), unlike `expectedModelKey`
      // below, so this is a download ID instead. Without it, LoadStep's fallback ("the
      // most recent finished download in the whole history") can match an older, unrelated,
      // already-loaded model while THIS download is still in flight — found live driving a
      // real, non-instant download against real HuggingFace.
      const primary = downloads.find((d) => d.name === picked.file) ?? downloads[0]
      if (primary) patchCtx({ expectedDownloadId: primary.id })
      onContinue()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the download.')
      setStarting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        {isPro ? <Compass size={20} className="text-accent" /> : <Sparkles size={20} className="text-accent" />}
        <h3 className="text-lg font-semibold text-ink">{isPro ? 'Pick your own model' : 'Choose your model'}</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        {isPro
          ? "You're pro enough to decide — browse Hugging Face directly and choose the exact model and quant for your setup."
          : "Based on your hardware, here's what we recommend."}
      </p>

      {isPro ? (
        <button
          type="button"
          onClick={() => {
            // Pro's own primary CTA (its only path to a model, not a decline of a
            // recommendation like the shared link below) — a distinct event from
            // `pick_different_model` so the two are segmentable in the funnel.
            track('onboarding', 'open_discover_handoff')
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
      ) : picked ? (
        <div className="bg-panel-2 border border-accent/40 rounded-xl p-5 space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 p-3 rounded-lg bg-accent/10">
              <HardDrive size={24} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              {/* The model NAME leads, not the repo id. The card used to open with
                  "unsloth/gemma-4-12b-it-GGUF" in the same weight as the filename under it,
                  which reads as one row of an undifferentiated list rather than as a
                  recommendation — founder-reported. Owner + exact file stay one line down,
                  because they are what makes the pick checkable against Hugging Face. */}
              <p className="text-[11px] uppercase tracking-wide text-accent font-medium">Recommended for you</p>
              <span className="block text-base font-semibold text-ink mt-0.5 break-words">{picked.name}</span>
              <p className="text-xs text-muted mt-0.5 break-all">
                {picked.repo} · {picked.file} · {(picked.bytes / GB).toFixed(1)} GB
              </p>
              {fitLine && <p className="text-xs text-muted mt-2">{fitLine}</p>}
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
                {/* A missing sizeLabel (a scan that hasn't resolved one yet) previously left a
                    dangling trailing " · " with nothing after it — found live by adversarial
                    QA. `quant`'s own "?" placeholder (quantFromName's documented "unknown"
                    convention) is intentional and kept, unlike a genuinely empty field. */}
                {[m.name, m.quant, m.sizeLabel].filter(Boolean).join(' · ')}
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

      {!isPro && (
        <button
          type="button"
          onClick={() => {
            track('onboarding', 'pick_different_model')
            onContinue()
            navigate('/models?tab=discover')
          }}
          className="text-sm text-accent hover:text-accent-hover"
        >
          Pick a different model →
        </button>
      )}
    </div>
  )
}
