import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { LoadFailureRecovery } from './LoadFailureRecovery'
import { LOAD_FAILURES } from '../screens/onboarding/recovery'
import type { LoadFailure } from '../lib/types'

const trackRecovery = vi.fn()
const navigate = vi.fn()

vi.mock('../lib/api', () => ({
  trackRecovery: (...args: unknown[]) => trackRecovery(...args),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

beforeEach(() => {
  trackRecovery.mockClear()
  navigate.mockClear()
})

function renderFor(failure: LoadFailure, props: Partial<Parameters<typeof LoadFailureRecovery>[0]> = {}) {
  return render(
    <MemoryRouter>
      <LoadFailureRecovery failure={failure} {...props} />
    </MemoryRouter>,
  )
}

describe('LoadFailureRecovery', () => {
  // ADR-338 Decision 4's invariant, enforced at the UI layer rather than only in the map.
  it.each(LOAD_FAILURES)('renders at least one action for %s — no dead ends', (failure) => {
    renderFor(failure)
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
  })

  it('reports the snake_case telemetry id, not the kebab-case UI id', async () => {
    renderFor('oom')
    await userEvent.click(screen.getByRole('button', { name: 'Choose a smaller quant' }))
    expect(trackRecovery).toHaveBeenCalledWith('oom', 'lower_quant_retry', 'ok')
  })

  it('reports outcome "ok" when a retry succeeds', async () => {
    renderFor('timeout', { onRetry: async () => true })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(trackRecovery).toHaveBeenCalledWith('timeout', 'retry', 'ok')
  })

  // The whole point of the event is `outcome`; a retry that silently reported 'ok'
  // regardless would make the recovery half look like it worked when it did not.
  it('reports outcome "fail" when a retry fails', async () => {
    renderFor('timeout', { onRetry: async () => false })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(trackRecovery).toHaveBeenCalledWith('timeout', 'retry', 'fail')
  })

  it('reports "fail" when there is nothing to retry, rather than a false success', async () => {
    renderFor('timeout')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(trackRecovery).toHaveBeenCalledWith('timeout', 'retry', 'fail')
  })

  it('a thrown retry is reported as a failure, not an unhandled error', async () => {
    renderFor('timeout', { onRetry: async () => { throw new Error('boom') } })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(trackRecovery).toHaveBeenCalledWith('timeout', 'retry', 'fail')
  })

  it('hands off to Engines when there is no engine to load with', async () => {
    renderFor('no_engine')
    await userEvent.click(screen.getByRole('button', { name: 'Set up an engine' }))
    expect(navigate).toHaveBeenCalledWith('/engines')
    expect(trackRecovery).toHaveBeenCalledWith('no_engine', 'back_to_engine', 'ok')
  })

  // 'lower-quant-retry' and 'redownload' deliberately navigate rather than re-running the
  // same load: neither is a reload of the same config, and firing onRetry would make the
  // button lie about what it did.
  it('does not silently re-run the same load for quant/re-download remedies', async () => {
    const onRetry = vi.fn(async () => true)
    renderFor('bad_gguf', { onRetry })
    await userEvent.click(screen.getByRole('button', { name: 'Re-download the model' }))
    expect(onRetry).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/models')
  })

  it('an unclassified failure still offers the launch command — the last-resort next action', () => {
    const onShowLaunchCommand = vi.fn()
    renderFor('other', { launchCommand: 'llama-server --model foo.gguf', onShowLaunchCommand })
    expect(screen.getByRole('button', { name: 'Show launch command and diagnostics' })).toBeTruthy()
  })
})
