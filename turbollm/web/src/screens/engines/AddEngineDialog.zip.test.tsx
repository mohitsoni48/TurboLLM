// The .zip-upload source of the Add-engine flow: picking a file must drive the same
// scanning → confirm → add journey the folder scan uses, with zip-specific copy while the
// upload is in flight and when the archive holds nothing runnable. The API layer is
// mocked per-test (same partial-mock discipline as RemoteAccessSection.test.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AddEngineDialog } from './AddEngineDialog'
import { addEngine, ApiError, deleteEngineZipInstall, track, uploadEngineZip } from '../../lib/api'
import type { EngineScanResult } from '../../lib/types'

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  track: vi.fn(),
  uploadEngineZip: vi.fn(),
  addEngine: vi.fn(),
  deleteEngineZipInstall: vi.fn().mockResolvedValue({ ok: true }),
}))

const FOUND: EngineScanResult = {
  found: true,
  binPath: '/turbollm-data/engines/build/myfork/llama-server',
  version: 'b4242 (0deadbe)',
  capabilities: { kvTypes: ['f16'], flags: ['--host'], flagInfo: [] },
  suggestedName: 'myfork (b4242)',
}

const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  )

function pickZip(file: File): void {
  // The real picker is a hidden input driven by a ref-click; drive it directly the way
  // the browser's native file dialog would.
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  userEvent.upload(input, file)
}

describe('AddEngineDialog — .zip upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(addEngine).mockResolvedValue({ ...FOUND, id: 'e1', name: 'myfork (b4242)', warning: null } as Awaited<ReturnType<typeof addEngine>>)
  })

  it('offers the zip source next to the folder source on the choose step', async () => {
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    expect(screen.getByRole('button', { name: /Upload a \.zip/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose folder/ })).toBeTruthy()
  })

  it('uploads the picked file and lands on the confirm step, then registers via addEngine', async () => {
    vi.mocked(uploadEngineZip).mockResolvedValue(FOUND)
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([1, 2, 3])], 'myfork.zip', { type: 'application/zip' }))

    expect(await screen.findByText('Confirm engine')).toBeTruthy()
    // Scope to the dialog: the default trigger button outside it is also named "Add engine".
    const dialog = screen.getByRole('dialog')
    expect((within(dialog).getByDisplayValue('myfork (b4242)') as HTMLInputElement).value).toBe('myfork (b4242)')
    expect(within(dialog).getByText('/turbollm-data/engines/build/myfork/llama-server')).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add engine' }))
    // TanStack passes a mutation-context second arg the real addEngine ignores; assert the
    // input payload itself.
    await waitFor(() => expect(vi.mocked(addEngine).mock.calls[0]?.[0]).toEqual({
      name: 'myfork (b4242)',
      binPath: '/turbollm-data/engines/build/myfork/llama-server',
    }))
    expect(vi.mocked(track)).toHaveBeenCalledWith('engines', 'upload_new_engine_zip')
  })

  it('shows zip-specific in-progress copy while the upload runs', async () => {
    let release!: (v: EngineScanResult) => void
    vi.mocked(uploadEngineZip).mockReturnValue(new Promise((res) => { release = res }))
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([1])], 'bigfork.zip', { type: 'application/zip' }))

    expect(await screen.findByText(/Uploading & extracting bigfork\.zip/)).toBeTruthy()
    release(FOUND)
    await screen.findByText('Confirm engine')
  })

  it('surfaces a rejected upload as an inline error back on the choose step', async () => {
    vi.mocked(uploadEngineZip).mockRejectedValueOnce(new ApiError('bad_zip', 'This file is not a zip archive.', 400))
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([9])], 'notazip.zip'))

    expect(await screen.findByText('This file is not a zip archive.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Upload a \.zip/ })).toBeTruthy()
  })

  it('explains a zip with no llama-server for this platform, without the binary-picker fallback', async () => {
    vi.mocked(uploadEngineZip).mockResolvedValueOnce({ found: false })
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([2])], 'emptyfork.zip'))

    expect(await screen.findByText('No engine found')).toBeTruthy()
    // The message interleaves <code>/<span> nodes, so assert on its single-node chunks.
    expect(screen.getByText('emptyfork.zip')).toBeTruthy()
    expect(screen.getByText(/Make sure the zip contains a build for the OS TurboLLM is running on/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pick the binary directly/ })).toBeNull()
  })

  it('a same-named re-upload shows the update summary and never registers a second engine', async () => {
    vi.mocked(uploadEngineZip).mockResolvedValueOnce({ ...FOUND, version: 'b5000', updated: { id: 'e1', name: 'myfork (b4242)' } })
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([4])], 'myfork.zip', { type: 'application/zip' }))

    expect(await screen.findByText('Engine updated')).toBeTruthy()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/now run the new binary/)).toBeTruthy()
    expect(within(dialog).getByText('b5000')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /Add engine/ })).toBeNull()
    expect(within(dialog).queryByDisplayValue('myfork (b4242)')).toBeNull()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(vi.mocked(addEngine)).not.toHaveBeenCalled()
    expect(vi.mocked(track)).toHaveBeenCalledWith('engines', 'done_zip_engine_update')
    // The engine is already registered server-side — dismissing must NOT clean up its files.
    expect(vi.mocked(deleteEngineZipInstall)).not.toHaveBeenCalled()
  })

  it('shows a CUDA-without-cudart warning on the confirm step without blocking Add', async () => {
    vi.mocked(uploadEngineZip).mockResolvedValueOnce({
      ...FOUND,
      warning: { code: 'missing_cudart', message: 'This CUDA build does not bundle the CUDA runtime (cudart64_*.dll).' },
    })
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([5])], 'cuda.zip', { type: 'application/zip' }))

    expect(await screen.findByText(/does not bundle the CUDA runtime/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add engine/ })).toBeTruthy()
  })

  it('cleans up an unconfirmed upload when the dialog is dismissed', async () => {
    vi.mocked(uploadEngineZip).mockResolvedValueOnce(FOUND)
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([6])], 'myfork.zip', { type: 'application/zip' }))
    await screen.findByText('Confirm engine')

    // Dismiss via the dialog's own close affordance (confirm has no Cancel button).
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(vi.mocked(deleteEngineZipInstall)).toHaveBeenCalledWith(FOUND.binPath))
    expect(vi.mocked(addEngine)).not.toHaveBeenCalled()
    // Dismissing resets the dialog — reopening starts over at the choose step.
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    expect(screen.getByRole('button', { name: /Upload a \.zip/ })).toBeTruthy()
  })

  it('drops a late upload result that arrives after the dialog was dismissed', async () => {
    let release!: (v: EngineScanResult) => void
    vi.mocked(uploadEngineZip).mockReturnValue(new Promise((res) => { release = res }))
    wrap(<AddEngineDialog />)
    await userEvent.click(await screen.findByRole('button', { name: /Add engine/ }))
    pickZip(new File([new Uint8Array([7])], 'bigfork.zip', { type: 'application/zip' }))
    await screen.findByText(/Uploading & extracting bigfork\.zip/)

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    release(FOUND)
    await new Promise((r) => setTimeout(r, 0))
    // The stale result must not drag the reset dialog back to the confirm step.
    expect(screen.queryByText('Confirm engine')).toBeNull()
    expect(vi.mocked(deleteEngineZipInstall)).not.toHaveBeenCalled()
    // Reopening starts fresh at the choose step, not on the stale upload's result.
    await userEvent.click(screen.getByRole('button', { name: /Add engine/ }))
    expect(screen.getByRole('button', { name: /Upload a \.zip/ })).toBeTruthy()
  })
})
