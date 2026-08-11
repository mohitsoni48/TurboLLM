// Typed API client for the onboarding feature (spec 25 §9.2) — mirrors
// routine-api.ts's convention (a local req() helper reusing api.ts's
// authHeaders/ApiError) against turbollm/src/api/onboarding-routes.ts.
//
// The server persists only {status, profile} — everything else the wizard
// needs (download/provision/load state) already has a route elsewhere. The
// recommendation is computed server-side against the daemon's own detected
// hardware (spec 25 §5.2) so the client never needs a copy of `recommend()`,
// `BLESSED`, or a way to learn total system RAM.
import { ApiError, authHeaders } from './api'

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

export type OnboardingStatus = 'pending' | 'completed' | 'skipped'
export type OnboardingProfileId = 'casual' | 'developer' | 'enthusiast' | 'pro'

export interface OnboardingStateDto {
  status: OnboardingStatus
  profile: OnboardingProfileId | null
  completedAt: number | null
  schemaVersion: number
  everLoadedModel: boolean
}

export interface OnboardingPatch {
  status?: OnboardingStatus
  profile?: OnboardingProfileId
}

export function getOnboardingState(): Promise<OnboardingStateDto> {
  return req('/api/v1/onboarding')
}

export function putOnboardingState(patch: OnboardingPatch): Promise<OnboardingStateDto> {
  return req('/api/v1/onboarding', { method: 'PUT', json: patch })
}

export interface BlessedEntryDto {
  id: string
  role: 'general' | 'coder'
  repo: string
  file: string
  bytes: number
}

export type OnboardingRecommendation =
  | { kind: 'entry'; entry: BlessedEntryDto; speculative: 'off' }
  | { kind: 'discover'; reason: 'pro' }
  | { kind: 'hf-search'; reason: 'no-fit' }

export interface OnboardingRecommendationResponse {
  recommendation: OnboardingRecommendation
  isT0: boolean
}

export function getOnboardingRecommendation(profile: OnboardingProfileId): Promise<OnboardingRecommendationResponse> {
  return req(`/api/v1/onboarding/recommendation?profile=${encodeURIComponent(profile)}`)
}
