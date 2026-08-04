// Typed API client for the Routine feature — mirrors code-api.ts's conventions (a local req()
// helper reusing api.ts's authHeaders/ApiError) against turbollm/src/routines/routine-routes.ts.
//
// Deliberately does NOT wire auth-signal.ts's markCodeAuthNeeded/clearCodeAuthNeeded the way
// code-api.ts's req() does. `/api/v1/code/*` is uniformly behind codeAuth, so a 401 there always
// means "Code needs a key"; `/api/v1/routines*` is mixed — only code-FLAVOR requests carry
// routine-routes.ts's `codeGateBlocks` gate, and the GETs plus every chat-flavor call stay on the
// baseline lanAuth gate. Marking on any 401 would be roughly right, but clearing on any 2xx (which
// the code-api pairing requires) would let a successful chat-routine poll silently dismiss a
// genuine Code auth prompt. Left out as a deliberate, documented judgment call.
//
// Consequence: a code-flavor 401 raises no AuthGate. Tasks 5/9/10 MUST catch
// `ApiError.status === 401` on create/update/confirm/pause/resume/run-now/approve/deny and toast
// `error.message` (the server sends `CODE_GATE_MESSAGE`), which is the only auth feedback this
// surface will have. Each of those eight functions repeats the 401 in its own JSDoc below.
import { ApiError, authHeaders } from './api'
import type { Routine, RoutineInput, RoutineRun } from './routine-types'

/** Every routine write (create / update / confirm / delete / pause / resume / run-now /
 *  approve / deny) can answer 401 for a code-flavor routine from a non-host device — this
 *  module's header comment names catching that status and toasting it as the UI's obligation,
 *  because the deliberate decision not to wire auth-signal.ts means no AuthGate ever appears:
 *  that toast is the ONLY auth feedback the user gets. Labelled explicitly rather than folded
 *  into the generic message so it reads as an authorization problem, not a transient failure
 *  the user should just retry.
 *
 *  Lives here rather than in the one component that first needed it because the `remove`
 *  mutation in routine-queries.ts toasts at the mutation level (see the comment there) and
 *  must produce the identical wording. */
export function describeRoutineError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return `Not authorized: ${e.message}`
    return e.message
  }
  return fallback
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(), ...((init?.headers as Record<string, string>) ?? {}) }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json) }
  const res = await fetch(path, { ...init, headers, body })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined
  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(env?.error?.code ?? 'http_error', env?.error?.message ?? `Request failed with status ${res.status}.`, res.status)
  }
  return data as T
}

export function listRoutines(): Promise<Routine[]> {
  return req('/api/v1/routines')
}
export function getRoutine(id: string): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}`)
}
/** 201 with the created routine, always in status 'pending_confirmation'. Throws ApiError
 *  'invalid_routine' (400) on a validation failure, or 'unauthorized' (401) for a code-flavor
 *  routine authored from a non-host device without a key (routine-routes.ts's code gate). */
export function createRoutine(input: RoutineInput): Promise<Routine> {
  return req('/api/v1/routines', { method: 'POST', json: input })
}
/** PUT cannot change `flavor`; every other RoutineInput field is patchable. Returns the updated
 *  routine (the route recomputes nextFireAt itself when an active routine's schedule changes).
 *  Throws ApiError 'unauthorized' (401) for a code-flavor routine from a non-host device without
 *  a key (routine-routes.ts's codeGateBlocks). */
export function updateRoutine(id: string, patch: Partial<RoutineInput>): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}`, { method: 'PUT', json: patch })
}
export function deleteRoutine(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
/** The one door into 'active'. Throws ApiError 'not_pending' (409) if the routine was already
 *  confirmed, or 'unauthorized' (401) for a code-flavor routine from a non-host device without
 *  a key (routine-routes.ts's codeGateBlocks). */
export function confirmRoutine(id: string): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/confirm`, { method: 'PUT' })
}
/** Throws ApiError 'not_active' (409) when the routine isn't currently active, or 'unauthorized'
 *  (401) for a code-flavor routine from a non-host device without a key (routine-routes.ts's
 *  codeGateBlocks). */
export function pauseRoutine(id: string): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/pause`, { method: 'PUT' })
}
/** Throws ApiError 'not_paused' (409) when the routine isn't currently paused, or 'unauthorized'
 *  (401) for a code-flavor routine from a non-host device without a key (routine-routes.ts's
 *  codeGateBlocks). */
export function resumeRoutine(id: string): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/resume`, { method: 'PUT' })
}
/** Newest run first — routine-routes.ts serves `db.listRoutineRuns`, which is
 *  `ORDER BY started_at DESC` (chat/db.ts). Callers may take index 0 as "the latest run". */
export function listRoutineRuns(routineId: string): Promise<RoutineRun[]> {
  return req(`/api/v1/routines/${encodeURIComponent(routineId)}/runs`)
}
/** Manually fires a routine outside its schedule.
 *
 *  DRIFT FROM PLAN (verified against the shipped route): this returns `{ ok: true }` with HTTP
 *  202, NOT the created run — the route hands off to `RoutineScheduler.runNow`, which dispatches
 *  asynchronously and has no run row to return yet. Callers that want the run must refetch
 *  {@link listRoutineRuns}. Throws ApiError 'scheduler_unavailable' (503), 'not_found' (404),
 *  'not_confirmed' (409), 'already_running' (409), or 'unauthorized' (401) for a code-flavor
 *  routine from a non-host device without a key (routine-routes.ts's codeGateBlocks). */
export function runRoutineNow(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/run-now`, { method: 'POST' })
}
/** Resumes a run stalled at 'needs_approval' by ALLOWING its blocked tool call.
 *
 *  DRIFT FROM PLAN (verified against the shipped route): returns `{ ok: true }`, not the run —
 *  the route awaits `resumeRoutineRun`, which dispatches a continuation whose outcome isn't known
 *  when the response is written. Refetch {@link listRoutineRuns} for the new state. Throws
 *  ApiError 'not_found' (404), 'internal_error' (500), a 409 carrying resumeRoutineRun's own
 *  code ('not_stalled' / 'gate_timeout' / 'model_busy' / 'model_unavailable' /
 *  'corrupt_pending_call'), or 'unauthorized' (401) for a code-flavor routine from a non-host
 *  device without a key (routine-routes.ts's codeGateBlocks). */
export function approveRoutineRun(routineId: string, runId: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/approve`, { method: 'POST' })
}
/** DENIES a stalled run's blocked tool call. Same response shape and failure codes as
 *  {@link approveRoutineRun}, including 'unauthorized' (401) for a code-flavor routine from a
 *  non-host device without a key (routine-routes.ts's codeGateBlocks). */
export function denyRoutineRun(routineId: string, runId: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/deny`, { method: 'POST' })
}
