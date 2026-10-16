// AuthGate is non-dismissible for a 401 (the daemon or Code wants a key for everything), but when
// only a host-only setting or "Always Allow" asked for one (auth-signal.ts's host-key signal) the
// rest of the app works without a key, so the prompt offers "Not now" instead of locking a keyless
// open-LAN browser out of chat until a reload.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AuthGate } from './AuthGate'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, track: vi.fn() }
})

describe('AuthGate', () => {
  it('offers "Not now" only when given onDismiss, and calls it', async () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<AuthGate onConnect={() => {}} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    unmount()

    render(<AuthGate onConnect={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('hands the pasted key to onConnect', async () => {
    const onConnect = vi.fn()
    render(<AuthGate onConnect={onConnect} onDismiss={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText('Paste API key'), ' tllm-mine ')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onConnect).toHaveBeenCalledWith('tllm-mine')
  })
})
