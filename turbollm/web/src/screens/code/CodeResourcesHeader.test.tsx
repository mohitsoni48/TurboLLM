import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CodeResourcesHeader } from './CodeResourcesHeader'

const NONE = { project: false, global: false }
const toggle = () => screen.getByRole('button', { name: 'Loaded resources' })

describe('CodeResourcesHeader', () => {
  it('is collapsed by default — shows the one-line summary and hides the detail rows', () => {
    render(<CodeResourcesHeader skillCount={12} hasAgentsMd={{ project: true, global: false }} />)
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument()
    expect(screen.getByText('12 skills')).toBeInTheDocument()
    // Detail rows only exist once expanded.
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
    expect(screen.queryByText(/reachable via invoke_skill/)).not.toBeInTheDocument()
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands on click to show the project / global / skills breakdown', async () => {
    const user = userEvent.setup()
    render(<CodeResourcesHeader skillCount={12} hasAgentsMd={{ project: true, global: true }} />)
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(screen.getByText('Global')).toBeInTheDocument()
    expect(screen.getByText('AGENTS.md loaded')).toBeInTheDocument()
    expect(screen.getByText('agents.md loaded')).toBeInTheDocument()
    expect(screen.getByText('12 skills reachable via invoke_skill')).toBeInTheDocument()
  })

  it('shows "No AGENTS.md" collapsed, and "not found" for BOTH files when none is loaded', async () => {
    const user = userEvent.setup()
    render(<CodeResourcesHeader skillCount={5} hasAgentsMd={NONE} />)
    expect(screen.getByText('No AGENTS.md')).toBeInTheDocument()
    expect(screen.queryByText('AGENTS.md')).not.toBeInTheDocument()
    await user.click(toggle())
    expect(screen.getAllByText('not found')).toHaveLength(2)
  })

  it('distinguishes a project-only AGENTS.md from a global-only one', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CodeResourcesHeader skillCount={0} hasAgentsMd={{ project: true, global: false }} />)
    await user.click(toggle())
    expect(screen.getByText('AGENTS.md loaded')).toBeInTheDocument() // project loaded
    expect(screen.getByText('not found')).toBeInTheDocument()        // global missing (exactly one)

    // Same mounted instance stays expanded across the prop flip.
    rerender(<CodeResourcesHeader skillCount={0} hasAgentsMd={{ project: false, global: true }} />)
    expect(screen.getByText('agents.md loaded')).toBeInTheDocument() // global loaded now
  })

  it('pluralizes the skill count and renders "none available" for zero skills', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CodeResourcesHeader skillCount={1} hasAgentsMd={NONE} />)
    expect(screen.getByText('1 skill')).toBeInTheDocument() // singular

    rerender(<CodeResourcesHeader skillCount={0} hasAgentsMd={NONE} />)
    expect(screen.getByText('0 skills')).toBeInTheDocument()
    await user.click(toggle())
    expect(screen.getByText('none available')).toBeInTheDocument()
  })
})
