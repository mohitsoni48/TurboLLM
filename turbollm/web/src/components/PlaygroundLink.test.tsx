// A Laya model never takes the Workspace over (ADR-443), so the playground needs a way in that is always there
// while one is loaded — the "ready" toast is gone once dismissed. Founder-reported, 2026-09-25: "where is playground".
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaygroundLink } from './PlaygroundLink'

const state: { status: unknown } = { status: undefined }

vi.mock('../lib/queries', () => ({
  useStatus: () => ({ data: state.status }),
  useModels: () => ({ data: { models: [] } }),
}))

function renderLink(collapsed = false) {
  return render(<MemoryRouter><PlaygroundLink collapsed={collapsed} /></MemoryRouter>)
}

const LAYA = { key: 'laya-1', name: 'laya', checkpoints: ['english'], state: 'running' }

beforeEach(() => {
  state.status = undefined
})

describe('PlaygroundLink', () => {
  it('opens the playground while a Laya model is loaded, naming it', () => {
    state.status = { jev: null, laya: LAYA }
    renderLink()
    const link = screen.getByRole('link', { name: /laya · Open playground/ })
    expect(link).toHaveAttribute('href', '/workspace/jev')
  })

  it('is there while the Laya model is still loading, too', () => {
    state.status = { jev: null, laya: { ...LAYA, state: 'starting' } }
    renderLink()
    expect(screen.getByRole('link', { name: /Open playground/ })).toBeInTheDocument()
  })

  it('is an icon with a title in the collapsed rail', () => {
    state.status = { jev: null, laya: LAYA }
    renderLink(true)
    expect(screen.getByRole('link', { name: 'Open the System One playground' })).toHaveAttribute('href', '/workspace/jev')
  })

  it('is nothing when no Laya model is loaded', () => {
    state.status = { jev: null, laya: null }
    const { container } = renderLink()
    expect(container).toBeEmptyDOMElement()
  })
})
