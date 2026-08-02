import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RoutineStatusBadge } from './RoutineStatusBadge'

describe('RoutineStatusBadge', () => {
  it('renders the label for a display status', () => {
    render(<RoutineStatusBadge status="active" />)
    expect(screen.getByText('Active')).toBeInTheDocument()
  })
  it('updates its label when the status prop changes (spec 21 §3)', () => {
    const { rerender } = render(<RoutineStatusBadge status="active" />)
    expect(screen.getByText('Active')).toBeInTheDocument()
    rerender(<RoutineStatusBadge status="needs_approval" />)
    expect(screen.getByText('Needs approval')).toBeInTheDocument()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
  })
  it('has a label for every display status', () => {
    for (const [status, label] of [
      ['pending_confirmation', 'Awaiting confirmation'],
      ['active', 'Active'],
      ['paused', 'Paused'],
      ['needs_approval', 'Needs approval'],
      ['error', 'Error'],
    ] as const) {
      const { unmount } = render(<RoutineStatusBadge status={status} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })
  it('falls back to a labelled, coloured pill for a status the frontend union does not know', () => {
    // deriveRoutineDisplayStatus passes routine.status through unchanged, and that value comes
    // off the wire — a backend-only new status must not render an unlabelled, uncoloured pill.
    render(<RoutineStatusBadge status={'archived' as never} />)
    const pill = screen.getByText('Unknown')
    expect(pill).toBeInTheDocument()
    expect(pill.querySelector('span')?.getAttribute('style')).toContain('var(--muted)')
  })
})
