// The one way the UI loads a local model (ADR-434 (i)(3), divergence row 19).
//
// A chat model loads exactly as it always has. A Jev model unloads whatever is running and
// takes Workspace over, so it asks first — but only when something really is running, the same
// "active work, not an open window" rule as the daemon-restart gate. When the daemon cannot be
// asked, it fails OPEN to the confirmation: "I couldn't check" is not "nothing is running".
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from '../components/ui/sonner'
import { useJevLoadStore, type LoadOptions, type LoadTarget } from '../stores/jev-load'
import { track } from './api'
import { getActivity } from './jev-api'
import { JEV_PATH } from './jev-mode'
import { useModelActions, useStatus } from './queries'
import type { ActiveWork } from './types'

export type { LoadOptions, LoadTarget }

export function useModelLoader(): {
  requestLoad(target: LoadTarget, opts?: LoadOptions): void
  confirmLoad(target: LoadTarget, opts: LoadOptions): void
  isPending: boolean
  pendingKey: string | undefined
  loadError: { key: string; message: string } | null
} {
  const actions = useModelActions()
  const setConfirm = useJevLoadStore((s) => s.setConfirm)
  const setPendingJevKey = useJevLoadStore((s) => s.setPendingJevKey)
  // The load itself, not this hook's own mutation observer — a surface must report the load
  // that is really running, whichever surface started it.
  const pendingLoadKey = useJevLoadStore((s) => s.pendingLoadKey)
  const loadError = useJevLoadStore((s) => s.loadError)

  /** `announceFailure` is what makes this the loader's load: the mutation reports a refusal
   *  once, wherever the user has gone by then. A caller's own `onError` is extra behaviour on
   *  top of that, never the report itself. */
  function startLoad(target: LoadTarget, opts: LoadOptions): void {
    actions.load.mutate(
      { key: target.key, overrides: opts.overrides, announceFailure: true },
      { onError: opts.onError, onSuccess: opts.onSuccess },
    )
  }

  /** Claims the "is ready" toast for this browser; the mutation gives it back if the load
   *  fails (ADR-434 (i)(4)). */
  function startJevLoad(target: LoadTarget, opts: LoadOptions): void {
    setPendingJevKey(target.key)
    startLoad(target, opts)
  }

  async function askBeforeJevLoad(target: LoadTarget, opts: LoadOptions): Promise<void> {
    const work = await readActiveWork()
    if (work && !isBusy(work)) startJevLoad(target, opts)
    else setConfirm({ target, work, opts })
  }

  function requestLoad(target: LoadTarget, opts: LoadOptions = {}): void {
    if (target.jev) void askBeforeJevLoad(target, opts)
    else startLoad(target, opts)
  }

  return {
    requestLoad,
    // "Load anyway" answers the (i)(3) question with the very load it interrupted: same
    // pending key, same failure surface, same caller callbacks.
    confirmLoad: startJevLoad,
    isPending: pendingLoadKey !== null,
    pendingKey: pendingLoadKey ?? undefined,
    loadError,
  }
}

/** Announces a Jev load THIS browser started, once the model is really running (ADR-434 (i)(3)).
 *  It offers the playground and never goes there on its own. A swap this browser did not start
 *  — a Routine's pinned model, an API client's auto-swap — leaves `pendingJevKey` unset and so
 *  says nothing at all ((i)(4)). Mounted once, at the app level. */
export function useJevLoadedToast(): void {
  const pendingJevKey = useJevLoadStore((s) => s.pendingJevKey)
  const setPendingJevKey = useJevLoadStore((s) => s.setPendingJevKey)
  const jev = useStatus().data?.jev
  const { pathname } = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!pendingJevKey || jev?.key !== pendingJevKey || jev.state !== 'running') return
    // Clearing first is what makes this fire exactly once: the next poll finds no pending key.
    setPendingJevKey(null)
    if (pathname === JEV_PATH) return
    toast.success(`${jev.name} is ready`, {
      action: {
        label: 'Open Jev Playground',
        onClick: () => {
          track('models', 'open_jev_playground_toast')
          navigate(JEV_PATH)
        },
      },
    })
  }, [pendingJevKey, jev, setPendingJevKey, pathname, navigate])
}

/** null when the daemon could not be asked — the caller treats that as "ask the user". */
async function readActiveWork(): Promise<ActiveWork | null> {
  try {
    return await getActivity()
  } catch {
    return null
  }
}

function isBusy(work: ActiveWork): boolean {
  return work.items.length > 0 || work.engineGenerating
}
