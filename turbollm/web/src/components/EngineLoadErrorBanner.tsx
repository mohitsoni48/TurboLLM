import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import type { EngineError, Status } from '../lib/types'
import { Button } from './ui/button'
import { CopyButton } from './ui/copy-button'
import { track, loadModel } from '../lib/api'
import { LoadFailureRecovery } from './LoadFailureRecovery'

/** Every distinct `errInfo` the backend produces (`manager.ts` — `onTerminated`,
 *  `readiness`'s timeout/model-load-failure branches) is a fresh object literal, so
 *  content is the only stable identity across polls: `status` is re-fetched over HTTP
 *  on every poll, which always yields a new JS object even for the SAME ongoing error —
 *  comparing by reference would never match and the banner could never be dismissed. */
function errorKey(error: EngineError | undefined): string | null {
  if (!error) return null
  return `${error.code}:${error.message}:${error.exitCode ?? ''}:${(error.logTail ?? []).join('\n')}`
}

/**
 * Global banner for a failed model load (`status.engine.state === 'error'`,
 * GitHub #85's second report). Chat/Code only ever rendered a transient
 * "Loading model…" label tied to the 'starting' state and went silent the
 * moment the engine flipped to 'error' (readiness timeout, crash, etc) — the
 * error + log tail already existed on the backend (`EngineRuntime.error`) but
 * only the Engines screen's own status header ever displayed it. Mirrors that
 * block, rendered above every screen next to EngineProvisionBanner.
 *
 * Not suppressed on /engines: EngineStatusHeader there only renders while
 * `activeEngine` is truthy (EnginesScreen.tsx), so route-based suppression could
 * hide the only error surface in the same edge case it doesn't. A little visual
 * overlap when both show the same error is the safer failure mode. Only the
 * redundant "Open Engines" button hides there (cosmetic, no information lost).
 */
export function EngineLoadErrorBanner({ status }: { status: Status | undefined }) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [showLaunch, setShowLaunch] = useState(false)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const state = status?.engine.state
  const error = status?.engine.error
  const key = errorKey(error)

  if (state !== 'error' || !error || key === dismissedKey) return null

  /** Re-attempt the load that just failed. `status.model` is null after a failure, so the
   *  key comes from `lastLoaded` — the daemon's config-tracked record of what the user
   *  asked for, which survives the failure. Returns whether it worked, so the recovery
   *  event can report a real `outcome` rather than assuming the click succeeded. */
  async function retryLoad(): Promise<boolean> {
    const key = status?.lastLoaded
    if (!key) return false
    try {
      await loadModel(key)
      return true
    } catch {
      return false
    }
  }

  return (
    <div
      className="border-b px-4 py-2"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span className="flex-1 font-medium" style={{ color: 'var(--err)' }}>
          Model load failed: {error.message}
          {error.exitCode != null && ` (exit ${error.exitCode})`}
        </span>
        {!pathname.startsWith('/engines') && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[12px]"
            onClick={() => { track('engines', 'open_engines_from_error_banner'); navigate('/engines') }}
          >
            Open Engines
          </Button>
        )}
        <CopyButton text={(error.logTail ?? []).join('\n')} label="Copy log" size={13} screen="engines" />
        <button
          type="button"
          onClick={() => { track('engines', 'dismiss_engine_error_banner'); setDismissedKey(key) }}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:text-ink"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      {/* ADR-338 Decision 4's invariant — no failure terminates without a next action.
          Until this, the banner offered only "Copy log" and "Dismiss": diagnostics, not
          remedies. `failReason` falls back to 'other' when the daemon predates the field
          (or could not classify), and 'other' still yields actions, so this can never
          render an empty row. */}
      <LoadFailureRecovery
        failure={error.failReason ?? 'other'}
        launchCommand={status?.engine.launchCommand}
        onRetry={async () => {
          const ok = await retryLoad()
          if (ok) setDismissedKey(key)
          return ok
        }}
        onShowLaunchCommand={() => setShowLaunch((v) => !v)}
      />
      {showLaunch && status?.engine.launchCommand && (
        <pre
          className="mt-1.5 max-h-32 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-[1.5]"
          style={{ background: 'var(--log-bg)', color: 'var(--log-ink)' }}
        >
          {status.engine.launchCommand}
        </pre>
      )}
      {/* QA_BUGS.md BUG-12: an ENOENT-style spawn failure never gets a chance to write
          anything to stderr, so `logTail` comes back as `['']` — one empty line, not
          "no lines". `.length > 0` alone rendered that as an unlabeled, contentless dark
          box; requiring at least one NON-blank line matches what a human would call
          "there is log output" and falls through to the "Copy log"/dismiss-only banner
          (still fully informative — the error message above already has the real
          reason) instead of an empty placeholder. */}
      {error.logTail && error.logTail.some((line) => line.trim().length > 0) && (
        <pre
          className="mt-1.5 max-h-32 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-[1.5]"
          style={{ background: 'var(--log-bg)', color: 'var(--log-err-ink)' }}
        >
          {error.logTail.join('\n')}
        </pre>
      )}
    </div>
  )
}
