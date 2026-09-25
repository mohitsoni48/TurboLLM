// The Laya engine (ADR-044-style pip provision) shows through this same banner while it
// installs — mirrors the 'rapid-mlx' case, which already has its own friendly label here.
import { render, screen } from '@testing-library/react'
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
