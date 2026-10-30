import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { OnboardingMachineProvider, useOnboardingMachine } from './useOnboardingMachine'

const mutateAsync = vi.fn()
vi.mock('../onboarding-queries', () => ({
  useOnboardingState: () => ({ isSuccess: true, data: { status: 'pending', profile: null } }),
  useSetOnboardingState: () => ({ mutate: vi.fn(), mutateAsync }),
}))

const wrapper = ({ children }: { children: ReactNode }) => <OnboardingMachineProvider>{children}</OnboardingMachineProvider>

describe('useOnboardingMachine — skip', () => {
  it('stays on the current step when persisting the skip fails (no blank, control-less page)', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('Daemon restarting.'))
    const { result } = renderHook(() => useOnboardingMachine(), { wrapper })
    const before = result.current.currentStep
    expect(before).not.toBeNull()
    await act(async () => { await expect(result.current.skip()).rejects.toThrow('Daemon restarting.') })
    expect(result.current.currentStep?.id).toBe(before!.id)
  })

  it('leaves the steps once the skip is recorded', async () => {
    mutateAsync.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useOnboardingMachine(), { wrapper })
    await act(async () => { await result.current.skip() })
    expect(mutateAsync).toHaveBeenLastCalledWith({ status: 'skipped' })
    expect(result.current.currentStep).toBeNull()
  })
})

// The download the Load step follows is kept with the step across a closed tab: without it the
// reopened step matched any row ("Download complete" from an older one while this one was still
// downloading).
describe('useOnboardingMachine — the followed download survives a reopen', () => {
  it('restores the id a "Download this" stamped, and forgets it once onboarding is left', async () => {
    localStorage.removeItem('tllm.onboarding.expectedDownloadId')
    const first = renderHook(() => useOnboardingMachine(), { wrapper })
    act(() => first.result.current.patchCtx({ expectedDownloadId: 'dl-42' }))
    expect(localStorage.getItem('tllm.onboarding.expectedDownloadId')).toBe('dl-42')
    first.unmount()

    const reopened = renderHook(() => useOnboardingMachine(), { wrapper })
    expect(reopened.result.current.ctx.expectedDownloadId).toBe('dl-42')

    mutateAsync.mockResolvedValueOnce(undefined)
    await act(async () => { await reopened.result.current.skip() })
    expect(localStorage.getItem('tllm.onboarding.expectedDownloadId')).toBeNull()
  })

  it('forgets it when the user picks a model already on disk instead (the id is set to null)', () => {
    localStorage.setItem('tllm.onboarding.expectedDownloadId', 'dl-42')
    const { result } = renderHook(() => useOnboardingMachine(), { wrapper })
    act(() => result.current.patchCtx({ expectedDownloadId: null }))
    expect(localStorage.getItem('tllm.onboarding.expectedDownloadId')).toBeNull()
  })
})
