// The browser's `offline` (Wi-Fi off on a laptop) says nothing about reaching the daemon, the app's
// own server on loopback: with React Query's default network mode every query and mutation paused
// until `online`, and a chat message sent meanwhile, with its streamed reply, vanished.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, onlineManager } from '@tanstack/react-query'
import { createQueryClient } from './query-client'

/** What `p` settled to within `ms`, or 'still waiting' (a paused request never settles). */
function within<T>(p: Promise<T>, ms = 300): Promise<T | 'still waiting'> {
  return Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])
}

afterEach(() => {
  onlineManager.setOnline(true)
})

describe('createQueryClient — while the browser says it is offline', () => {
  it('still fetches a query', async () => {
    onlineManager.setOnline(false)
    const qc = createQueryClient()
    const queryFn = vi.fn().mockResolvedValue({ downloads: [] })
    expect(await within(qc.fetchQuery({ queryKey: ['downloads'], queryFn }))).toEqual({ downloads: [] })
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('still runs a mutation', async () => {
    onlineManager.setOnline(false)
    const qc = createQueryClient()
    const mutationFn = vi.fn().mockResolvedValue({ ok: true })
    const send = new MutationObserver(qc, { mutationFn })
    expect(await within(send.mutate('dl-1'))).toEqual({ ok: true })
    expect(mutationFn).toHaveBeenCalledWith('dl-1', expect.anything())
  })

  it('fails a request the daemon does not answer at once, as online, rather than waiting', async () => {
    onlineManager.setOnline(false)
    const qc = createQueryClient()
    const queryFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await within(qc.fetchQuery({ queryKey: ['status'], queryFn }).catch((e: Error) => e.message))).toBe('Failed to fetch')
    expect(queryFn).toHaveBeenCalledTimes(1)
  })
})
