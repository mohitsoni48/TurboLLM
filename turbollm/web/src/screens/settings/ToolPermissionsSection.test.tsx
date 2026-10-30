// Settings → Tool permissions → "Wait for an answer": how long a chat reply waits for its tool calls set to Ask,
// all of them together (the daemon's tools.chatApprovalWaitMinutes, 0-1440, default 30; 0 waits until answered).
// Saved on blur or Enter.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToolPermissionsSection } from './ToolPermissionsSection'

const save = { mutate: vi.fn(), isPending: false }
const settings: { toolPolicies: Record<string, string>; autoAllowAll: boolean; chatApprovalWaitMinutes?: number } = {
  toolPolicies: {}, autoAllowAll: false, chatApprovalWaitMinutes: 30,
}

vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save }),
}))
vi.mock('../../lib/chat-api', () => ({
  fetchAvailableTools: async () => [{ name: 'run_code', description: 'Run code' }],
}))

function renderOpen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ToolPermissionsSection /></QueryClientProvider>)
  return userEvent.click(screen.getByText('Tool permissions'))
}

const field = () => screen.getByLabelText(/Wait for an answer/) as HTMLInputElement

beforeEach(() => {
  save.mutate.mockClear()
  settings.chatApprovalWaitMinutes = 30
})

describe('ToolPermissionsSection: Wait for an answer', () => {
  it('shows the saved wait beside the tool policies and says what 0 means', async () => {
    await renderOpen()
    expect(field().value).toBe('30')
    expect(screen.getByText(/0 waits until you answer/)).toBeTruthy()
    expect(screen.getByText(/all its calls together/)).toBeTruthy()
    expect(screen.getByText(/they are not run and the reply goes on/)).toBeTruthy()
  })

  it('saves only the wait, once the field is left', async () => {
    await renderOpen()
    await userEvent.clear(field())
    await userEvent.type(field(), '45')
    expect(save.mutate).not.toHaveBeenCalled()
    await userEvent.tab()
    expect(save.mutate).toHaveBeenCalledTimes(1)
    expect(save.mutate.mock.calls[0][0]).toEqual({ chatApprovalWaitMinutes: 45 })
  })

  it('saves 0 (wait until answered) on Enter', async () => {
    await renderOpen()
    await userEvent.clear(field())
    await userEvent.type(field(), '0{Enter}')
    expect(save.mutate.mock.calls.map((c) => c[0])).toEqual([{ chatApprovalWaitMinutes: 0 }])
  })

  it('keeps a wait within 0-1440 whole minutes, and an emptied or unchanged field saves nothing', async () => {
    await renderOpen()
    await userEvent.clear(field())
    await userEvent.type(field(), '5000')
    await userEvent.tab()
    expect(field().value).toBe('1440')
    expect(save.mutate.mock.calls.map((c) => c[0])).toEqual([{ chatApprovalWaitMinutes: 1440 }])
    save.mutate.mockClear()
    await userEvent.clear(field())
    await userEvent.tab()
    expect(field().value).toBe('30')
    await userEvent.click(field())
    await userEvent.tab()
    expect(save.mutate).not.toHaveBeenCalled()
  })

  it('shows the default 30 for a daemon that does not send the setting', async () => {
    settings.chatApprovalWaitMinutes = undefined
    await renderOpen()
    expect(field().value).toBe('30')
  })
})
