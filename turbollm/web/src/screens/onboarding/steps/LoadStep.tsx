import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Download, Loader2, Terminal } from 'lucide-react'
import { useDownloads, useModels, useStatus } from '../../../lib/queries'
import { loadModel } from '../../../lib/api'
import { useOnboardingMachine } from '../../../lib/onboarding/useOnboardingMachine'
import type { StepComponentProps } from '../OnboardingScreen'

/** Step 5 — Load (spec 25 §4). Real progress: polls the actual download
 *  record, matches the finished file to its scanned `ModelEntry`, triggers a
 *  real `loadModel()` (auto-fit — spec 25 §6.2, never a tuned config here),
 *  and advances once `Status.model` is populated.
 *
 *  Known scope gap, called out rather than faked: the daemon does not yet
 *  expose a classified load-failure reason to the client on this path (no
 *  `lastLoadError` on `Status`), so a failed load surfaces the launch-command
 *  / Models-screen recovery only — not the full per-`FAIL_REASONS` matrix
 *  `recovery.ts` already models. Wiring that needs a small server-side
 *  addition (surfacing `classifyLoadFailure`'s result on `Status`), tracked as
 *  follow-up rather than invented here. */
export default function LoadStep({ onSkip, ctx }: StepComponentProps) {
  const navigate = useNavigate()
  const { advance, patchCtx } = useOnboardingMachine()
  const downloadsQuery = useDownloads()
  const modelsQuery = useModels()
  const statusQuery = useStatus()
  const [loadTriggered, setLoadTriggered] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const advancedRef = useRef(false)

  const activeDownload = downloadsQuery.data?.downloads.find((d) => d.status !== 'done' && d.status !== 'cancelled')
  const finishedDownload = downloadsQuery.data?.downloads.find((d) => d.status === 'done')
  const matchedEntry = finishedDownload
    ? modelsQuery.data?.models.find((m) => finishedDownload.dest.endsWith(m.name) || m.path === finishedDownload.dest)
    : undefined

  const downloadPct = activeDownload && activeDownload.total > 0
    ? Math.round((activeDownload.received / activeDownload.total) * 100)
    : null

  useEffect(() => {
    if (finishedDownload && !ctx.downloadDone) patchCtx({ downloadDone: true })
  }, [finishedDownload, ctx.downloadDone, patchCtx])

  useEffect(() => {
    if (!matchedEntry || loadTriggered) return
    setLoadTriggered(true)
    // Auto-fit (ADR-190) — no tuned config on the first load, per spec 25 §6.2.
    loadModel(matchedEntry.key).catch(() => setLoadFailed(true))
  }, [matchedEntry, loadTriggered])

  const loadedModel = statusQuery.data?.model
  useEffect(() => {
    if (loadedModel && !advancedRef.current) {
      advancedRef.current = true
      advance()
    }
  }, [loadedModel, advance])

  if (loadFailed) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Terminal size={20} className="text-red-400" />
          <h3 className="text-lg font-semibold text-ink">The load didn't finish</h3>
        </div>
        <p className="text-sm text-muted">
          Check the launch command and logs on the Models screen for what went wrong, or try a
          smaller quant.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setLoadFailed(false); setLoadTriggered(false) }}
            className="rounded-lg border border-accent bg-accent/10 text-accent px-4 py-2 text-sm font-medium hover:bg-accent/20 transition-colors"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => navigate('/models')}
            className="text-sm text-accent hover:text-accent-hover"
          >
            Open Models →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <Loader2 size={20} className="text-accent animate-spin" />
        <h3 className="text-lg font-semibold text-ink">Loading your model</h3>
      </div>
      <p className="text-sm text-muted mb-6">
        Don't close this tab — your progress is saved either way.
      </p>

      <div className="space-y-3">
        <div className="flex items-center gap-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center">
            {finishedDownload ? (
              <Check size={16} className="text-accent" />
            ) : (
              <Download size={16} className="text-accent" />
            )}
          </div>
          <div className="flex-1">
            <span className="text-sm text-ink">
              {finishedDownload ? 'Download complete' : 'Downloading'}
            </span>
            {!finishedDownload && downloadPct !== null && (
              <div className="mt-1 h-1.5 rounded-full bg-panel overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${downloadPct}%` }} />
              </div>
            )}
          </div>
        </div>

        <div className={`flex items-center gap-4 rounded-lg border p-3 ${loadTriggered ? 'border-accent/30 bg-accent/5' : 'border-transparent'}`}>
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center">
            {loadedModel ? <Check size={16} className="text-accent" /> : <Loader2 size={16} className={loadTriggered ? 'text-accent animate-spin' : 'text-muted'} />}
          </div>
          <span className={`text-sm ${loadTriggered ? 'text-ink' : 'text-faint'}`}>Loading into memory</span>
        </div>
      </div>

      <div className="flex items-center justify-end pt-2">
        <button type="button" onClick={onSkip} className="text-sm text-faint hover:text-muted transition-colors">
          Skip this
        </button>
      </div>
    </div>
  )
}
