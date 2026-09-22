// The shared copy button records one click-stream event per copy. Which event it records has
// to be the caller's to name: `UI_ACTIONS` is a CLOSED enum, so a surface with its own
// registered action (the Jev Playground's `jev_copy_request`) would otherwise record nothing
// under that name at all — the dead-entry defect `src/telemetry/events/ui.ts` documents twice.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from './copy-button'

const h = vi.hoisted(() => ({ track: vi.fn(), writeText: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

beforeEach(() => {
  h.track.mockReset()
  h.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: h.writeText }, configurable: true })
})

describe('CopyButton', () => {
  it('copies the text and records a generic copy by default', async () => {
    render(<CopyButton text="curl http://localhost:6996" screen="developer" />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(h.writeText).toHaveBeenCalledWith('curl http://localhost:6996')
    expect(h.track).toHaveBeenCalledWith('developer', 'copy_button_click')
  })

  it('records the action the caller names instead', async () => {
    render(<CopyButton text="curl" screen="workspace" action="jev_copy_request" />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(h.track).toHaveBeenCalledWith('workspace', 'jev_copy_request')
    expect(h.track).toHaveBeenCalledTimes(1)
  })
})
