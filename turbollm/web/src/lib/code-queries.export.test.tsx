// Covers spec 16 §5's "double-click export — no duplicate downloads, no stuck loading state"
// edge case for useExportCodeSession (code-queries.ts). code-api.test.ts already covers the
// underlying downloadCodeSessionExport() fetch/Blob/filename logic in isolation; this exercises
// the REAL defense mechanism the production menu item relies on (CodeSessionScreen.tsx wires its
// "Export" item as `disabled={exportMut.isPending}`) — a tiny harness wired the exact same way,
// not a mock of the guard itself.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { useExportCodeSession } from './code-queries'

const downloadMock = vi.fn()
let resolveDownload: (() => void) | undefined

vi.mock('./code-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./code-api')>()
  return {
    ...actual,
    downloadCodeSessionExport: (...args: unknown[]) => {
      downloadMock(...args)
      return new Promise<void>((resolve) => { resolveDownload = resolve })
    },
  }
})

function ExportButtonHarness({ sessionId }: { sessionId: string }) {
  const mut = useExportCodeSession()
  return (
    <button disabled={mut.isPending} onClick={() => mut.mutate(sessionId)}>
      {mut.isPending ? 'Exporting…' : 'Export'}
    </button>
  )
}

function renderHarness() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ExportButtonHarness sessionId="sess-1" />
    </QueryClientProvider>,
  )
}

describe('useExportCodeSession — double-click guard (spec 16 §5)', () => {
  it('a rapid double-click triggers only ONE download, because the button disables itself as soon as the first click sets isPending', async () => {
    const user = userEvent.setup()
    renderHarness()
    const button = screen.getByRole('button', { name: 'Export' })

    await user.click(button)
    // React has already committed the isPending:true re-render (disabling the button) before
    // userEvent's next click is dispatched — the same ordering the real menu item relies on.
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Exporting…' }))

    expect(downloadMock).toHaveBeenCalledTimes(1)

    resolveDownload?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).not.toBeDisabled())
  })

  it('isPending never gets stuck true after the download settles', async () => {
    const user = userEvent.setup()
    renderHarness()
    await user.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeInTheDocument()

    resolveDownload?.()

    await waitFor(() => {
      const button = screen.getByRole('button')
      expect(button).toHaveTextContent('Export')
      expect(button).not.toBeDisabled()
    })
  })
})
