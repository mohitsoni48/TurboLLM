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
import { ApiError, authHeaders } from './api'
import type { Routine, RoutineInput, RoutineRun } from './routine-types'

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
 *  routine (the route recomputes nextFireAt itself when an active routine's schedule changes). */
export function updateRoutine(id: string, patch: Partial<RoutineInput>): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}`, { method: 'PUT', json: patch })
}
export function deleteRoutine(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
/** The one door into 'active'. Throws ApiError 'not_pending' (409) if the routine was already
 *  confirmed. */
export function confirmRoutine(id: string): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/confirm`, { method: 'PUT' })
}
/** Throws ApiError 'not_active' (409) when the routine isn't currently active. */
export function pauseRoutine(id: string): Promise<Routine> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/pause`, { method: 'PUT' })
}
/** Throws ApiError 'not_paused' (409) when the routine isn't currently paused. */
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
 *  'not_confirmed' (409), or 'already_running' (409). */
export function runRoutineNow(id: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(id)}/run-now`, { method: 'POST' })
}
/** Resumes a run stalled at 'needs_approval' by ALLOWING its blocked tool call.
 *
 *  DRIFT FROM PLAN (verified against the shipped route): returns `{ ok: true }`, not the run —
 *  the route awaits `resumeRoutineRun`, which dispatches a continuation whose outcome isn't known
 *  when the response is written. Refetch {@link listRoutineRuns} for the new state. Throws
 *  ApiError 'not_found' (404), 'internal_error' (500), or a 409 carrying resumeRoutineRun's own
 *  code ('not_stalled' / 'gate_timeout' / 'model_busy' / 'model_unavailable' /
 *  'corrupt_pending_call'). */
export function approveRoutineRun(routineId: string, runId: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/approve`, { method: 'POST' })
}
/** DENIES a stalled run's blocked tool call. Same response shape and failure codes as
 *  {@link approveRoutineRun}. */
export function denyRoutineRun(routineId: string, runId: string): Promise<{ ok: true }> {
  return req(`/api/v1/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/deny`, { method: 'POST' })
}
