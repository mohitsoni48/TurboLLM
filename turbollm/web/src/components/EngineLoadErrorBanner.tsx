import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import type { Status } from '../lib/types'
import { Button } from './ui/button'
import { CopyButton } from './ui/copy-button'

/**
 * Global banner for a failed model load (`status.engine.state === 'error'`,
 * GitHub #85's second report). Chat/Code only ever rendered a transient
 * "Loading model…" label tied to the 'starting' state and went silent the
 * moment the engine flipped to 'error' (readiness timeout, crash, etc) — the
 * error + log tail already existed on the backend (`EngineRuntime.error`) but
 * only the Engines screen's own status header ever displayed it. Mirrors that
 * block, rendered above every screen next to EngineProvisionBanner. Suppressed
 * on /engines itself, which already shows the same detail inline.
 */
export function EngineLoadErrorBanner({ status }: { status: Status | undefined }) {
  const [dismissed, setDismissed] = useState(false)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const state = status?.engine.state
  const error = status?.engine.error

  // Re-arm on the next attempt so a fresh failure isn't hidden by a stale dismissal
  // from a previous one (e.g. user dismisses, retries, hits a different error).
  useEffect(() => {
    if (state !== 'error') setDismissed(false)
  }, [state])

  if (state !== 'error' || !error || dismissed || pathname.startsWith('/engines')) return null

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
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[12px]"
          onClick={() => navigate('/engines')}
        >
          Open Engines
        </Button>
        <CopyButton text={(error.logTail ?? []).join('\n')} label="Copy log" size={13} />
        <button
          type="button"
          onClick={() => setDismissed(true)}
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
