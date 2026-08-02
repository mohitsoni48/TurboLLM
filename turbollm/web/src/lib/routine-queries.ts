import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '../components/ui/sonner'
import {
  approveRoutineRun, confirmRoutine, createRoutine, deleteRoutine, denyRoutineRun,
  describeRoutineError, getRoutine, listRoutineRuns, listRoutines, pauseRoutine, resumeRoutine,
  runRoutineNow, updateRoutine,
} from './routine-api'
import type { Routine, RoutineInput, RoutineRun } from './routine-types'

export const routineKeys = {
  list: ['routines'] as const,
  detail: (id: string) => ['routine', id] as const,
  runs: (id: string) => ['routine-runs', id] as const,
}

export function useRoutines() {
  return useQuery({ queryKey: routineKeys.list, queryFn: listRoutines, refetchInterval: 15000, refetchIntervalInBackground: false })
}

export function useRoutine(id: string | undefined) {
  return useQuery({ queryKey: routineKeys.detail(id ?? ''), queryFn: () => getRoutine(id!), enabled: !!id })
}

export function useRoutineRuns(routineId: string | undefined) {
  return useQuery({
    queryKey: routineKeys.runs(routineId ?? ''),
    queryFn: () => listRoutineRuns(routineId!),
    enabled: !!routineId,
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  })
}

export interface RoutineWithLatestRun {
  routine: Routine
  latestRun: RoutineRun | null
}

/** One routine + its most recent run, for the list screen's last-run summary column and the
 *  nav badge's needs-approval count (Shell.tsx). SPEC-GAP (00-conventions.md §8): the backend
 *  has no aggregate "routines with their latest run" endpoint, so this fetches every routine's
 *  run history (routine-routes.ts serves db.listRoutineRuns, `ORDER BY started_at DESC`, so
 *  index 0 really is the newest) — an N+1 query pattern, acceptable at the expected routine
 *  count (dozens, not thousands). Worth a real backend aggregate endpoint later; not built here
 *  since scope forbids adding backend code. */
export function useRoutinesWithLatestRun() {
  const routinesQ = useRoutines()
  const routines = routinesQ.data ?? []
  const runsQ = useQueries({
    queries: routines.map((r) => ({
      queryKey: routineKeys.runs(r.id),
      queryFn: () => listRoutineRuns(r.id),
      enabled: routinesQ.isSuccess,
      refetchInterval: 15000,
      refetchIntervalInBackground: false,
    })),
  })
  const items: RoutineWithLatestRun[] = routines.map((routine, i) => ({
    routine,
    latestRun: runsQ[i]?.data?.[0] ?? null,
  }))
  return {
    items,
    isLoading: routinesQ.isLoading || (routines.length > 0 && runsQ.some((q) => q.isLoading)),
    isError: routinesQ.isError || runsQ.some((q) => q.isError),
    refetch: () => { void routinesQ.refetch(); runsQ.forEach((q) => void q.refetch()) },
  }
}

/** Every routine write, bundled. Deviates from code-queries.ts's one-exported-hook-per-mutation
 *  shape on purpose: the routine surfaces that mutate (the confirm card, the detail page's
 *  pause/resume/run-now/delete row, the approval card) each need several of these at once, and
 *  the plan's Task 2 interface contract names this single hook. Cache invalidation follows
 *  code-queries.ts exactly — invalidate the list plus whichever detail/runs key the write
 *  actually touched. */
export function useRoutineMutations() {
  const qc = useQueryClient()
  const refreshList = () => void qc.invalidateQueries({ queryKey: routineKeys.list })
  return {
    create: useMutation({ mutationFn: (input: RoutineInput) => createRoutine(input), onSuccess: refreshList }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<RoutineInput> }) => updateRoutine(v.id, v.patch),
      onSuccess: (_r, v) => { refreshList(); void qc.invalidateQueries({ queryKey: routineKeys.detail(v.id) }) },
    }),
    /** The failure toast lives on the MUTATION DEFINITION, not on the caller's `mutate(..., {
     *  onError })` options, and that placement is load-bearing. RoutineConfirmCard's Cancel fires
     *  this DELETE and then synchronously calls `props.onCancelled()`; a consumer that reacts by
     *  unmounting the card (a transcript card being replaced, a wizard step advancing) destroys
     *  the MutationObserver before the request settles, and TanStack Query v5 skips per-`mutate`
     *  callbacks once an observer has no listeners (`MutationObserver` guards its `mutateOptions`
     *  dispatch on `hasListeners()`). `Mutation#execute` invokes THESE callbacks directly, with no
     *  listener check, so they fire whether or not the card survived.
     *
     *  That matters precisely here: a failed discard leaves the routine sitting in the database as
     *  an orphaned `pending_confirmation` row, and a 401 on this path is the only auth feedback
     *  this feature ever produces (routine-api.ts's header comment). Callers must NOT add their
     *  own `onError` toast on top — TanStack Query runs both levels, which would double-toast. */
    remove: useMutation({
      mutationFn: (id: string) => deleteRoutine(id),
      onSuccess: refreshList,
      onError: (e) => toast.error(describeRoutineError(e, 'Could not delete this routine.')),
    }),
    confirm: useMutation({
      mutationFn: (id: string) => confirmRoutine(id),
      onSuccess: (_r, id) => { refreshList(); void qc.invalidateQueries({ queryKey: routineKeys.detail(id) }) },
    }),
    pause: useMutation({
      mutationFn: (id: string) => pauseRoutine(id),
      onSuccess: (_r, id) => { refreshList(); void qc.invalidateQueries({ queryKey: routineKeys.detail(id) }) },
    }),
    resume: useMutation({
      mutationFn: (id: string) => resumeRoutine(id),
      onSuccess: (_r, id) => { refreshList(); void qc.invalidateQueries({ queryKey: routineKeys.detail(id) }) },
    }),
    /** run-now answers 202 `{ ok: true }` BEFORE the run exists (routine-api.ts) — the runs
     *  invalidation here is what surfaces it, backed by useRoutineRuns' own 10s poll. */
    runNow: useMutation({
      mutationFn: (id: string) => runRoutineNow(id),
      onSuccess: (_r, id) => void qc.invalidateQueries({ queryKey: routineKeys.runs(id) }),
    }),
    /** Approve/deny likewise answer `{ ok: true }` while the resumed continuation is still in
     *  flight, so the invalidated runs query (plus its poll) is the only source of the outcome. */
    approve: useMutation({
      mutationFn: (v: { routineId: string; runId: string }) => approveRoutineRun(v.routineId, v.runId),
      onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: routineKeys.runs(v.routineId) }),
    }),
    deny: useMutation({
      mutationFn: (v: { routineId: string; runId: string }) => denyRoutineRun(v.routineId, v.runId),
      onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: routineKeys.runs(v.routineId) }),
    }),
  }
}
