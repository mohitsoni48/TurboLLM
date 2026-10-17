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
