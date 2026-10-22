// The one way the UI loads a local model (ADR-434 (i)(3)).
//
// A chat model loads exactly as it always has. A Jev text classification model loads into the primary
// on the selected engine (vLLM, or any engine once every model is shown), unloads whatever is running
// and takes Workspace over, so it asks first — but only when something really is running, the same
// "active work, not an open window" rule as the daemon-restart gate.
// When the daemon cannot be asked, it fails OPEN to the confirmation: "I couldn't check" is not
// "nothing is running".
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from '../components/ui/sonner'
import { useJevLoadStore, type LoadOptions, type LoadTarget } from '../stores/jev-load'
import { track } from './api'
import { getActivity } from './jev-api'
import { TEXT_CLASSIFICATION_PATH } from './jev-mode'
import { textClassificationRuntime } from './model-kind'
import { useModelActions, useStatus } from './queries'
import { loadedSystemOneModel } from './systemone-model'
import type { ActiveWork, Status, TextClassificationStatus } from './types'

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
    const runtime = textClassificationRuntime(target)
    if (runtime === 'vllm') void askBeforeJevLoad(target, opts)
    // The Laya engine runs in its own slot beside whatever is loaded, so there is nothing to ask about; the load
    // still claims the "is ready" toast, which is how the user finds the playground (ADR-443).
    else if (runtime === 'laya') startJevLoad(target, opts)
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
  const pending = aliveTextClassifier(status, pendingJevKey)
  const playgroundKey = loadedSystemOneModel(status, undefined)?.key
  const { pathname } = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (pending?.state !== 'running') return
    // Clearing first is what makes this fire exactly once: the next poll finds no pending key.
    setPendingJevKey(null)
    if (pathname === TEXT_CLASSIFICATION_PATH) return
    const ready = `${pending.name} is ready`
    // A Laya model loaded beside a Jev model is not what the playground shows, so it is not offered there.
    if (pending.key !== playgroundKey) {
      toast.success(ready)
      return
    }
    toast.success(ready, {
      action: {
        label: 'Open playground',
        onClick: () => {
          track('models', 'open_jev_playground_toast')
          navigate(TEXT_CLASSIFICATION_PATH)
        },
      },
    })
  }, [pending, playgroundKey, setPendingJevKey, pathname, navigate])
}

/** The alive text classification model with this key. The one status field names only the model that owns the
 *  Workspace when a Jev and a Laya model are both alive (ADR-444), so a Laya load beside a Jev model is found in
 *  the per-runtime fields. */
function aliveTextClassifier(status: Status | undefined, key: string | null): AliveClassifier | undefined {
  if (!status || !key) return undefined
  return [status.textClassification, status.jev, status.laya].find((model) => model?.key === key) ?? undefined
}

/** What the toast reads of an alive text classification model, whichever status field named it. */
type AliveClassifier = Pick<TextClassificationStatus, 'key' | 'name' | 'state'>

/** null when the daemon could not be asked — the caller treats that as "ask the user". */
async function readActiveWork(): Promise<ActiveWork | null> {
  try {
    return await getActivity()
  } catch {
    return null
  }
}

/** Anything a load would interrupt: work in progress, a reply parked on an approval (the load
 *  denies its call), or an API client's generation. */
function isBusy(work: ActiveWork): boolean {
  return work.items.length > 0 || (work.waiting ?? []).length > 0 || work.engineGenerating
}
