import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { CustomBuildDialog } from './CustomBuildDialog'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  getBuildPrereqs: vi.fn().mockResolvedValue({
    supported: true,
    os: 'linux',
    tools: [
      { id: 'git', name: 'Git', found: true, installUrl: '' },
      { id: 'cmake', name: 'CMake', found: true, installUrl: '' },
    ],
    packageManager: null,
  }),
  getStatus: vi.fn().mockResolvedValue({
    engineBuild: { active: false, phase: 'preparing', engine: '', log: [], error: null },
    engineProvision: { active: false },
  }),
  getSettings: vi.fn().mockResolvedValue({ build: { toolchainDirs: [] } }),
}))

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CustomBuildDialog />
    </QueryClientProvider>,
  )
}

describe('CustomBuildDialog', () => {
  it('hands off to the build guide after Continue, in one click', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: /Add via git repo/ }))
    await user.type(screen.getByPlaceholderText('My llama.cpp fork'), 'My Fork')
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), 'https://github.com/owner/repo')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    // BuildGuideDialog is a SEPARATE Radix Dialog root from the form dialog — closing one
    // and opening the other synchronously in the same click handler lets the new dialog's
    // outside-pointerdown detection see that very click (its portal wasn't mounted when the
    // event fired) and close itself right back — a silent no-op, no error, nothing in the
    // engine log. This must still show up on its own.
    expect(await screen.findByText('Build My Fork from source')).toBeInTheDocument()
    // And the form is really gone, not stacked underneath it.
    expect(screen.queryByPlaceholderText('https://github.com/owner/repo')).not.toBeInTheDocument()
  })

  // jsdom's DismissableLayer doesn't reproduce the real browser race the fix guards against
  // (its pointerdown-outside detection never actually fires on a same-tick dialog swap here),
  // so the test above alone would pass even without the fix. This one asserts the code-level
  // contract the fix relies on directly: opening the build guide must NOT happen synchronously
  // inside the Continue click — it has to wait for a tick. If someone "simplifies" the handler
  // back to a plain `setBuildOpen(true)`, this fails even though the test above wouldn't.
  it('does not open the build guide synchronously inside the Continue click', () => {
    vi.useFakeTimers()
    try {
      renderDialog()

      fireEvent.click(screen.getByRole('button', { name: /Add via git repo/ }))
      fireEvent.change(screen.getByPlaceholderText('My llama.cpp fork'), { target: { value: 'My Fork' } })
      fireEvent.change(screen.getByPlaceholderText('https://github.com/owner/repo'), {
        target: { value: 'https://github.com/owner/repo' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

      // Not yet — still inside the same tick as the click.
      expect(screen.queryByText('Build My Fork from source')).not.toBeInTheDocument()

      act(() => {
        vi.runOnlyPendingTimers()
      })

      // Now it's up, once the deferred open has had its tick.
      expect(screen.getByText('Build My Fork from source')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
