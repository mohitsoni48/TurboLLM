import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { EngineLoadErrorBanner } from './EngineLoadErrorBanner'
import type { EngineError, Status } from '../lib/types'

function statusWith(state: Status['engine']['state'], error?: EngineError): Status {
  return {
    engine: { id: 'e1', name: 'llama.cpp', state, error },
  } as unknown as Status
}

function renderBanner(status: Status | undefined, path = '/workspace') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <EngineLoadErrorBanner status={status} />
    </MemoryRouter>,
  )
}

const readinessTimeout: EngineError = {
  code: 'readiness_timeout',
  message: 'The model did not become ready within 120 seconds.',
  exitCode: -1,
  logTail: ['loading tensors...'],
}

const engineExited: EngineError = {
  code: 'engine_exited',
  message: 'The engine process exited unexpectedly.',
  exitCode: 1,
  logTail: ['segfault'],
}

describe('EngineLoadErrorBanner', () => {
  it('renders nothing when the engine is not in error', () => {
    renderBanner(statusWith('starting'))
    expect(screen.queryByText(/Model load failed/)).toBeNull()
  })

  it('shows the error message and log tail when the engine errors', () => {
    renderBanner(statusWith('error', readinessTimeout))
    expect(screen.getByText(/did not become ready within 120 seconds/)).toBeTruthy()
    expect(screen.getByText(/loading tensors/)).toBeTruthy()
  })

  it('hides after Dismiss is clicked', async () => {
    renderBanner(statusWith('error', readinessTimeout))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Model load failed/)).toBeNull()
  })

  it('re-shows for a NEW, different error even with no intermediate non-error tick — the bug found in the Opus release review, where dismissal was keyed on a state transition that polling could miss entirely', async () => {
    const { rerender } = renderBanner(statusWith('error', readinessTimeout))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Model load failed/)).toBeNull()

    // State never leaves 'error' between polls (plausible: two failures within one
    // polling interval) — only the error CONTENT changes.
    rerender(
      <MemoryRouter initialEntries={['/workspace']}>
        <EngineLoadErrorBanner status={statusWith('error', engineExited)} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/engine process exited unexpectedly/)).toBeTruthy()
  })

  it('hides the "Open Engines" button on /engines but still shows the error text', () => {
    renderBanner(statusWith('error', readinessTimeout), '/engines')
    expect(screen.getByText(/Model load failed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Engines' })).toBeNull()
  })
})
