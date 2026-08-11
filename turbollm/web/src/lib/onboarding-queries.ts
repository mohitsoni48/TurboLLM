import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getOnboardingRecommendation, getOnboardingState, putOnboardingState,
  type OnboardingPatch, type OnboardingProfileId,
} from './onboarding-api'

export const onboardingKeys = {
  state: ['onboarding'] as const,
  recommendation: (profile: OnboardingProfileId) => ['onboarding-recommendation', profile] as const,
}

/** No polling — onboarding status changes only in response to this tab's own
 *  actions, never in the background. */
export function useOnboardingState() {
  return useQuery({ queryKey: onboardingKeys.state, queryFn: getOnboardingState, retry: false })
}

export function useSetOnboardingState() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: OnboardingPatch) => putOnboardingState(patch),
    onSuccess: (next) => qc.setQueryData(onboardingKeys.state, next),
  })
}

/** Hardware is stable for the process lifetime, so a long staleTime is fine —
 *  matches useEngineRecommendation's reasoning for the same signal. Disabled
 *  until a profile is chosen (Pro never needs this call — recommend() returns
 *  `discover` for Pro server-side, but skipping the request entirely for Pro
 *  avoids a pointless round trip). */
export function useOnboardingRecommendation(profile: OnboardingProfileId | null) {
  return useQuery({
    queryKey: onboardingKeys.recommendation(profile ?? 'casual'),
    queryFn: () => getOnboardingRecommendation(profile!),
    enabled: profile !== null && profile !== 'pro',
    staleTime: 60_000,
    retry: false,
  })
}
