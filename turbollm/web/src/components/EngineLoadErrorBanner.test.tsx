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

  // The banner said "Model load failed: <message>", naming neither the engine nor the model, and offered remedies
  // that suit a model the engine runs, also for one it cannot: a model "Show models for every engine" lists loads only
  // on the selected engine. Nothing may suggest another engine.
  describe('a failed load the daemon names', () => {
    const archFailure: EngineError = {
      code: 'engine_exited',
      message: "unknown model architecture: 'qwen3next'",
      exitCode: 1,
      logTail: [],
      failReason: 'unsupported_arch',
      engineName: 'llama.cpp (b6000)',
      modelName: 'Qwen3 Next 80B',
      expectedToLoad: true,
    }

    it('names the engine and the model', () => {
      renderBanner(statusWith('error', archFailure))
      expect(screen.getByText("llama.cpp (b6000) could not load Qwen3 Next 80B: unknown model architecture: 'qwen3next' (exit 1)")).toBeTruthy()
      expect(screen.queryByText(/Model load failed/)).toBeNull()
    })

    it('offers no other engine for an unknown architecture', () => {
      renderBanner(statusWith('error', archFailure))
      expect(screen.queryByRole('button', { name: 'Try an engine that supports it' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Choose a different model' })).toBeTruthy()
    })

    it('offers no engine advice and no re-download for a model the engine is not expected to load', () => {
      renderBanner(statusWith('error', {
        ...archFailure,
        message: "gguf_init_from_file_impl: invalid magic characters: 'LITE', expected 'GGUF'",
        failReason: 'bad_gguf',
        modelName: 'Gemma 3n',
        expectedToLoad: false,
      }))
      const buttons = screen.getAllByRole('button').map((b) => b.textContent)
      expect(buttons).not.toContain('Re-download the model')
      expect(buttons).not.toContain('Check for an engine update')
      expect(buttons).toContain('Choose a different model')
      expect(screen.getByText("The selected engine isn't expected to load this model.")).toBeTruthy()
    })
  })
})
