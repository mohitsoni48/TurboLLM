// The one way the UI loads a local model (ADR-434 (i)(3), divergence row 19).
//
// A chat model loads exactly as it always has. A Jev model unloads whatever is running and
// takes Workspace over, so it asks first — but only when something really is running, the same
// "active work, not an open window" rule as the daemon-restart gate. When the daemon cannot be
// asked, it fails OPEN to the confirmation: "I couldn't check" is not "nothing is running".
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from '../components/ui/sonner'
import { useJevLoadStore, type LoadTarget } from '../stores/jev-load'
import { track } from './api'
import { getActivity } from './jev-api'
import { JEV_PATH } from './jev-mode'
import { useModelActions, useStatus } from './queries'
import type { ActiveWork, LoadProfile } from './types'

interface LoadOptions {
  overrides?: Partial<LoadProfile>
  onError?: (e: unknown) => void
  onSuccess?: () => void
}

export function useModelLoader(): {
  requestLoad(target: LoadTarget, opts?: LoadOptions): void
  isPending: boolean
  pendingKey: string | undefined
} {
  const actions = useModelActions()
  const setConfirm = useJevLoadStore((s) => s.setConfirm)
  const setPendingJevKey = useJevLoadStore((s) => s.setPendingJevKey)

  function startLoad(target: LoadTarget, opts: LoadOptions): void {
    actions.load.mutate({ key: target.key, overrides: opts.overrides }, { onError: opts.onError, onSuccess: opts.onSuccess })
  }

  /** Claims the toast for this browser first, and gives it back if the load fails. */
  function startJevLoad(target: LoadTarget, opts: LoadOptions): void {
    setPendingJevKey(target.key)
    actions.load.mutate({ key: target.key, overrides: opts.overrides }, {
      onError: (e) => {
        setPendingJevKey(null)
        opts.onError?.(e)
      },
      onSuccess: opts.onSuccess,
    })
  }

  async function askBeforeJevLoad(target: LoadTarget, opts: LoadOptions): Promise<void> {
    const work = await readActiveWork()
    if (work && !isBusy(work)) startJevLoad(target, opts)
    else setConfirm({ target, work, overrides: opts.overrides })
  }

  function requestLoad(target: LoadTarget, opts: LoadOptions = {}): void {
    if (target.isJev) void askBeforeJevLoad(target, opts)
    else startLoad(target, opts)
  }

  return {
    requestLoad,
    isPending: actions.load.isPending,
    pendingKey: actions.load.isPending ? actions.load.variables?.key : undefined,
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
