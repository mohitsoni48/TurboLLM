// The Laya engine (ADR-044-style pip provision) shows through this same banner while it
// installs — mirrors the 'rapid-mlx' case, which already has its own friendly label here.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { EngineProvisionBanner } from './EngineProvisionBanner'
import type { Status } from '../lib/types'

vi.mock('../lib/queries', () => ({
  useBackendInstall: () => ({ cancel: { mutate: vi.fn(), isPending: false } }),
}))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  track: vi.fn(),
}))

function statusWith(backend: string, phase: 'downloading' | 'extracting' = 'downloading'): Status {
  return {
    engineProvision: { active: true, phase, backend, pct: 0.5, error: null },
  } as unknown as Status
}

describe('EngineProvisionBanner — Laya', () => {
  it('labels a Laya install "Laya engine", same as the rapid-mlx case', () => {
    render(<EngineProvisionBanner status={statusWith('laya')} />)
    expect(screen.getByText('Downloading Laya engine…')).toBeTruthy()
  })

  it('labels a Laya extract phase the same way', () => {
    render(<EngineProvisionBanner status={statusWith('laya', 'extracting')} />)
    expect(screen.getByText('Installing Laya engine…')).toBeTruthy()
  })
})

describe('EngineProvisionBanner — a dismissed failure', () => {
  const failed = (backend: string, error: string) =>
    ({ engineProvision: { active: false, phase: 'error', backend, pct: 0, error } }) as unknown as Status

  it('stays dismissed, but a later, different failure still shows', async () => {
    const view = render(<EngineProvisionBanner status={failed('vllm', 'Could not install vLLM: pip failed')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    view.rerender(<EngineProvisionBanner status={failed('vllm', 'Could not install vLLM: pip failed')} />)
    expect(screen.queryByText(/pip failed/)).toBeNull()

    view.rerender(<EngineProvisionBanner status={statusWith('mlx')} />)
    view.rerender(<EngineProvisionBanner status={failed('mlx', 'Could not install MLX: boom')} />)
    expect(screen.getByText('Could not install MLX: boom')).toBeTruthy()
  })

  it('shows again when a retry fails the same way', async () => {
    const view = render(<EngineProvisionBanner status={failed('vllm', 'Could not install vLLM: pip failed')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    view.rerender(<EngineProvisionBanner status={statusWith('vllm')} />)
    view.rerender(<EngineProvisionBanner status={failed('vllm', 'Could not install vLLM: pip failed')} />)
    expect(screen.getByText('Could not install vLLM: pip failed')).toBeTruthy()
  })
})

describe('EngineProvisionBanner — Cancel', () => {
  const running = (cancellable?: boolean) =>
    ({ engineProvision: { active: true, phase: 'downloading', backend: 'vllm', pct: 0.5, error: null, cancellable } }) as unknown as Status

  it('offers Cancel only when the daemon can stop the run', () => {
    // The first-run seed and the uv/pip installs take no abort signal: the cancel endpoint answers
    // {ok:false} for them, so a Cancel button there silently did nothing.
    const view = render(<EngineProvisionBanner status={running(false)} />)
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
    view.rerender(<EngineProvisionBanner status={running(true)} />)
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy()
  })
})
