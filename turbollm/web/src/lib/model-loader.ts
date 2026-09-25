// The one way the UI loads a local model (ADR-434 (i)(3)).
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
  isPending: boolean
  pendingKey: string | undefined
  loadError: { key: string; message: string } | null
} {
  const { startLoad, startJevLoad } = useLoadStarters()
  const setConfirm = useJevLoadStore((s) => s.setConfirm)
  // The load itself, not this hook's own mutation observer — a surface must report the load
  // that is really running, whichever surface started it.
  const pendingLoadKey = useJevLoadStore((s) => s.pendingLoadKey)
  const loadError = useJevLoadStore((s) => s.loadError)

  async function askBeforeJevLoad(target: LoadTarget, opts: LoadOptions): Promise<void> {
    const work = await readActiveWork()
    if (work && !isBusy(work)) {
      startJevLoad(target, opts)
      return
    }
    // A question already on screen is the one the user is answering. Rewriting it would swap
    // the model under a click already on its way to "Load anyway", and drop the callbacks the
    // first caller is waiting on. The request is ignored: nothing was claimed, so nothing is
    // left behind, and the row can be clicked again once the dialog is gone.
    if (useJevLoadStore.getState().confirm) return
    setConfirm({ target, work, opts })
  }

  function requestLoad(target: LoadTarget, opts: LoadOptions = {}): void {
    if (target.jev) void askBeforeJevLoad(target, opts)
    // A Laya model runs in its own slot beside whatever is loaded, so there is nothing to ask about; it still
    // claims the "is ready" toast, which is how the user finds the playground (ADR-443).
    else if (target.laya) startJevLoad(target, opts)
    else startLoad(target, opts)
  }

  return {
    requestLoad,
    isPending: pendingLoadKey !== null,
    pendingKey: pendingLoadKey ?? undefined,
    loadError,
  }
}

/** "Load anyway" answers the confirmation with the very load it interrupted: same pending
 *  key, same failure report, same caller callbacks. Narrower than `useModelLoader` on purpose
 *  — the confirmation host is mounted for the life of the app and shows no load state, so it
 *  must not re-render on every transition of every load. */
export function useConfirmedLoad(): (target: LoadTarget, opts: LoadOptions) => void {
  return useLoadStarters().startJevLoad
}

/** The two ways to start a load the mutation itself reports. */
function useLoadStarters(): {
  startLoad(target: LoadTarget, opts: LoadOptions): void
  startJevLoad(target: LoadTarget, opts: LoadOptions): void
} {
  const actions = useModelActions()
  const setPendingJevKey = useJevLoadStore((s) => s.setPendingJevKey)

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

  return { startLoad, startJevLoad }
}

/** Announces a Jev load THIS browser started, once the model is really running (ADR-434 (i)(3)).
 *  It offers the playground and never goes there on its own. A swap this browser did not start
 *  — a Routine's pinned model, an API client's auto-swap — leaves `pendingJevKey` unset and so
 *  says nothing at all (ADR-434 (i)(4)). Mounted once, at the app level. */
export function useJevLoadedToast(): void {
  const pendingJevKey = useJevLoadStore((s) => s.pendingJevKey)
  const setPendingJevKey = useJevLoadStore((s) => s.setPendingJevKey)
  const status = useStatus().data
  const jev = status?.jev ?? status?.laya
  const { pathname } = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!pendingJevKey || jev?.key !== pendingJevKey || jev.state !== 'running') return
    // Clearing first is what makes this fire exactly once: the next poll finds no pending key.
    setPendingJevKey(null)
    if (pathname === JEV_PATH) return
    toast.success(`${jev.name} is ready`, {
      action: {
        // A Laya model is not a Jev model, and the playground it opens is the same one (ADR-443).
        label: status?.jev ? 'Open Jev Playground' : 'Open playground',
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
