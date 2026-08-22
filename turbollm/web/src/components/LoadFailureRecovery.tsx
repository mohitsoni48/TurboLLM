/**
 * One-click recovery for a failed model load (ADR-338 Decision 4, spec 25 §7).
 *
 * The pieces this sits on top of all pre-existed and were never connected:
 *   - `classifyLoadFailure` (daemon) reduced every failure to a closed enum, wired
 *     only to telemetry. It now also rides on `status.engine.error.failReason`.
 *   - `recovery.ts` maps each enum member to actions, exhaustively. It had zero callers.
 *   - `POST /api/v1/telemetry/recovery` forwards `onboarding_recovery`. Nothing called it.
 *
 * This component is the missing UI layer, and it is what makes the invariant real:
 * **no failure may terminate without a next action.** Before it, a failed load offered
 * "Copy log" and "Dismiss" — diagnostics, not remedies.
 *
 * Every action reports `onboarding_recovery { failure, action, outcome }`. That event is
 * the ROI measurement for the whole recovery half (ADR-338 Decision 8); a button that
 * does not report is a button whose value can never be argued for later.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from './ui/button'
import { recoveryFor, type RecoveryAction, type RecoveryActionId } from '../screens/onboarding/recovery'
import type { LoadFailure } from '../lib/types'
import { trackRecovery } from '../lib/api'

/** kebab (UI ids) → snake (`RECOVERY_ACTIONS`, the telemetry enum). Two vocabularies
 *  already existed on either side of the wire; this is the single crossing point, so
 *  the mapping lives here instead of being spelled at each call site. */
const ACTION_EVENT_ID: Record<RecoveryActionId, string> = {
  'retry': 'retry',
  'use-existing-folder': 'use_existing_folder',
  'alt-build-variant': 'alt_build_variant',
  'hf-search': 'hf_search',
  'llamafile': 'llamafile',
  'build-from-source': 'build_from_source',
  'smaller-quant': 'smaller_quant',
  'show-path-fix': 'show_path_fix',
  'lower-quant-retry': 'lower_quant_retry',
  'redownload': 'redownload',
  'alt-engine': 'alt_engine',
  'longer-timeout': 'longer_timeout',
  'back-to-engine': 'back_to_engine',
  'resume': 'resume',
  'show-launch-command': 'show_launch_command',
}

export interface LoadFailureRecoveryProps {
  failure: LoadFailure
  /** Shown by `show-launch-command`, the remedy for an unclassified failure: the exact
   *  argv the daemon last spawned. Absent when no engine is current. */
  launchCommand?: string
  /** Retry the load that just failed. Resolves to whether it worked, which is what the
   *  `outcome` field of the event reports — so "we offered a fix" and "the fix worked"
   *  stay separable in the data. */
  onRetry?: () => Promise<boolean>
  onShowLaunchCommand?: () => void
}

export function LoadFailureRecovery({
  failure,
  launchCommand,
  onRetry,
  onShowLaunchCommand,
}: LoadFailureRecoveryProps) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<RecoveryActionId | null>(null)
  const actions = recoveryFor(failure)

  async function run(action: RecoveryAction) {
    if (busy) return
    setBusy(action.id)
    let outcome: 'ok' | 'fail' = 'ok'
    try {
      switch (action.id) {
        // A genuine re-attempt of the same load — the only actions whose success is
        // knowable here. Deliberately NOT 'lower-quant-retry' or 'redownload': neither
        // is a reload of the same config, and wiring them here would make the button
        // lie about what it did.
        case 'retry':
        case 'resume':
          outcome = onRetry ? ((await onRetry()) ? 'ok' : 'fail') : 'fail'
          break
        case 'show-launch-command':
          onShowLaunchCommand?.()
          break
        // Hand-offs. `outcome: 'ok'` here means "the user was taken somewhere they can
        // fix it", NOT "the model loaded" — the follow-on `model_load` event is what
        // says whether it actually worked, and joining the two is the analysis.
        case 'back-to-engine':
        case 'alt-engine':
        case 'alt-build-variant':
        case 'build-from-source':
        case 'llamafile':
          navigate('/engines')
          break
        // Hand-offs to the Models screen, where the quant picker and the re-download
        // both live. A true single-click "retry one quant lower" needs the model's
        // available-quant list, which this banner does not have — routing to the place
        // that does is honest; pretending to have retried would not be.
        case 'smaller-quant':
        case 'lower-quant-retry':
        case 'redownload':
        case 'hf-search':
        case 'use-existing-folder':
          navigate('/models')
          break
        case 'show-path-fix':
        case 'longer-timeout':
          navigate('/settings')
          break
      }
    } catch {
      outcome = 'fail'
    } finally {
      setBusy(null)
    }
    // Best-effort and deliberately unawaited-for-correctness: a telemetry failure must
    // never make a recovery look like it failed.
    trackRecovery(failure, ACTION_EVENT_ID[action.id], outcome)
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {actions.map((action) => (
        <Button
          key={action.id}
          size="sm"
          variant={action.primary ? 'default' : 'outline'}
          className="h-6 px-2 text-[12px]"
          disabled={busy !== null}
          onClick={() => void run(action)}
        >
          {busy === action.id ? 'Working…' : action.label}
        </Button>
      ))}
      {failure === 'other' && launchCommand && (
        <span className="text-[12px] text-muted">
          No specific cause detected — the launch command usually shows why.
        </span>
      )}
    </div>
  )
}
