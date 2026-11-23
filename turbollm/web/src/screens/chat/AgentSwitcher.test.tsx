import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AgentSwitcher } from './AgentSwitcher'

const AGENTS = [
  { id: 'default', name: 'Default', description: 'Balanced and helpful' },
  { id: 'blank', name: 'Blank', description: 'Zero system prompt' },
  { id: 'research', name: 'Research', description: 'Multi-search deep research' },
]

describe('AgentSwitcher', () => {
  it('shows the current agent on a button and lists every agent when opened, with the current one marked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<AgentSwitcher agents={AGENTS} selectedId="blank" onSwitch={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Agent: Blank. Change agent' })
    expect(trigger.textContent).toContain('Blank')
    await user.click(trigger)
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'DefaultBalanced and helpful', 'BlankZero system prompt', 'ResearchMulti-search deep research',
    ])
  })

  it('switches to the agent picked, and does nothing when the current one is picked again', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onSwitch = vi.fn()
    render(<AgentSwitcher agents={AGENTS} selectedId="default" onSwitch={onSwitch} />)
    await user.click(screen.getByRole('button', { name: /Change agent/ }))
    await user.click(await screen.findByRole('menuitem', { name: /Default/ }))
    expect(onSwitch).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Change agent/ }))
    await user.click(await screen.findByRole('menuitem', { name: /Research/ }))
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith('research')
  })

  it('is a plain badge, not a button, while switching is unavailable, and says why', () => {
    render(<AgentSwitcher agents={AGENTS} selectedId="research" onSwitch={() => {}} disabledReason="wait for the reply to finish" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Research').closest('span[title]')!.getAttribute('title')).toBe('Multi-search deep research — wait for the reply to finish')
  })

  it('renders nothing when switching is unavailable and the chat’s agent no longer exists', () => {
    const { container } = render(<AgentSwitcher agents={AGENTS} selectedId="deleted-agent" onSwitch={() => {}} disabledReason="this chat is read-only" />)
    expect(container.textContent).toBe('')
  })

  it('lets the user pick another agent when the chat’s own was deleted in Customize', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onSwitch = vi.fn()
    render(<AgentSwitcher agents={AGENTS} selectedId="deleted-agent" onSwitch={onSwitch} />)
    const trigger = screen.getByRole('button', { name: 'Agent: Choose agent. Change agent' })
    expect(trigger.getAttribute('title')).toBe('This chat’s agent no longer exists — pick another')
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: /Blank/ }))
    expect(onSwitch).toHaveBeenCalledWith('blank')
  })
})
