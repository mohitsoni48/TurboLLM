import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import type { EngineError, Status } from '../lib/types'
import { Button } from './ui/button'
import { CopyButton } from './ui/copy-button'
import { track } from '../lib/api'

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
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const state = status?.engine.state
  const error = status?.engine.error
  const key = errorKey(error)

  if (state !== 'error' || !error || key === dismissedKey) return null

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
      {error.logTail && error.logTail.length > 0 && (
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
