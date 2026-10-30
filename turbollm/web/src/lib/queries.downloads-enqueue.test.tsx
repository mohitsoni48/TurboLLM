// A download request for a file a row already holds queues nothing new: the daemon answers that
// row in `existing`. The enqueue mutation resumes it when it is paused, since asking for the file
// again means "go on" (Discover's Download, Import from URL, onboarding's "Download this"), and
// says which rows it resumed so the caller can tell the user.
import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDownloadMutations } from './queries'
import type { DownloadRecord, HeldDownload } from './types'

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  resume: vi.fn(),
}))

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  enqueueDownload: (input: unknown) => h.enqueue(input),
  resumeDownload: (id: string) => h.resume(id),
}))

const rec = (id: string, status: DownloadRecord['status']) =>
  ({ id, name: `${id}.gguf`, status, received: 10, total: 100 }) as DownloadRecord
/** A row in `existing` as the daemon names it: id, name and status, not the whole row. */
const held = (id: string, status: DownloadRecord['status']): HeldDownload => ({ id, name: `${id}.gguf`, status })

function hook() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return renderHook(() => useDownloadMutations(), { wrapper }).result
}

beforeEach(() => {
  h.enqueue.mockReset()
  h.resume.mockReset()
  h.resume.mockResolvedValue({ ok: true })
})

describe('useDownloadMutations().enqueue', () => {
  it('resumes a paused row the daemon answers for a file it already holds, and leaves a running one alone', async () => {
    h.enqueue.mockResolvedValue({ downloads: [], existing: [held('held', 'paused'), held('busy', 'downloading')] })
    const result = hook()
    let out: Awaited<ReturnType<typeof result.current.enqueue.mutateAsync>> | undefined
    await act(async () => { out = await result.current.enqueue.mutateAsync({ url: 'https://x/held.gguf' }) })
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.resume).toHaveBeenCalledWith('held')
    expect(out!.resumed.map((r) => [r.id, r.status])).toEqual([['held', 'queued']])
    expect(out!.existing).toEqual([held('held', 'queued'), held('busy', 'downloading')])
    expect(out!.downloads).toEqual([])
  })

  it('keeps a row it could not resume as paused, and reports it as not resumed', async () => {
    h.enqueue.mockResolvedValue({ downloads: [], existing: [held('held', 'paused')] })
    h.resume.mockRejectedValue(new Error('Another download is already writing this file.'))
    const result = hook()
    let out: Awaited<ReturnType<typeof result.current.enqueue.mutateAsync>> | undefined
    await act(async () => { out = await result.current.enqueue.mutateAsync({ url: 'https://x/held.gguf' }) })
    expect(out!.resumed).toEqual([])
    expect(out!.existing.map((r) => r.status)).toEqual(['paused'])
  })

  it('reads a daemon that sends no `existing` as none', async () => {
    h.enqueue.mockResolvedValue({ downloads: [rec('new', 'queued')] })
    const result = hook()
    let out: Awaited<ReturnType<typeof result.current.enqueue.mutateAsync>> | undefined
    await act(async () => { out = await result.current.enqueue.mutateAsync({ url: 'https://x/new.gguf' }) })
    expect(out).toEqual({ downloads: [rec('new', 'queued')], existing: [], resumed: [] })
    expect(h.resume).not.toHaveBeenCalled()
  })
})
