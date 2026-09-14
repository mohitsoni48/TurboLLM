import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Popover from '@radix-ui/react-popover'
import { getRemoteStatus, isPublicProvider, stopRemote, type RemoteState } from '../lib/remote-api'
import { track } from '../lib/api'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { CopyButton } from './ui/copy-button'

// Color per live state (spec 30 §11, tokens only): connected=ok, reconnecting/starting=warn,
// failed=err. Same convention as StateChip.tsx's engine-state dot.
const DOT_COLOR: Record<'connected' | 'reconnecting' | 'starting' | 'failed', string> = {
  connected: 'var(--ok)',
  reconnecting: 'var(--warn)',
  starting: 'var(--warn)',
  failed: 'var(--err)',
}

/** Persistent shell chip (ADR-422, spec 30 §7), beside HardwareBar: makes remote access
 *  first-class instead of a toggle buried three clicks deep in Settings. Renders nothing
 *  unless `enabled` (the `daemon.experimental.remoteAccess` flag) is on AND the live state is
 *  one it has something to say about — `off`/`unavailable`/`needs-setup` render nothing, same
 *  as the pane not existing at all.
 *
 *  The Public / Your-devices split is the entire reason this component exists: telling someone
 *  their LLM is reachable from the internet when it is really only reachable on their tailnet
 *  (Tailscale Serve) is a lie the UI must never tell — a warning that cries wolf gets ignored on
 *  the providers where it's true (spec 30 §7.2). */
export function RemoteChip({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  // Not `useRemoteStatus` (remote-api.ts's own export): its internal call to `getRemoteStatus`
  // is a same-module reference that a `vi.mock('../lib/remote-api', ...)` override in this
  // component's own test cannot intercept — only a cross-module import (this call) goes through
  // the mock. Same queryKey/interval as RemoteAccessSection.tsx's query, so the pane and the
  // chip share one cached poll rather than each hitting the daemon on their own cadence.
  const statusQ = useQuery({
    queryKey: ['remote-status'],
    queryFn: getRemoteStatus,
    enabled,
    refetchInterval: 6_000,
    retry: false,
  })
  const status = statusQ.data

  if (!enabled || !status) return null
  const { state } = status
  if (state.kind === 'off' || state.kind === 'unavailable' || state.kind === 'needs-setup') return null

  const label = chipLabel(state, status.provider)
  const dotColor = DOT_COLOR[state.kind]
  const pulse = state.kind === 'starting' || state.kind === 'reconnecting'

  const stopSharing = () => {
    track('settings', 'stop_remote_from_chip')
    void stopRemote().finally(() => void qc.invalidateQueries({ queryKey: ['remote-status'] }))
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Remote access"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2 py-0.5 text-[12px] leading-none text-muted"
        >
          <span className={cn('h-2 w-2 rounded-full', pulse && 'tllm-pulse')} style={{ background: dotColor }} />
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-64 rounded-lg border border-border bg-panel p-3 shadow-lg"
        >
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium text-ink">{label}</div>
            {status.url && (
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate font-mono text-[11px] text-muted">{status.url}</span>
                <CopyButton text={status.url} screen="settings" />
              </div>
            )}
            {state.kind === 'reconnecting' && (
              <div className="text-[11px] text-faint">
                Attempt {state.attempt} · {state.lastError}
              </div>
            )}
            {state.kind === 'failed' && <div className="text-[11px] text-faint">{state.reason}</div>}
            <Button size="sm" variant="outline" onClick={stopSharing}>
              Stop sharing
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function chipLabel(state: RemoteState, provider: Parameters<typeof isPublicProvider>[0]): string {
  switch (state.kind) {
    case 'connected':
      return isPublicProvider(provider) ? 'Public' : 'Your devices'
    case 'reconnecting':
      return 'Reconnecting'
    case 'starting':
      return 'Starting'
    case 'failed':
      return 'Remote access failed'
    default:
      return ''
  }
}
