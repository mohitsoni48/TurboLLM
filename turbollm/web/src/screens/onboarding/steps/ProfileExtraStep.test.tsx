import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ProfileExtraStep from './ProfileExtraStep'
import type { OnboardingCtx } from '../../../lib/onboarding/types'
import type { Engine } from '../../../lib/types'
import { activateEngine } from '../../../lib/api'

const enginesState = vi.hoisted(() => ({ engines: [] as unknown[], activeEngineId: null as string | null }))

vi.mock('../../../lib/queries', () => ({
  useEngines: () => ({ data: { engines: enginesState.engines, activeEngineId: enginesState.activeEngineId } }),
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

// QG-1 (ADR-462): the Pro engine picker listed the Android app's engines by their registered names
// ("llama-server-android"), and the SDK's two engines are told apart only by their titles.
describe('ProfileExtraStep Pro engine picker', () => {
  const row = (over: Partial<Engine> & { id: string; name: string }): Engine =>
    ({ binPath: '', version: '', capabilities: { kvTypes: [], flags: [] }, ...over })
  const sdk = (id: string, sdkId: string, name: string) =>
    row({ id, name, kind: 'turbollm-sdk', sdkEngine: { id: sdkId, kind: sdkId, formats: [], backends: ['cpu'] } })

  it('names the three Android engines by their titles, and a tap still activates that row', async () => {
    enginesState.engines = [
      sdk('lit', 'litert-lm', 'LiteRT-LM'),
      sdk('cpu', 'llama.cpp-cpu', 'llama.cpp (CPU)'),
      row({ id: 'srv', name: 'llama-server-android', kind: 'llama-server' }),
    ]
    enginesState.activeEngineId = 'lit'
    render(<ProfileExtraStep onContinue={vi.fn()} onSkip={vi.fn()} ctx={{ ...developerCtx, profile: 'pro' }} />)

    const labels = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Continue')
    expect(labels).toEqual(['LiteRT-LM', 'llama.cpp (CPU)', 'llama.cpp server (CPU)'])
    expect(screen.queryByText(/llama-server-android/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'llama.cpp server (CPU)' }))
    expect(activateEngine).toHaveBeenCalledWith('srv')
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
