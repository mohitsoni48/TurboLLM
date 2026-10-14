import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ProfileExtraStep from './ProfileExtraStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'

vi.mock('../../../lib/queries', () => ({
  useEngines: () => ({ data: { engines: [], activeEngineId: null } }),
}))
vi.mock('../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api')>()),
  track: vi.fn(),
  activateEngine: vi.fn(),
}))

const developerCtx: OnboardingCtx = {
  profile: 'developer',
  downloadDone: false,
  isT0: false,
  recommendationKind: 'entry',
  expectedModelKey: null,
  expectedDownloadId: null,
  loadCompletedOnce: false,
}

describe('ProfileExtraStep endpoint copy', () => {
  it('copies the endpoint over plain http, where navigator.clipboard is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    render(<ProfileExtraStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={developerCtx} />)

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})

describe('ProfileExtraStep endpoint', () => {
  it('shows the endpoint on the origin actually serving the UI, not a hard-coded :6996', () => {
    // The Android app serves on --port 7000; desktop users can move the port too.
    render(<ProfileExtraStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={developerCtx} />)
    expect(screen.getByText(`${window.location.origin}/v1`)).toBeInTheDocument()
    expect(screen.queryByText(/:6996\/v1/)).not.toBeInTheDocument()
  })
})
