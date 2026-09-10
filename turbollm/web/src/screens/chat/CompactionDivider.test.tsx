import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CompactionDivider } from './CompactionDivider'

describe('CompactionDivider', () => {
  it('shows the token count and stays collapsed until clicked', () => {
    render(<CompactionDivider summary="The user asked about GPUs." tokensBefore={42100} onUndo={vi.fn()} />)
    expect(screen.getByText(/42\.1k tokens summarized/)).toBeInTheDocument()
    expect(screen.queryByText('The user asked about GPUs.')).not.toBeInTheDocument()
  })

  it('expands to show the summary text on click', () => {
    render(<CompactionDivider summary="The user asked about GPUs." tokensBefore={42100} onUndo={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /context compacted/i }))
    expect(screen.getByText('The user asked about GPUs.')).toBeInTheDocument()
  })

  it('calls onUndo when the Undo button is clicked', () => {
    const onUndo = vi.fn()
    render(<CompactionDivider summary="s" tokensBefore={100} onUndo={onUndo} />)
    fireEvent.click(screen.getByRole('button', { name: /context compacted/i }))
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('renders no Undo button when onUndo is omitted (readonly conversation)', () => {
    render(<CompactionDivider summary="s" tokensBefore={100} />)
    fireEvent.click(screen.getByRole('button', { name: /context compacted/i }))
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
  })
})
